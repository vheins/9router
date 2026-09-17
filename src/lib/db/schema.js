// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
import { buildCreateTableMaria } from "./dialect.js";

export const SCHEMA_VERSION = 3;

// UUID primary keys are declared CHAR(36) — a fixed-width, binary-collated
// string. SQLite treats CHAR as TEXT affinity (stores the same UUID string,
// length not enforced); the MariaDB dialect maps CHAR(36) to
// `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin` (compact + case-sensitive
// exact-match, ideal for UUID lookups). The app binds UUID strings unchanged.
//
// Only tables whose id is ALWAYS a UUID may use this. Tables whose repos use
// `id: data.id || uuidv4()` (providerNodes, proxyPools) can receive a custom /
// prefixed id on import (e.g. "openai-compatible-responses-<uuid>" = 64 chars),
// so they must stay variable-length — see VARLEN_PK.
const UUID_PK = "CHAR(36) PRIMARY KEY";

// Variable-length primary key for tables whose id is not guaranteed to be a
// UUID (imported/preset rows carry the original id verbatim). VARCHAR(255) is
// the pre-optimization legacy width: enough headroom for any generated prefix
// (worst case 64 chars today) and for arbitrary imported ids. SQLite keeps TEXT
// affinity; the MariaDB dialect honors VARCHAR(255) verbatim.
const VARLEN_PK = "VARCHAR(255) PRIMARY KEY";

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: UUID_PK,
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      // NOT a UUID: id may be a prefixed id (e.g.
      // `openai-compatible-responses-<uuid>` = 64 chars) from createProviderNode
      // (`data.id || uuidv4()`) or an arbitrary imported id → must stay VARCHAR.
      id: VARLEN_PK,
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      // NOT guaranteed UUID: createProxyPool uses `data.id || uuidv4()`, so an
      // imported/preset pool can carry a custom id → must stay VARCHAR.
      id: VARLEN_PK,
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: UUID_PK,
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
    },
    // No separate idx_ak_key: `key` is already UNIQUE (a redundant plain index
    // just doubles write cost). Migration 002 drops it on existing MariaDB DBs.
  },
  combos: {
    columns: {
      id: UUID_PK,
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    // No separate idx_combo_name: `name` is already UNIQUE. Migration 002 drops
    // it on existing MariaDB DBs.
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      // NOT a UUID: composite `${ISO timestamp}-${random6}-${modelSlug}` (~40–90
      // chars). VARCHAR(128) is a safe upper bound; SQLite keeps TEXT affinity.
      id: "VARCHAR(128) PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },
};

export function buildCreateTableSql(name, def, mode = "sqlite") {
  if (mode === "mariadb") return buildCreateTableMaria(name, def);
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
