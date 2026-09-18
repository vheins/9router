// Write-behind persistence for the in-memory routing-state store.
//
// Redis-style: the routing hot path stays purely in-memory (see
// open-sse/services/routingStateStore.js). This module periodically snapshots
// the whole store into a single KV row ("routingState" / "state") and rehydrates
// it on boot — NOT once per request.
//
// Fail-open everywhere: a DB/JSON error here must NEVER break request routing.
// Every export swallows its own errors and returns a safe value.

import { makeKv } from "@/lib/db/helpers/kvStore.js";
import { routingStateStore } from "open-sse/services/routingStateStore.js";

const kv = makeKv("routingState");

// Snapshot cadence (ms). Write-behind, not per-request.
const FLUSH_INTERVAL_MS = 5000;

// The interval + process listeners are held on the global singleton so a
// hot-reloaded module instance can still stop/clean up what a previous instance
// started (module-level state is reset on reload, the global is not).
const g = (global.__routingStatePersistence ??= {
  started: false,
  interval: null,
  signalsRegistered: false,
  listeners: null,
  beforeExitHandled: false,
});

let started = false;
let intervalHandle = null;

/**
 * Initialize write-behind persistence: rehydrate from the DB, start the periodic
 * flush, and register a best-effort shutdown flush.
 *
 * Idempotent — safe under Next.js hot reload / double-start (guards on both a
 * module flag and a global singleton). Does NOT call process.exit(); signal
 * handling is owned by initializeApp.js — we only attach a flush listener.
 *
 * @returns {Promise<boolean>} true when persistence is running
 */
export async function initRoutingStatePersistence() {
  if (started || g.started) return true;
  started = true;
  g.started = true;

  // 1. Rehydrate the in-memory store from the last snapshot (fail-open). This
  // MERGES — any state produced by live requests during the deferred startup
  // window is preserved.
  try {
    const snap = await kv.get("state");
    if (snap) routingStateStore.restore(snap);
  } catch (e) {
    console.warn("[RoutingState] restore failed:", e?.message ?? e);
  }

  // 2. Periodic write-behind flush.
  const handle = setInterval(() => {
    flushRoutingState().catch(() => {});
  }, FLUSH_INTERVAL_MS);
  if (handle.unref) handle.unref();
  intervalHandle = handle;
  g.interval = handle;

  // 3. Best-effort flush on shutdown — no process.exit() (initializeApp owns that).
  registerShutdownFlush();

  return true;
}

// Register shutdown listeners ONCE per process. Stored on the global so a
// reloaded module can detach them in stop(). `beforeExit` can be re-emitted by
// Node whenever the event loop drains again, so its handler is guarded to run
// at most once (it must not schedule async work on every emission).
function registerShutdownFlush() {
  if (g.signalsRegistered) return;
  g.signalsRegistered = true;

  const onSignal = () => { flushRoutingState(true).catch(() => {}); };
  const onBeforeExit = () => {
    if (g.beforeExitHandled) return;
    g.beforeExitHandled = true;
    flushRoutingState(true).catch(() => {});
  };
  g.listeners = { onSignal, onBeforeExit };

  try {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("beforeExit", onBeforeExit);
  } catch { /* best effort */ }
}

/**
 * Snapshot the store to the DB when dirty (or when forced).
 *
 * The mutation version is captured BEFORE the awaited write and passed to
 * clearDirty, so any mutation that lands while `kv.set` is in flight keeps the
 * store dirty for the next flush (write-behind never drops a concurrent change).
 * @param {boolean} [force=false]
 * @returns {Promise<boolean>} true when a write happened, false otherwise
 */
export async function flushRoutingState(force = false) {
  try {
    if (!force && !routingStateStore.isDirty()) return false;
    routingStateStore.pruneStats();
    const flushedVersion = routingStateStore.getVersion();
    await kv.set("state", routingStateStore.snapshot());
    routingStateStore.clearDirty(flushedVersion);
    return true;
  } catch (e) {
    console.warn("[RoutingState] flush failed:", e?.message ?? e);
    return false;
  }
}

/** Stop the periodic flush and detach shutdown listeners. Test/teardown helper. */
export function stopRoutingStatePersistence() {
  // Clear the interval held on the global — a reloaded module has no local
  // handle for the interval a previous instance started.
  if (g.interval) {
    clearInterval(g.interval);
    g.interval = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  // Detach process listeners so tests (and repeated init/stop cycles) don't leak.
  if (g.listeners) {
    try {
      process.removeListener("SIGINT", g.listeners.onSignal);
      process.removeListener("SIGTERM", g.listeners.onSignal);
      process.removeListener("beforeExit", g.listeners.onBeforeExit);
    } catch { /* best effort */ }
    g.listeners = null;
    g.signalsRegistered = false;
    g.beforeExitHandled = false;
  }

  started = false;
  g.started = false;
}
