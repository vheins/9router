// SQLite → MariaDB SQL translator + DDL mapper.
//
// Used ONLY when DB_MODE=mariadb. SQLite mode never touches this module.
// Design goals:
//   - Conservative: only rewrite known SQLite-isms, leave everything else intact.
//   - Fail-safe: if anything throws, the caller (mariadbAdapter) logs and falls
//     back to the original SQL.
//
// Translation rules implemented (see translate()):
//   1. `PRAGMA table_info(t)`      → information_schema lookup returning a `name` column
//   2. bare `PRAGMA ...;` lines    → stripped (no-op)
//   3. `INSERT OR REPLACE INTO`    → `REPLACE INTO`
//   4. `INSERT OR IGNORE INTO`     → `INSERT IGNORE INTO`
//   5. `AUTOINCREMENT`             → `AUTO_INCREMENT`
//   6. `last_insert_rowid()`       → `LAST_INSERT_ID()`
//   7. `ON CONFLICT (cols) DO UPDATE SET a = excluded.a, ...`
//                                  → `ON DUPLICATE KEY UPDATE a = VALUES(a), ...`
//   8. `ON CONFLICT (cols) DO NOTHING` → drops the clause and turns the INSERT into `INSERT IGNORE`
//   9. bare reserved identifier `key` → `` `key` `` (MariaDB reserves KEY; `PRIMARY KEY`,
//      `UNIQUE KEY`, `FOREIGN KEY`, `DUPLICATE KEY`, `CHECK KEY`, `PARTITION KEY` are preserved)
//  10. `IN (SELECT ... LIMIT n)`  → `IN (SELECT * FROM (SELECT ... LIMIT n) AS _dt)`
//      (MariaDB rejects LIMIT directly inside an IN/ALL/ANY/SOME subquery)

// Reserved identifier(s) that appear as COLUMN names in this schema and clash
// with MariaDB keywords. Only `key` is actually reserved (verified against
// MariaDB 11.8); the others (`value`, `status`, `type`, `timestamp`, ...) are fine.
const RESERVED_IDENTIFIERS = ["key"];

// Keywords that legitimately precede the word KEY and must NOT be quoted.
const KEY_KEYWORD_PREFIX = /(\bPRIMARY\b|\bUNIQUE\b|\bFOREIGN\b|\bDUPLICATE\b|\bCHECK\b|\bPARTITION\b)\s+KEY\b/gi;

/**
 * SQL to list a table's columns on MariaDB, shaped like `PRAGMA table_info(t)`
 * (each row exposes a `name` field). The table name is inlined (not a bound
 * param) because callers interpolate it, matching the SQLite path.
 */
