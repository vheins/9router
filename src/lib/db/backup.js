// DB safety backups — taken ONLY before a schema change (see migrate.js).
//
// ⚠️ AGENT/DEV NOTES:
// - Backups are a best-effort safety net before schema migrations. There is NO
//   automated restore path; recovery is manual (copy a backup file back).
// - Backups intentionally EXCLUDE the `requestDetails` table (observability log,
//   auto-pruned, non-critical) so a multi-hundred-MB DB backs up as a few MB.
// - Only the newest KEEP_BACKUPS are kept; older ones are pruned automatically.
// - SQLite mode: lightweight file copy via ATTACH.
// - MariaDB mode: logical JSON dump (ATTACH/sqlite_master don't exist there).
import fs from "node:fs";
import path from "node:path";
import { BACKUPS_DIR, ensureDirs } from "./paths.js";
import { TABLES } from "./schema.js";
import { timestampSlug, getAppVersion } from "./version.js";
import { getDbMode } from "./driver.js";

const KEEP_BACKUPS = 3;

// Tables excluded from safety backups (large, non-critical, reproducible).
const BACKUP_EXCLUDE_TABLES = ["requestDetails"];

export function makeBackupDir(label) {
  ensureDirs();
  const ver = getAppVersion();
  const slug = `${label}-${ver}-${timestampSlug()}`;
  const dir = path.join(BACKUPS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function backupFile(srcPath, destDir, destName = null) {
  if (!fs.existsSync(srcPath)) return null;
  const name = destName || path.basename(srcPath);
  const dest = path.join(destDir, name);
  fs.copyFileSync(srcPath, dest);
  return dest;
}

// Lightweight DB backup via ATTACH: create an empty sqlite file, copy every
// table EXCEPT the excluded ones into it. Avoids duplicating the huge
// observability log, so the backup stays small regardless of DB size.
async function backupDbLiteSqlite(adapter, destDir, destName) {
  const dest = path.join(destDir, destName);
  try { fs.rmSync(dest, { force: true }); } catch {}
  const escaped = dest.replace(/'/g, "''");

  await adapter.exec(`ATTACH DATABASE '${escaped}' AS bak`);
  try {
    const excluded = new Set(BACKUP_EXCLUDE_TABLES);
    const tables = (await adapter.all(`SELECT name, sql FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`))
      .filter((t) => !excluded.has(t.name));

    await adapter.transaction(async () => {
      for (const t of tables) {
        // Recreate table structure in backup DB, then copy rows.
        const createSql = t.sql.replace(/CREATE TABLE\s+/i, "CREATE TABLE bak.");
        await adapter.exec(createSql);
        await adapter.exec(`INSERT INTO bak.${t.name} SELECT * FROM main.${t.name}`);
      }
    });
  } finally {
    try { await adapter.exec("DETACH DATABASE bak"); } catch {}
  }
  return dest;
}

// MariaDB logical backup: dump every non-excluded table to a JSON file.
async function backupDbLiteMaria(adapter, destDir, destName) {
  const dest = path.join(destDir, destName);
  const excluded = new Set(BACKUP_EXCLUDE_TABLES);
  const dump = {};
  for (const name of Object.keys(TABLES)) {
    if (excluded.has(name)) continue;
    try { dump[name] = await adapter.all(`SELECT * FROM ${name}`); } catch { dump[name] = []; }
  }
  fs.writeFileSync(dest, JSON.stringify({ takenAt: new Date().toISOString(), tables: dump }));
  return dest;
}

export async function backupDbLite(adapter, destDir, destName = null) {
  if (getDbMode() === "mariadb") {
    return backupDbLiteMaria(adapter, destDir, destName || "data.json");
  }
  return backupDbLiteSqlite(adapter, destDir, destName || "data.sqlite");
}

export function pruneOldBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, full: path.join(BACKUPS_DIR, e.name), mtime: fs.statSync(path.join(BACKUPS_DIR, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of entries.slice(KEEP_BACKUPS)) {
    try { fs.rmSync(old.full, { recursive: true, force: true }); } catch {}
  }
}
