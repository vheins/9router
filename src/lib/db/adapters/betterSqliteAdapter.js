import Database from "better-sqlite3";
import { PRAGMA_SQL } from "../schema.js";

// Periodic checkpoint to keep WAL file small (avoid huge -wal/-shm growth)
const CHECKPOINT_INTERVAL_MS = 60 * 1000;

export function createBetterSqliteAdapter(filePath, { readonly = false } = {}) {
  const db = readonly
    ? new Database(filePath, { readonly: true, fileMustExist: true })
    : new Database(filePath);
  // Read-only opens (migration source) must never mutate the file: skip the
  // mutating PRAGMA_SQL (journal_mode=WAL etc.) entirely.
  if (!readonly) db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  const stmtCache = new Map();

  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  // Truncate WAL periodically so file stays small for backup/copy.
  // Read-only opens skip this (no WAL, and must not touch the file).
  const checkpointTimer = readonly
    ? null
    : setInterval(() => {
        try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
      }, CHECKPOINT_INTERVAL_MS);
  if (checkpointTimer && typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    if (!readonly) { try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {} }
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }

  // Ensure WAL is flushed and -wal/-shm files removed on shutdown.
  // Read-only opens must not hijack process shutdown.
  if (!readonly) {
    const onShutdown = () => gracefulClose();
    process.once("beforeExit", onShutdown);
    process.once("SIGINT", () => { onShutdown(); process.exit(0); });
    process.once("SIGTERM", () => { onShutdown(); process.exit(0); });
  }

  return {
    driver: "better-sqlite3",
    // All methods are async so the adapter interface is uniform with MariaDB.
    // better-sqlite3 itself is synchronous; the async wrapper just returns
    // already-resolved promises.
    async run(sql, params = []) {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    async get(sql, params = []) { return prepare(sql).get(...params); },
    async all(sql, params = []) { return prepare(sql).all(...params); },
    async exec(sql) { return db.exec(sql); },
    // Manual BEGIN/COMMIT so an async callback can be awaited (better-sqlite3's
    // own db.transaction() rejects async functions).
    async transaction(fn) {
      const sp = `sp_${Math.random().toString(36).slice(2)}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        const r = await fn();
        db.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
        throw e;
      }
    },
    async checkpoint() { try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {} },
    async close() {
      clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}
