// Shared, PURE in-memory routing-state store.
//
// This module holds the mutable routing state that used to live in several
// module-level Maps scattered across the codebase:
//   • round-robin rotation state (was in routingStrategies.js)
//   • last-known-good model per combo (was in combo.js)
//   • last provider head per provider (was in auth.js)
//   • live outcome stats (usageCount / latency / success rate) — NEW
//
// It is DELIBERATELY pure JS: ZERO DB / filesystem imports and no globals beyond
// plain Maps, so it stays browser-safe. The dashboard imports routingStrategies.js
// (which imports this file) for strategy metadata, and pulling server code into
// that graph would break the client bundle.
//
// Persistence is a SEPARATE concern: src/shared/services/routingStatePersistence.js
// snapshots this store to the DB periodically (Redis-style write-behind) and
// rehydrates it on boot. The hot path here is purely synchronous in-memory.

// ── state maps ───────────────────────────────────────────────────────────

// key -> { index, consecutiveUseCount, lastUsedAt }  (rotation keys are combo /
// provider namespaces — timestamps live ON the entry so pruning never has to
// consult the stats map, whose keys are model / connection namespaces).
const rotation = new Map();
// key -> model string (last-known-good)
const lastGood = new Map();
// key -> previous head id (random-strategy dedup)
const lastHead = new Map();
// key -> { usageCount, successCount, errorCount, latencyEwmaMs, lastSuccessAt, lastErrorAt, lastUsedAt }
const stats = new Map();

// Parallel timestamp metadata for lastGood/lastHead (their values are plain
// strings, so the timestamp cannot live on the value without changing the shape).
// Keyed in the SAME namespace as their map — never mixed with stats keys.
const lastGoodMeta = new Map(); // key -> ISO timestamp
const lastHeadMeta = new Map(); // key -> ISO timestamp

// Set true whenever any mutation happens; cleared (through a specific version)
// after a successful snapshot.
let dirty = false;
// Monotonic mutation counter. Every mutation bumps it; a flush captures the
// version it wrote and only clears dirty if no mutation happened meanwhile.
let version = 0;

function nowIso() {
  return new Date().toISOString();
}

function markDirty() {
  dirty = true;
  version += 1;
}

// EWMA smoothing factor: newer samples get 30% weight.
const EWMA_ALPHA = 0.3;

// ── round-robin rotation ─────────────────────────────────────────────────

/**
 * Read the current rotation state for a key.
 * @param {string} key
 * @returns {{index:number, consecutiveUseCount:number, lastUsedAt:string}|null}
 */
function getRotation(key) {
  return rotation.get(key) || null;
}

/**
 * Store rotation state for a key.
 * @param {string} key
 * @param {{index:number, consecutiveUseCount:number, lastUsedAt?:string}} state
 */
function setRotation(key, { index, consecutiveUseCount, lastUsedAt } = {}) {
  rotation.set(key, {
    index: index || 0,
    consecutiveUseCount: consecutiveUseCount || 0,
    lastUsedAt: lastUsedAt || nowIso(),
  });
  markDirty();
}

/**
 * Resolve the round-robin start index for `key`, advancing the sticky counter.
 * Semantics are identical to the previous engine implementation.
 * @param {string} key
 * @param {number} count - number of targets
 * @param {number|string} stickyLimit - calls per target before advancing
 * @returns {number} index to pass as ctx.rotationIndex
 */
function nextRotation(key, count, stickyLimit) {
  const n = Math.max(1, Number(count) || 1);
  const limit = Math.max(1, Number.parseInt(stickyLimit, 10) || 1);
  const state = rotation.get(key) || { index: 0, consecutiveUseCount: 0 };
  const currentIndex = ((state.index % n) + n) % n;
  const nextUseCount = (state.consecutiveUseCount || 0) + 1;
  if (nextUseCount >= limit) {
    rotation.set(key, { index: (currentIndex + 1) % n, consecutiveUseCount: 0, lastUsedAt: nowIso() });
  } else {
    rotation.set(key, { index: currentIndex, consecutiveUseCount: nextUseCount, lastUsedAt: nowIso() });
  }
  markDirty();
  return currentIndex;
}

/** Clear round-robin state for one key, or all when omitted. */
function resetRotation(key) {
  if (key) rotation.delete(key);
  else rotation.clear();
  markDirty();
}

