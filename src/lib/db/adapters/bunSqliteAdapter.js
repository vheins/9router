// Bun runtime adapter — uses built-in bun:sqlite (native, fastest under Bun).
// Loaded only when process.versions.bun is present.
import { PRAGMA_SQL } from "../schema.js";

const CHECKPOINT_INTERVAL_MS = 60 * 1000;

export async function createBunSqliteAdapter(filePath, { readonly = false } = {}) {
  // Dynamic import — only resolves under Bun runtime
  const { Database } = await import("bun:sqlite");
  const db = readonly
    ? new Database(filePath, { readonly: true })
    : new Database(filePath, { create: true });
  // Read-only opens (migration source) must never mutate the file: skip the
  // mutating PRAGMA_SQL (journal_mode=WAL etc.) entirely.
  if (!readonly) db.exec(PRAGMA_SQL);

  const stmtCache = new Map();
  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  // Read-only opens skip the WAL checkpoint timer (no WAL, must not touch file).
  const checkpointTimer = readonly
    ? null
    : setInterval(() => {
        try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
      }, CHECKPOINT_INTERVAL_MS);
  if (checkpointTimer && typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    if (!readonly) { try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} }
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }
  // Read-only opens must not hijack process shutdown.
  if (!readonly) {
    const onShutdown = () => gracefulClose();
    process.once("beforeExit", onShutdown);
    process.once("SIGINT", () => { onShutdown(); process.exit(0); });
    process.once("SIGTERM", () => { onShutdown(); process.exit(0); });
  }

  return {
    driver: "bun:sqlite",
    async run(sql, params = []) {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    async get(sql, params = []) {
      return prepare(sql).get(...params);
    },
    async all(sql, params = []) {
      return prepare(sql).all(...params);
    },
    async exec(sql) { return db.exec(sql); },
    async transaction(fn) {
      // Manual SAVEPOINT so an async callback can be awaited.
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
    async checkpoint() { try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} },
    async close() {
      clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}
