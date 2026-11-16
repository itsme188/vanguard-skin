/**
 * Restore drill: proves the newest backup can really be opened.
 * Run: npm run backup:restore-test
 * Picks the newest member of the newest archive (or the newest file in
 * recent/ when there is no archive), checks its checksum, runs an integrity
 * check on the extracted copy, and deletes the copy. Exit 0 = good, 1 = bad.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { extractMember, findZstd, listArchiveMembers, readManifest, sha256File } from "@/lib/backup/archive";
import { backupPaths, resolveBackupHome } from "@/lib/backup/backup-home";

export interface RestoreTestResult {
  ok: boolean;
  archive: string | null;
  member: string | null;
  tables?: number;
  migrations?: number | null;
  reason?: string;
}

interface DbCheck {
  tables: number;
  migrations: number | null;
}

/** Opens `file` read-only, runs the integrity check, counts tables and migrations. */
function checkDatabase(file: string): DbCheck {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma("integrity_check") as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
      throw new Error(`integrity check failed: ${rows.map((r) => r.integrity_check).join("; ")}`);
    }
    const tables = (
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as {
        n: number;
      }
    ).n;
    const hasMigrations = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    const migrations = hasMigrations
      ? (db.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number }).n
      : null;
    return { tables, migrations };
  } finally {
    db.close();
  }
}

function newestBy(dir: string, suffix: string): string | null {
  if (!fs.existsSync(dir)) return null;
  let best: { file: string; mtime: number } | null = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(suffix)) continue;
    const file = path.join(dir, name);
    const st = fs.statSync(file);
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtime || (st.mtimeMs === best.mtime && file > best.file)) {
      best = { file, mtime: st.mtimeMs };
    }
  }
  return best?.file ?? null;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Never calls process.exit; the caller turns the result into an exit code. */
export async function runRestoreTest(home: string, zstd: string | null): Promise<RestoreTestResult> {
  const { archives, recent } = backupPaths(home);
  const archive = newestBy(archives, ".tar.zst");

  if (!archive) {
    const db = newestBy(recent, ".db");
    if (!db) {
      return { ok: false, archive: null, member: null, reason: `no archive in ${archives} and no .db in ${recent}` };
    }
    try {
      return { ok: true, archive: null, member: path.basename(db), ...checkDatabase(db) };
    } catch (err) {
      return { ok: false, archive: null, member: path.basename(db), reason: message(err) };
    }
  }

  if (!zstd) {
    return { ok: false, archive, member: null, reason: "zstd is not installed (try: brew install zstd)" };
  }

  let member: string | null = null;
  let temp: string | null = null;
  try {
    const members = await listArchiveMembers(archive, zstd);
    member = members[members.length - 1] ?? null;
    if (!member) throw new Error("the archive holds no members");
    const manifest = readManifest(archive.replace(/\.tar\.zst$/, ".sha256"));
    const expected = manifest.get(member);
    if (!expected) throw new Error(`the manifest has no checksum for ${member}`);

    temp = fs.mkdtempSync(path.join(os.tmpdir(), "backup-restore-test-"));
    const dest = path.join(temp, path.basename(member));
    await extractMember(archive, member, dest, zstd);
    const actual = await sha256File(dest);
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${member}: manifest ${expected}, extracted ${actual}`);
    }
    return { ok: true, archive, member, ...checkDatabase(dest) };
  } catch (err) {
    return { ok: false, archive, member, reason: message(err) };
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const home = resolveBackupHome();
  const r = await runRestoreTest(home, findZstd());
  const from = r.archive ? `${path.basename(r.archive)} / ${r.member}` : `${r.member ?? "(none)"}`;
  if (!r.ok) {
    console.error(`RESTORE TEST FAILED (${from}): ${r.reason}`);
    process.exit(1);
  }
  console.log(`Restore test passed: ${from}`);
  console.log(`  tables: ${r.tables}`);
  console.log(`  schema_migrations rows: ${r.migrations ?? "no schema_migrations table"}`);
}

const isMain =
  typeof process !== "undefined" && process.argv[1] != null && /backup-restore-test\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${message(err)}`);
    process.exit(1);
  });
}
