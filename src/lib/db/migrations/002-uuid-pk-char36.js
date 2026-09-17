// 002 — UUID primary keys → CHAR(36) ascii_bin, requestDetails.id → VARCHAR(128),
// and drop two redundant duplicate indexes.
//
// Why: UUID PKs were mapped to VARCHAR(255) utf8mb4 (up to 1020 bytes each),
// bloating every row and every secondary index that embeds the PK. A UUID is
// exactly 36 ASCII chars, so CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
// stores it in 36 bytes with a case-sensitive, exact-match collation. The app
// binds UUID strings unchanged (drop-in: `WHERE id = ?` still works).
//
// This migration is MariaDB-specific. In SQLite mode the schema already works
// (CHAR/TEXT affinity stores the same string) and there are no duplicate
// indexes to drop, so `up()` is a no-op.
import { UUID_CHAR_TYPE } from "../dialect.js";

// UUID PK tables and the fixed width their id must have.
const UUID_TABLES = [
  "providerConnections",
  "providerNodes",
  "proxyPools",
  "apiKeys",
  "combos",
];
const UUID_LEN = 36;

// requestDetails.id is NOT a UUID — it's `${ISO timestamp}-${random6}-${slug}`
// (~40–90 chars). VARCHAR(128) is a safe upper bound.
const DETAILS_ID_MAX = 128;

// Redundant indexes superseded by an existing UNIQUE key (same column, prefix).
// Declaring them in schema.js is what created them; that declaration was
// removed alongside this migration so additive sync no longer resurrects them.
const DROP_INDEXES = [
  { table: "apiKeys", index: "idx_ak_key" },
  { table: "combos", index: "idx_combo_name" },
];

/** True when the named index exists on the table (portable across MariaDB/MySQL). */
async function indexExists(db, table, index) {
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index],
  );
  return Number(row?.c ?? 0) > 0;
}

/**
 * MODIFY a column only if NO existing value would violate the new width.
 * `badPredicate` counts rows that would NOT fit; if any exist we warn and leave
 * the column as-is rather than truncating/rejecting data or failing the whole
 * migration (the app keeps working with the wider type).
 */
async function tightenColumn(db, table, column, { badPredicate, newType, describe }) {
  const row = await db.get(`SELECT COUNT(*) AS c FROM ${table} WHERE ${badPredicate}`);
  const bad = Number(row?.c ?? 0);
  if (bad > 0) {
    console.warn(
      `[DB][migrate] #2 ${table}.${column}: ${bad} row(s) ${describe} — skipping MODIFY, column left unchanged`,
    );
    return;
  }
  await db.exec(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${newType} NOT NULL`);
}

export default {
  version: 2,
  name: "uuid-pk-char36",
  async up(db) {
    const mode = db.driver === "mariadb" ? "mariadb" : "sqlite";
    if (mode !== "mariadb") return; // SQLite: schema already correct — no-op.

    // 1. UUID PKs → CHAR(36) ascii_bin (guarded against non-36-char ids).
    for (const table of UUID_TABLES) {
      await tightenColumn(db, table, "id", {
        badPredicate: `CHAR_LENGTH(id) <> ${UUID_LEN}`,
        newType: UUID_CHAR_TYPE,
        describe: `do not have a ${UUID_LEN}-char id`,
      });
    }

    // 2. requestDetails.id → VARCHAR(128) (guarded against oversized ids).
    await tightenColumn(db, "requestDetails", "id", {
      badPredicate: `CHAR_LENGTH(id) > ${DETAILS_ID_MAX}`,
      newType: `VARCHAR(${DETAILS_ID_MAX})`,
      describe: `exceed ${DETAILS_ID_MAX} chars`,
    });

    // 3. Drop redundant duplicate indexes (each is already covered by a UNIQUE
    //    key on the same column). Checked via information_schema first because
    //    `DROP INDEX IF EXISTS` is not portable across MariaDB/MySQL versions.
    for (const { table, index } of DROP_INDEXES) {
      if (await indexExists(db, table, index)) {
        await db.exec(`ALTER TABLE ${table} DROP INDEX ${index}`);
        console.log(`[DB][migrate] #2 dropped redundant index ${table}.${index}`);
      }
    }
  },
};
