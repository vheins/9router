// Initial schema bootstrap. For fresh DB this creates all tables/indexes.
// For existing DB at version 0 (legacy unstamped), it's idempotent (IF NOT EXISTS).
import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 1,
  name: "initial",
  async up(db) {
    const mode = db.driver === "mariadb" ? "mariadb" : "sqlite";
    for (const [name, def] of Object.entries(TABLES)) {
      await db.exec(buildCreateTableSql(name, def, mode));
      for (const idx of def.indexes || []) await db.exec(idx);
    }
  },
};