// ── last-known-good (lkgp) ───────────────────────────────────────────────

function getLastGood(key) {
  return lastGood.get(key) || null;
}

function setLastGood(key, modelStr) {
  lastGood.set(key, modelStr);
  lastGoodMeta.set(key, nowIso());
  markDirty();
}

/** Clear last-known-good for one key, or all when omitted. */
function clearLastGood(key) {
  if (key) {
    lastGood.delete(key);
    lastGoodMeta.delete(key);
  } else {
    lastGood.clear();
    lastGoodMeta.clear();
  }
  markDirty();
}

// ── last provider head (random dedup) ────────────────────────────────────

function getLastHead(key) {
  return lastHead.get(key) || null;
}

function setLastHead(key, keyStr) {
  lastHead.set(key, keyStr);
  lastHeadMeta.set(key, nowIso());
  markDirty();
}

// ── live outcome stats ───────────────────────────────────────────────────

/**
 * Record a single request outcome for `key`, updating the running stats and
 * marking the store dirty. Fail-open: accepts anything, never throws.
 *
 * `latencyEwmaMs` is ABSENT (undefined) until a finite, positive sample arrives
 * — never null / 0 — so the auto strategy's neutral fallback is used instead of
 * misreading "no data" as a 0ms (fastest) target.
 * @param {string} key
 * @param {{ok:boolean, latencyMs?:number}} outcome
 */
function recordOutcome(key, { ok, latencyMs } = {}) {
  if (!key) return;
  const prev = stats.get(key) || {
    usageCount: 0,
    successCount: 0,
    errorCount: 0,
    latencyEwmaMs: undefined,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastUsedAt: null,
  };
  const now = nowIso();
  prev.usageCount += 1;
  prev.lastUsedAt = now;
  if (ok) {
    prev.successCount += 1;
    prev.lastSuccessAt = now;
  } else {
    prev.errorCount += 1;
    prev.lastErrorAt = now;
  }
  const lat = Number(latencyMs);
  if (Number.isFinite(lat) && lat > 0) {
    prev.latencyEwmaMs = prev.latencyEwmaMs == null
      ? lat
      : prev.latencyEwmaMs * (1 - EWMA_ALPHA) + lat * EWMA_ALPHA;
  }
  stats.set(key, prev);
  markDirty();
}

function getStats(key) {
  return stats.get(key) || null;
}

// ── snapshot / restore ───────────────────────────────────────────────────

/** Serialize the whole store into a plain JSON-safe object. */
function snapshot() {
  return {
    rotation: Object.fromEntries(rotation),
    lastGood: Object.fromEntries(lastGood),
    lastHead: Object.fromEntries(lastHead),
    stats: Object.fromEntries(stats),
    lastGoodAt: Object.fromEntries(lastGoodMeta),
    lastHeadAt: Object.fromEntries(lastHeadMeta),
    version,
    savedAt: nowIso(),
  };
}

/**
 * MERGE a persisted snapshot into the current in-memory state.
 *
 * Does NOT clear any map and only fills MISSING entries, so state created by
 * live requests before deferred hydration (boot) is never overwritten. Also
 * backfills timestamp metadata so freshly-restored entries are not immediately
 * pruned. Tolerates null / missing sub-objects.
 */
function restore(snap) {
  if (!snap || typeof snap !== "object") return;
  const savedAt = snap.savedAt || nowIso();
  const fillMissing = (map, obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || map.has(k)) continue;
      // Clone plain objects so later in-place mutations (e.g. recordOutcome) never
      // alias the caller's snapshot object.
      map.set(k, v && typeof v === "object" ? { ...v } : v);
    }
  };
  fillMissing(rotation, snap.rotation);
  fillMissing(lastGood, snap.lastGood);
  fillMissing(lastHead, snap.lastHead);
  fillMissing(stats, snap.stats);
  fillMissing(lastGoodMeta, snap.lastGoodAt);
  fillMissing(lastHeadMeta, snap.lastHeadAt);

  // Normalize rotation entries that predate lastUsedAt tracking so pruning does
  // not immediately drop freshly-restored rotation state.
  for (const entry of rotation.values()) {
    if (entry && typeof entry === "object" && !entry.lastUsedAt) entry.lastUsedAt = savedAt;
  }
  // Backfill timestamps for lastGood/lastHead restored without meta.
  for (const key of lastGood.keys()) if (!lastGoodMeta.has(key)) lastGoodMeta.set(key, savedAt);
  for (const key of lastHead.keys()) if (!lastHeadMeta.has(key)) lastHeadMeta.set(key, savedAt);
}