export function tableInfo(tableName) {
  const safe = String(tableName).replace(/'/g, "''");
  return `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${safe}'`;
}

/** True when the given SQL is a pure PRAGMA statement (safe to drop on MariaDB). */
function isPurePragma(sql) {
  return /^\s*PRAGMA\b/i.test(sql);
}

/** Quote a single identifier with backticks (escaping embedded backticks). */
function quoteIdent(name) {
  return "`" + String(name).replace(/`/g, "``") + "`";
}

// ─── ON CONFLICT → ON DUPLICATE KEY UPDATE ────────────────────────────────
function replaceOnConflict(sql) {
  const re = /\bON\s+CONFLICT\b\s*(\(([^)]*)\))?\s*DO\s+(UPDATE\s+SET|NOTHING)\b([\s\S]*)$/i;
  const m = sql.match(re);
  if (!m) return sql;

  const target = (m[2] || "").trim();
  const action = m[3].toUpperCase();
  const tail = m[4] || "";
  const before = sql.slice(0, m.index);

  if (action.startsWith("NOTHING")) {
    // INSERT IGNORE semantics: promote the INSERT and drop the conflict clause.
    return before.replace(/\bINSERT\s+INTO\b/i, "INSERT IGNORE INTO");
  }

  // `excluded.col` (anywhere in the assignment list) → `VALUES(col)`.
  // Identifier quoting for `key` etc. is applied later by quoteReservedIdentifiers().
  const assigns = tail.replace(/\bexcluded\.([A-Za-z0-9_]+)/gi, (_mm, col) => `VALUES(${col})`);
  return `${before}ON DUPLICATE KEY UPDATE ${assigns}`;
}

// ─── LIMIT inside IN (...) subquery → derived-table wrapper ───────────────
// MariaDB: "This version of MariaDB doesn't yet support 'LIMIT & IN/ALL/ANY/SOME
// subquery'". Wrap the offending subquery in a derived table so it materializes.
function wrapLimitInSubquery(sql) {
  const re = /\bIN\s*\(/gi;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const open = m.index + m[0].length - 1; // index of "("
    // Balanced-paren scan to find the matching close paren.
    let depth = 0;
    let i = open;
    for (; i < sql.length; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i >= sql.length) break; // unbalanced — leave untouched
    const sub = sql.slice(open + 1, i);
    if (/^\s*SELECT\b/i.test(sub) && /\bLIMIT\b/i.test(sub)) {
      out += sql.slice(last, m.index) + `IN (SELECT * FROM (${sub}) AS _dt)`;
      last = i + 1;
      re.lastIndex = last;
    }
  }
  out += sql.slice(last);
  return out;
}

// ─── Reserved-identifier quoting ──────────────────────────────────────────
function quoteReservedIdentifiers(sql) {
  const stash = [];
  const hide = (str) => {
    stash.push(str);
    return `\u0000${stash.length - 1}\u0000`;
  };

  let s = sql;
  // Hide single-quoted string literals first so we never rewrite inside them.
  s = s.replace(/'(?:[^'\\]|\\.|'')*'/g, (m) => hide(m));
  // Hide already-backticked identifiers (idempotency).
  s = s.replace(/`[^`]*`/g, (m) => hide(m));
  // Hide keyword+KEY pairs (PRIMARY KEY, ON DUPLICATE KEY, ...).
  s = s.replace(KEY_KEYWORD_PREFIX, (m) => hide(m));

  for (const ident of RESERVED_IDENTIFIERS) {
    s = s.replace(new RegExp(`\\b${ident}\\b`, "gi"), (m) => quoteIdent(m));
  }

  // Restore hidden fragments.
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => stash[Number(i)]);
  return s;
}

/**
 * Translate a single SQLite statement into MariaDB SQL.
 * Returns "" for statements that become no-ops (pure PRAGMA).
 */
export function translate(sql) {
  if (typeof sql !== "string" || sql.length === 0) return sql;
  try {
    let s = sql;

    // 1. PRAGMA table_info(t) → information_schema (must run before generic strip).
    s = s.replace(
      /PRAGMA\s+table_info\s*\(\s*([A-Za-z0-9_]+)\s*\)/gi,
      (_m, t) => tableInfo(t),
    );

    // 2. Strip standalone PRAGMA statements (PRAGMA_SQL, wal_checkpoint, ...).
    if (isPurePragma(s)) {
      s = s.replace(/^[ \t]*PRAGMA\b[^;\n]*;?[ \t]*$/gim, "");
    }
    if (!s.trim()) return "";

    // 3–6. Keyword-level rewrites.
    s = s.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, "REPLACE INTO");
    s = s.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, "INSERT IGNORE INTO");
    s = s.replace(/\bAUTOINCREMENT\b/gi, "AUTO_INCREMENT");
    s = s.replace(/last_insert_rowid\s*\(\s*\)/gi, "LAST_INSERT_ID()");

    // 7–8. ON CONFLICT handling.
    s = replaceOnConflict(s);

    // 10. LIMIT-in-IN(...) subquery workaround.
    s = wrapLimitInSubquery(s);

    // 9. Reserved identifier quoting.
    s = quoteReservedIdentifiers(s);

    return s;
  } catch (e) {
    console.warn(`[DB][dialect] translate failed (${e.message}) — using original SQL`);
    return sql;
  }
}

// ─── Column type mapping (DDL) ────────────────────────────────────────────
/**
 * Map a SQLite column definition to a MariaDB column definition.
 * `opts.indexed` marks columns that participate in a PRIMARY KEY / UNIQUE / index —
 * those must be VARCHAR (InnoDB cannot index TEXT/BLOB without a key length),
 * everything else TEXT-ish becomes LONGTEXT so large JSON payloads fit.
 */
export function mapColumnType(sqliteType, opts = {}) {
  const indexed = !!opts.indexed;
  const raw = String(sqliteType).trim();

  // Special case: SQLite rowid alias.
  if (/^INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT$/i.test(raw)) {
    return "BIGINT AUTO_INCREMENT PRIMARY KEY";
  }

  const m = raw.match(/^(TEXT|INTEGER|REAL|BLOB|NUMERIC|VARCHAR|CHAR)\b/i);
  const base = m ? m[1].toUpperCase() : "TEXT";
  let rest = m ? raw.slice(m[0].length).trim() : raw;

  const isPk = /\bPRIMARY\s+KEY\b/i.test(rest);
  const isUnique = /\bUNIQUE\b/i.test(rest);
  const needVarchar = indexed || isPk || isUnique;

  let mappedBase;
  switch (base) {
    case "TEXT":
      mappedBase = needVarchar ? "VARCHAR(255)" : "LONGTEXT";
      break;
    case "INTEGER":
      mappedBase = isPk ? "BIGINT" : "INT";
      break;
    case "REAL":
      mappedBase = "DOUBLE";
      break;
    case "BLOB":
      mappedBase = "LONGBLOB";
      break;
    case "NUMERIC":
      mappedBase = "DECIMAL(20,6)";
      break;
    case "VARCHAR":
    case "CHAR":
      mappedBase = "VARCHAR(255)";
      break;
    default:
      mappedBase = needVarchar ? "VARCHAR(255)" : "LONGTEXT";
  }

  const constraints = rest.replace(/\bAUTOINCREMENT\b/gi, "").replace(/\s+/g, " ").trim();
  return constraints ? `${mappedBase} ${constraints}` : mappedBase;
}

/**
 * Determine which columns of a table definition are indexed (PK / UNIQUE /
 * referenced by an index) so they can be mapped to VARCHAR on MariaDB.
 */
export function indexedColumns(def) {
  const set = new Set();
  for (const [col, type] of Object.entries(def.columns || {})) {
    if (/\bPRIMARY\s+KEY\b/i.test(type) || /\bUNIQUE\b/i.test(type)) set.add(col);
  }
  if (def.primaryKey) {
    const m = def.primaryKey.match(/\(([^)]*)\)/);
    if (m) for (const c of m[1].split(",")) set.add(c.trim().replace(/[`"']/g, ""));
  }
  for (const idx of def.indexes || []) {
    const m = String(idx).match(/\bON\b\s+[`"']?[A-Za-z0-9_]+[`"']?\s*\(([^)]*)\)/i);
    if (m) {
      for (const part of m[1].split(",")) {
        const col = part.trim().split(/\s+/)[0].replace(/[`"']/g, "");
        if (col) set.add(col);
      }
    }
  }
  return set;
}

/**
 * Build a MariaDB-compatible CREATE TABLE statement for a TABLES definition.
 * Output still flows through translate() in the adapter (which quotes reserved
 * identifiers like `key`), so identifiers here are emitted plainly.
 */
export function buildCreateTableMaria(name, def) {
  const indexed = indexedColumns(def);
  const cols = Object.entries(def.columns).map(
    ([col, type]) => `\`${col}\` ${mapColumnType(type, { indexed: indexed.has(col) })}`,
  );
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS \`${name}\` (${cols.join(", ")}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}
