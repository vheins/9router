// MariaDB adapter — official `mariadb` (Node.js connector) with the promise API.
//
// Exposes the SAME async interface as the SQLite adapters (run/get/all/exec/
// transaction/checkpoint/close) so repo code can `await db.*` uniformly.
// All SQLite-isms are rewritten on the way in via ../dialect.js.
import { AsyncLocalStorage } from "node:async_hooks";
import mariadb from "mariadb";
import { translate } from "../dialect.js";

// Holds the connection bound to the active transaction so nested run/get/all
// calls execute on the SAME connection (transaction isolation). Uses
// AsyncLocalStorage so concurrent transactions never cross connections.
const txStorage = new AsyncLocalStorage();

function normalizeParams(params) {
  if (params == null) return [];
  const arr = Array.isArray(params) ? params : [params];
  return arr.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p;
  });
}

// Split a multi-statement SQL string on ";" while respecting single-quoted
// strings and backtick identifiers. Keeps exec() usable for DDL batches.
function splitStatements(sql) {
  const out = [];
  let buf = "";
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      buf += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) { buf += sql[i + 1]; i++; }
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; buf += ch; continue; }
    if (ch === ";") {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

function toNumber(v) {
  if (v == null) return 0;
  if (typeof v === "bigint") return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function createMariaDbAdapter(config = {}) {
  const pool = mariadb.createPool({
    host: config.host || "127.0.0.1",
    port: Number(config.port || 3306),
    user: config.user || "9router",
    password: config.password || "",
    database: config.database || "9router",
    connectionLimit: Number(config.connectionLimit || 10),
    // Return DATE/DATETIME/TIMESTAMP as strings (we store TEXT ISO strings anyway).
    dateStrings: true,
    // Keep DECIMAL as strings so cost values don't lose precision.
    decimalAsNumber: false,
    // Avoid driver-side BigInt surprises; we normalize ids ourselves.
    insertIdAsNumber: true,
    bigIntAsNumber: true,
    charset: "utf8mb4",
    acquireTimeout: 20000,
    idleTimeout: 60000,
  });

  // Fail fast with a clear error if the server is unreachable.
  const probe = await pool.getConnection();
  try {
    await probe.ping();
  } finally {
    probe.release();
  }

  const conn = () => txStorage.getStore() || pool;

  async function run(sql, params = []) {
    const q = translate(sql);
    if (!q) return { changes: 0, lastInsertRowid: 0 };
    const res = await conn().query(q, normalizeParams(params));
    // Single non-SELECT statement → OkPacket object with affectedRows/insertId.
    const ok = Array.isArray(res) ? res[res.length - 1] : res;
    return {
      changes: toNumber(ok?.affectedRows ?? 0),
      lastInsertRowid: toNumber(ok?.insertId ?? 0),
    };
  }

  async function get(sql, params = []) {
    const q = translate(sql);
    if (!q) return undefined;
    const res = await conn().query(q, normalizeParams(params));
    // Single SELECT → array of rows.
    const rows = Array.isArray(res) ? res : [];
    return rows[0];
  }

  async function all(sql, params = []) {
    const q = translate(sql);
    if (!q) return [];
    const res = await conn().query(q, normalizeParams(params));
    return Array.isArray(res) ? res : [];
  }

  async function exec(sql) {
    const q = translate(sql);
    if (!q) return;
    const target = conn();
    for (const stmt of splitStatements(q)) {
      await target.query(stmt);
    }
  }

  // Manual BEGIN/COMMIT/ROLLBACK so async callbacks work. The dedicated
  // connection is stored in AsyncLocalStorage → nested calls share it.
  async function transaction(fn) {
    if (txStorage.getStore()) {
      // Already inside a transaction → run inline (no nested BEGIN).
      return fn();
    }
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const result = await txStorage.run(c, () => fn());
      await c.commit();
      return result;
    } catch (e) {
      try { await c.rollback(); } catch {}
      throw e;
    } finally {
      c.release();
    }
  }

  async function checkpoint() {
    // MySQL/MariaDB has no WAL to checkpoint — no-op.
  }

  async function close() {
    await pool.end();
  }

  return { driver: "mariadb", run, get, all, exec, transaction, checkpoint, close, raw: pool };
}
