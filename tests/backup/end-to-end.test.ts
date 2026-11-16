/**
 * The real chain, end to end, in temp folders: takeBackup with the REAL roll,
 * then the restore drill, then the USB sync. Nothing here is mocked.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findZstd, readManifest, sha256File } from "@/lib/backup/archive";
import { backupPaths } from "@/lib/backup/backup-home";
import { RESTORE_NOTES_NAME } from "@/lib/backup/restore-notes";
import { USB_MARKER_NAME } from "@/lib/backup/storage-report";
import { takeBackup } from "@/lib/backup/take-backup";
import { runRestoreTest } from "../../scripts/backup-restore-test";
import { USB_FOLDER, syncToVolume } from "../../scripts/backup-usb-sync";

const zstd = findZstd();

let tmp: string;
let home: string;
let volume: string;
let db: Database.Database;
let env: Record<string, string | undefined>;
const quiet = () => {};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backup-e2e-")));
  home = path.join(tmp, "home");
  volume = path.join(tmp, "volume");
  fs.mkdirSync(path.join(tmp, "live"));
  fs.mkdirSync(volume);
  const live = path.join(tmp, "live", "vanguard.db");
  db = new Database(live);
  db.exec("CREATE TABLE schema_migrations (id TEXT)");
  db.exec("INSERT INTO schema_migrations VALUES ('a'), ('b')");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)");
  env = { VANGUARD_LIVE_DB_PATH: live, VANGUARD_BACKUP_DIR: home, PATH: process.env.PATH };
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** One live backup with the real roll; the database changes a little each time. */
async function backupAt(iso: string, n: number): Promise<string> {
  db.prepare("INSERT INTO t (n) VALUES (?)").run(n);
  const res = await takeBackup(db, { purpose: "e2e", now: new Date(iso), env, script: "e2e.ts", log: quiet });
  return res.path;
}

const listDir = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

describe.skipIf(zstd === null)("backup chain end to end", () => {
  it("four backups roll one into the month's archive; the drill passes; the USB sync copies it", async () => {
    const first = await backupAt("2026-03-05T15:00:00Z", 1);
    const firstSum = await sha256File(first);
    await backupAt("2026-03-05T15:00:01Z", 2);
    await backupAt("2026-03-05T15:00:02Z", 3);
    await backupAt("2026-03-05T15:00:03Z", 4);

    const { recent, archives, log } = backupPaths(home);
    expect(listDir(recent).filter((n) => n.endsWith(".db"))).toHaveLength(3);
    expect(fs.existsSync(first)).toBe(false);
    expect(listDir(archives)).toEqual(["2026-03.sha256", "2026-03.tar.zst"]);
    expect(readManifest(path.join(archives, "2026-03.sha256")).get(path.basename(first))).toBe(firstSum);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(4);
    expect(fs.existsSync(path.join(home, RESTORE_NOTES_NAME))).toBe(true);

    const drill = await runRestoreTest(home, zstd);
    expect(drill).toMatchObject({ ok: true, member: path.basename(first), migrations: 2 });

    const sync = await syncToVolume(home, volume, { zstd });
    expect(sync.copied.sort()).toEqual(["2026-03.sha256", "2026-03.tar.zst", RESTORE_NOTES_NAME].sort());
    expect(sync.refused).toEqual([]);
    expect(sync.stamped).toBe(true);
    const onDrive = path.join(volume, USB_FOLDER);
    expect(await sha256File(path.join(onDrive, "2026-03.tar.zst"))).toBe(
      await sha256File(path.join(archives, "2026-03.tar.zst")),
    );
    expect(fs.existsSync(path.join(home, USB_MARKER_NAME))).toBe(true);
  });

  it("backups stamped in two months roll into two archives", async () => {
    // 04:59:59Z on Feb 1 is still Jan 31 in New York; the stamps are Eastern.
    const jan = await backupAt("2026-02-01T04:59:59Z", 1);
    const feb = await backupAt("2026-02-01T05:00:00Z", 2);
    await backupAt("2026-02-01T05:00:01Z", 3);
    await backupAt("2026-02-01T05:00:02Z", 4);
    await backupAt("2026-02-01T05:00:03Z", 5);

    const { recent, archives } = backupPaths(home);
    expect(listDir(recent).filter((n) => n.endsWith(".db"))).toHaveLength(3);
    expect(listDir(archives)).toEqual(["2026-01.sha256", "2026-01.tar.zst", "2026-02.sha256", "2026-02.tar.zst"]);
    expect([...readManifest(path.join(archives, "2026-01.sha256")).keys()]).toEqual([path.basename(jan)]);
    expect([...readManifest(path.join(archives, "2026-02.sha256")).keys()]).toEqual([path.basename(feb)]);
    expect((await runRestoreTest(home, zstd)).ok).toBe(true);
  });
});
