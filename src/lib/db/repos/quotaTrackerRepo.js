// FORK-ONLY: persisted per-connection quota snapshots.
//
// The quota auto-toggle / auto-ping schedulers and the /api/usage route write
// snapshots here; the routing engine (open-sse/services/routingStrategies.js)
// reads them so fallback / fill-first can prefer accounts that still have quota.
// Unlike the in-memory Antigravity cache this survives restarts, so a freshly
// booted process still knows which accounts were exhausted.
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToEntry(row) {
  if (!row) return null;
  return {
    connectionId: row.connectionId,
    provider: row.provider || null,
    status: row.status || "unknown",
    remainingPct: row.remainingPct == null ? null : Number(row.remainingPct),
    resetAt: row.resetAt || null,
    quotas: parseJson(row.quotas, null),
    updatedAt: row.updatedAt,
  };
}

/**
 * Upsert a quota snapshot for a connection.
 * @param {string} connectionId
 * @param {object} snapshot
 * @param {string} snapshot.provider
 * @param {"available"|"empty"|"unknown"} snapshot.status
 * @param {number|null} [snapshot.remainingPct] best remaining % across windows
 * @param {string|null} [snapshot.resetAt] earliest reset (ISO) when empty
 * @param {Array|null} [snapshot.quotas] normalized quota rows
 */
export async function saveQuotaSnapshot(connectionId, snapshot = {}) {
  if (!connectionId) return null;
  const db = await getAdapter();
  const updatedAt = new Date().toISOString();
  await db.run(
    `INSERT INTO quotaTracker(connectionId, provider, status, remainingPct, resetAt, quotas, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connectionId) DO UPDATE SET
       provider = excluded.provider,
       status = excluded.status,
       remainingPct = excluded.remainingPct,
       resetAt = excluded.resetAt,
       quotas = excluded.quotas,
       updatedAt = excluded.updatedAt`,
    [
      connectionId,
      snapshot.provider || null,
      snapshot.status || "unknown",
      Number.isFinite(Number(snapshot.remainingPct)) ? Number(snapshot.remainingPct) : null,
      snapshot.resetAt || null,
      snapshot.quotas != null ? stringifyJson(snapshot.quotas) : null,
      updatedAt,
    ]
  );
  return { connectionId, ...snapshot, updatedAt };
}

export async function getQuotaSnapshot(connectionId) {
  if (!connectionId) return null;
  const db = await getAdapter();
  const row = await db.get(`SELECT * FROM quotaTracker WHERE connectionId = ?`, [connectionId]);
  return rowToEntry(row);
}

/**
 * Load snapshots for many connections at once.
 * @param {string[]} connectionIds
 * @returns {Promise<Map<string, object>>} connectionId → snapshot
 */
export async function getQuotaSnapshots(connectionIds = []) {
  const ids = Array.isArray(connectionIds) ? connectionIds.filter(Boolean) : [];
  const out = new Map();
  if (ids.length === 0) return out;
  const db = await getAdapter();
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db.all(`SELECT * FROM quotaTracker WHERE connectionId IN (${placeholders})`, ids);
  for (const row of rows) {
    const entry = rowToEntry(row);
    if (entry) out.set(entry.connectionId, entry);
  }
  return out;
}

export async function getAllQuotaSnapshots() {
  const db = await getAdapter();
  const rows = await db.all(`SELECT * FROM quotaTracker ORDER BY updatedAt DESC`);
  return rows.map(rowToEntry).filter(Boolean);
}

export async function deleteQuotaSnapshot(connectionId) {
  if (!connectionId) return false;
  const db = await getAdapter();
  const res = await db.run(`DELETE FROM quotaTracker WHERE connectionId = ?`, [connectionId]);
  return (res?.changes ?? 0) > 0;
}

export async function deleteQuotaSnapshotsByProvider(provider) {
  if (!provider) return 0;
  const db = await getAdapter();
  const before = await db.get(`SELECT COUNT(*) AS n FROM quotaTracker WHERE provider = ?`, [provider]);
  await db.run(`DELETE FROM quotaTracker WHERE provider = ?`, [provider]);
  return before?.n || 0;
}