// ── dirty / version tracking ─────────────────────────────────────────────

function isDirty() {
  return dirty;
}

/** Current monotonic mutation version. */
function getVersion() {
  return version;
}

/**
 * Clear the dirty flag. When a version is supplied, only clear if the store has
 * not mutated since that version — so mutations that happen DURING an awaited
 * `kv.set` stay dirty for the next flush.
 * @param {number} [flushedVersion]
 */
function clearDirty(flushedVersion) {
  if (flushedVersion === undefined || flushedVersion === version) dirty = false;
}

// ── pruning ──────────────────────────────────────────────────────────────

/**
 * Drop stale entries by AGE, using each map's OWN timestamp — never cross-map
 * membership (rotation keys are combo/provider namespaces; stats keys are
 * model/connection namespaces and must not be conflated).
 * @param {{maxAgeMs?:number, maxEntries?:number}} [opts]
 * @returns {number} number of entries removed
 */
function pruneStats({ maxAgeMs = 7 * 24 * 3600 * 1000, maxEntries = 5000 } = {}) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  // 1. Drop stats whose lastUsedAt is older than maxAgeMs (or unparseable).
  for (const [key, st] of stats) {
    const t = st?.lastUsedAt ? new Date(st.lastUsedAt).getTime() : NaN;
    if (!Number.isFinite(t) || t < cutoff) {
      stats.delete(key);
      removed++;
    }
  }

  // 2. If still too many, keep only the most-recently-used maxEntries.
  if (stats.size > maxEntries) {
    const ordered = [...stats.entries()].sort((a, b) => {
      const ta = new Date(a[1]?.lastUsedAt || 0).getTime() || 0;
      const tb = new Date(b[1]?.lastUsedAt || 0).getTime() || 0;
      return tb - ta; // most recent first
    });
    const keep = new Set(ordered.slice(0, maxEntries).map(([k]) => k));
    for (const key of stats.keys()) {
      if (!keep.has(key)) {
        stats.delete(key);
        removed++;
      }
    }
  }

  // 3. Drop stale rotation by its OWN lastUsedAt (never by stats membership).
  // The "__default__" sentinel is always kept (used when no key is supplied).
  for (const [key, entry] of rotation) {
    if (key === "__default__") continue;
    const t = entry?.lastUsedAt ? new Date(entry.lastUsedAt).getTime() : NaN;
    if (!Number.isFinite(t) || t < cutoff) {
      rotation.delete(key);
      removed++;
    }
  }

  // 4. Drop stale lastGood / lastHead by their own timestamp metadata.
  for (const key of lastGood.keys()) {
    const raw = lastGoodMeta.get(key);
    const t = raw ? new Date(raw).getTime() : NaN;
    if (!Number.isFinite(t) || t < cutoff) {
      lastGood.delete(key);
      lastGoodMeta.delete(key);
      removed++;
    }
  }
  for (const key of lastHead.keys()) {
    const raw = lastHeadMeta.get(key);
    const t = raw ? new Date(raw).getTime() : NaN;
    if (!Number.isFinite(t) || t < cutoff) {
      lastHead.delete(key);
      lastHeadMeta.delete(key);
      removed++;
    }
  }

  if (removed > 0) markDirty();
  return removed;
}

// ── test helper ──────────────────────────────────────────────────────────

/** Clear all maps + dirty/version. Test-only. */
function _resetAll() {
  rotation.clear();
  lastGood.clear();
  lastHead.clear();
  stats.clear();
  lastGoodMeta.clear();
  lastHeadMeta.clear();
  dirty = false;
  version = 0;
}

export const routingStateStore = {
  getRotation,
  setRotation,
  nextRotation,
  resetRotation,
  getLastGood,
  setLastGood,
  clearLastGood,
  getLastHead,
  setLastHead,
  recordOutcome,
  getStats,
  snapshot,
  restore,
  isDirty,
  getVersion,
  clearDirty,
  pruneStats,
  _resetAll,
};

export default routingStateStore;
