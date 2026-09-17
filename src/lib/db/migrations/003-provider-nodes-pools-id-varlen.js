// 003 — widen providerNodes.id / proxyPools.id from CHAR(36) back to VARCHAR(255).
//
// Why: migration 002 wrongly tightened EVERY UUID PK to CHAR(36) ascii_bin,
// including providerNodes and proxyPools. Those two tables are NOT UUID-only:
// their repos use `id: data.id || uuidv4()` (see nodesRepo.js and
// proxyPoolsRepo.js), so an imported/preset row keeps its original id. A
// compatible provider node id is built as
//   `${OPENAI_COMPATIBLE_PREFIX}${apiType}-${uuid}`
// e.g. "openai-compatible-responses-<uuid>" = 64 chars, and
// "openai-compatible-chat-<uuid>" = 59 chars. CHAR(36) rejected those with
// SQLSTATE 22001 / errno 1406 ("Data too long for column 'id'") on import.
//
// CHAR(36) → VARCHAR(255) is a pure WIDENING (never truncates), so it is always
// safe to apply. providerConnections / apiKeys / combos stay CHAR(36): their
// repos always generate `id: uuidv4()` (verified) and never accept data.id.
//
// MariaDB-only. SQLite treats CHAR/VARCHAR as TEXT affinity (no length
// enforcement) and already stores long ids, so `up()` is a no-op there.
const WIDEN_TABLES = ["providerNodes", "proxyPools"];
const TARGET_TYPE = "VARCHAR(255)";

/** Current MariaDB column type for table.column, or null when unknown/missing. */
async function currentColumnType(db, table, column) {
  const row = await db.get(
    `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return row?.t ? String(row.t) : null;
}

export default {
  version: 3,
  name: "provider-nodes-pools-id-varlen",
  async up(db) {
    const mode = db.driver === "mariadb" ? "mariadb" : "sqlite";
    if (mode !== "mariadb") return; // SQLite: TEXT affinity already accepts long ids.

    for (const table of WIDEN_TABLES) {
      const current = await currentColumnType(db, table, "id");
      if (!current) {
        console.warn(`[DB][migrate] #3 ${table}: table/column not found — skipping`);
        continue;
      }
      // Already the target width → nothing to do (idempotent re-run).
      if (current.toLowerCase() === TARGET_TYPE.toLowerCase()) {
        continue;
      }
      // WIDENING is lossless. Sanity-check anyway: if the target width would be
      // narrower than existing data (it never is for VARCHAR(255)), warn and
      // leave the column untouched rather than risk truncation.
      const row = await db.get(`SELECT MAX(CHAR_LENGTH(id)) AS m FROM ${table}`);
      const maxLen = Number(row?.m ?? 0);
      if (maxLen > 255) {
        console.warn(
          `[DB][migrate] #3 ${table}.id: existing max length ${maxLen} exceeds 255 — skipping MODIFY`,
        );
        continue;
      }
      await db.exec(`ALTER TABLE \`${table}\` MODIFY COLUMN \`id\` ${TARGET_TYPE} NOT NULL`);
      console.log(`[DB][migrate] #3 widened ${table}.id ${current} → ${TARGET_TYPE}`);
    }
  },
};
