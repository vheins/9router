import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDirs, DATA_FILE } from "./paths.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

// ─── DB mode ──────────────────────────────────────────────────────────────
// DB_MODE=sqlite (default) keeps the existing SQLite chain.
// DB_MODE=mariadb|mysql uses the MariaDB adapter.
export function getDbMode() {
  const raw = String(process.env.DB_MODE || "sqlite").trim().toLowerCase();
  if (raw === "mariadb" || raw === "mysql") return "mariadb";
  return "sqlite";
}

async function tryBunSqlite(filePath, opts) {
  // Bun runtime only — built-in, no install needed
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(filePath, opts);
  } catch (e) {
    console.warn(`[DB] bun:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function tryBetterSqlite(filePath, opts) {
  // Skip on Bun — better-sqlite3 native bindings unsupported
  if (process.versions.bun) return null;
  // Skip on Node >= 24: the native addon SIGSEGVs on load there, which is a
  // process-level crash the try/catch below cannot recover from. node:sqlite covers it.
  const [nodeMajor] = process.versions.node.split(".").map(Number);
  if (nodeMajor >= 24) return null;
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return await createBetterSqliteAdapter(filePath, opts);
  } catch (e) {
    console.warn(`[DB] better-sqlite3 unavailable: ${e.message}`);
    return null;
  }
}

async function tryNodeSqlite(filePath, opts) {
  // Built-in since Node 22.5.0 — no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(filePath, opts);
  } catch (e) {
    console.warn(`[DB] node:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function trySqlJs(filePath, opts) {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(filePath, opts);
  } catch (e) {
    console.warn(`[DB] sql.js unavailable: ${e.message}`);
    return null;
  }
}

// Shared fallback chain. opts (e.g. { readonly: true }) is forwarded to each
// adapter factory; undefined preserves the default read-write behavior.
async function openSqliteAdapterWith(filePath, opts) {
  let adapter = await tryBunSqlite(filePath, opts);
  if (!adapter) adapter = await tryBetterSqlite(filePath, opts);
  if (!adapter) adapter = await tryNodeSqlite(filePath, opts);
  if (!adapter) adapter = await trySqlJs(filePath, opts);
  if (!adapter) throw new Error("[DB] No SQLite driver available (bun/better/node/sql.js all failed)");
  return adapter;
}

// Open a SQLite adapter for a given file using the runtime fallback chain.
export async function openSqliteAdapter(filePath) {
  return openSqliteAdapterWith(filePath);
}

// Open a SQLite file strictly READ-ONLY — used by migrate.js to read the source
// SQLite during a one-time SQLite → MariaDB copy.
//
// Why a snapshot instead of a plain read-only open: the migration source is a
// normal runtime DB, so its header is persisted as journal_mode=WAL. SQLite
// creates -wal/-shm side files to read ANY WAL-mode database, even when opened
// with a read-only flag (verified across node:sqlite, better-sqlite3 and
// bun:sqlite) — and a read-only open would also ignore committed rows still
// sitting in an uncheckpointed -wal. To guarantee the SOURCE file is never
// touched (no header mutation, no -wal/-shm side files) while still reading all
// committed data, we copy the DB (main file + any -wal) into a private temp dir
// and open the SNAPSHOT read-only. The temp dir is removed on adapter.close().
export async function openSqliteAdapterReadOnly(filePath) {
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ro-"));
  const snapshotFile = path.join(snapshotDir, path.basename(filePath));
  try {
    fs.copyFileSync(filePath, snapshotFile);
    // Copy only the WAL (committed frames not yet checkpointed). The -shm is a
    // transient shared-memory index and is rebuilt by SQLite for the snapshot.
    if (fs.existsSync(filePath + "-wal")) fs.copyFileSync(filePath + "-wal", snapshotFile + "-wal");

    const adapter = await openSqliteAdapterWith(snapshotFile, { readonly: true });
    const baseClose = adapter.close.bind(adapter);
    adapter.close = async () => {
      try { await baseClose(); }
      finally { try { fs.rmSync(snapshotDir, { recursive: true, force: true }); } catch {} }
    };
    return adapter;
  } catch (e) {
    try { fs.rmSync(snapshotDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

function mariaConfigFromEnv() {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "9router",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "9router",
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  };
}

async function createMariaAdapter() {
  const cfg = mariaConfigFromEnv();
  const { createMariaDbAdapter } = await import("./adapters/mariadbAdapter.js");
  const adapter = await createMariaDbAdapter(cfg);
  if (!state.logged) {
    console.log(`[DB] Driver: mariadb | host: ${cfg.host}:${cfg.port} | db: ${cfg.database}`);
    state.logged = true;
  }
  return adapter;
}

async function initAdapter() {
  ensureDirs();

  let adapter;
  if (getDbMode() === "mariadb") {
    adapter = await createMariaAdapter();
  } else {
    // Order per runtime:
    //   Bun:  bun:sqlite → sql.js
    //   Node: better-sqlite3 → node:sqlite (≥22.5) → sql.js
    adapter = await openSqliteAdapter(DATA_FILE);
    if (!state.logged) {
      console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
      state.logged = true;
    }
  }

  const { runMigrationOnce } = await import("./migrate.js");
  await runMigrationOnce(adapter);
  return adapter;
}

export async function getAdapter() {
  if (state.instance) return state.instance;
  if (!state.initPromise) state.initPromise = initAdapter().then((a) => { state.instance = a; return a; });
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
