import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToArchive, findZstd, listArchiveMembers, readManifest, sha256File } from "@/lib/backup/archive";
import { backupPaths } from "@/lib/backup/backup-home";
import { rollOldBackups } from "@/lib/backup/roll";

const ZSTD = findZstd();
const noZstd = ZSTD === null;
const NOW = new Date("2026-11-16T12:00:00Z");
const MIN = 60_000;

let top: string;
let home: string;
let recent: string;
let archives: string;

beforeEach(() => {
  top = fs.mkdtempSync(path.join(os.tmpdir(), "roll-test-"));
  home = path.join(top, "home");
  ({ recent, archives } = backupPaths(home));
  fs.mkdirSync(recent, { recursive: true });
});

afterEach(() => {
  fs.rmSync(top, { recursive: true, force: true });
});

/** A small real SQLite backup in recent/, with its modified time set to `ageMin` minutes before NOW. */
function backup(name: string, ageMin: number, salt = ageMin): string {
  const p = path.join(recent, name);
  const db = new Database(p);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)");
  const ins = db.prepare("INSERT INTO t (label) VALUES (?)");
  db.transaction(() => {
    for (let i = 0; i < 200; i++) ins.run(`row-${i}-${salt}`);
  })();
  db.close();
  const t = new Date(NOW.getTime() - ageMin * MIN);
  fs.utimesSync(p, t, t);
  return p;
}

const listMembers = (archive: string) => listArchiveMembers(archive, ZSTD as string);

const recentNames = () => fs.readdirSync(recent).sort();
const roll = (extra: Parameters<typeof rollOldBackups>[1] = {}) =>
  rollOldBackups(home, { env: {}, now: NOW, zstd: ZSTD, ...extra });

describe("rollOldBackups", () => {
  it.skipIf(noZstd)("keeps the newest 3 and rolls the rest", async () => {
    backup("pre-a-2026-10-01_09-00-00.db", 600);
    backup("pre-a-2026-10-02_09-00-00.db", 500);
    backup("pre-a-2026-10-03_09-00-00.db", 400);
    backup("pre-a-2026-10-04_09-00-00.db", 300);
    backup("pre-a-2026-10-05_09-00-00.db", 200);
    const r = await roll();
    expect(r.skipped).toBeUndefined();
    expect(r.rolled).toEqual(["pre-a-2026-10-01_09-00-00.db", "pre-a-2026-10-02_09-00-00.db"]);
    expect(r.kept).toEqual([
      "pre-a-2026-10-03_09-00-00.db",
      "pre-a-2026-10-04_09-00-00.db",
      "pre-a-2026-10-05_09-00-00.db",
    ]);
    expect(recentNames()).toEqual(r.kept);
    expect(await listMembers(path.join(archives, "2026-10.tar.zst"))).toEqual(r.rolled);
    expect(fs.existsSync(backupPaths(home).rollLock)).toBe(false);
  });

  it.skipIf(noZstd)("does nothing with 3 or fewer", async () => {
    backup("pre-a-2026-10-01_09-00-00.db", 300);
    backup("pre-a-2026-10-02_09-00-00.db", 200);
    backup("pre-a-2026-10-03_09-00-00.db", 100);
    const r = await roll();
    expect(r.rolled).toEqual([]);
    expect(r.kept).toHaveLength(3);
    expect(recentNames()).toHaveLength(3);
    expect(fs.existsSync(archives) ? fs.readdirSync(archives) : []).toEqual([]);
  });

  it.skipIf(noZstd)("files each backup under its own month", async () => {
    backup("pre-a-2026-09-30_09-00-00.db", 900);
    backup("pre-a-2026-10-01_09-00-00.db", 800);
    const undated = backup("undated.db", 700);
    const augTime = new Date("2026-08-15T16:00:00Z"); // Eastern mid-day, August
    fs.utimesSync(undated, augTime, augTime);
    for (let i = 0; i < 3; i++) backup(`pre-b-2026-11-1${i}_09-00-00.db`, 100 - i);
    const r = await roll();
    expect(r.rolled.sort()).toEqual(
      ["pre-a-2026-09-30_09-00-00.db", "pre-a-2026-10-01_09-00-00.db", "undated.db"].sort(),
    );
    expect(await listMembers(path.join(archives, "2026-09.tar.zst"))).toEqual(["pre-a-2026-09-30_09-00-00.db"]);
    expect(await listMembers(path.join(archives, "2026-10.tar.zst"))).toEqual(["pre-a-2026-10-01_09-00-00.db"]);
    expect(await listMembers(path.join(archives, "2026-08.tar.zst"))).toEqual(["undated.db"]);
    expect([...readManifest(path.join(archives, "2026-08.sha256")).keys()]).toEqual(["undated.db"]);
  });

  it.skipIf(noZstd)("removes a loose file only after it is in the manifest", async () => {
    const sept = backup("pre-a-2026-09-30_09-00-00.db", 900);
    fs.writeFileSync(`${sept}-wal`, "wal");
    fs.writeFileSync(`${sept}-shm`, "shm");
    const septSum = await sha256File(sept);
    const oct = backup("pre-a-2026-10-01_09-00-00.db", 800);
    for (let i = 0; i < 3; i++) backup(`pre-b-2026-11-1${i}_09-00-00.db`, 100 - i);
    // October's archive is corrupt, so October's archiving fails.
    fs.mkdirSync(archives, { recursive: true });
    fs.writeFileSync(path.join(archives, "2026-10.tar.zst"), "not a zstd stream");

    await expect(roll()).rejects.toThrow(/2026-10/);
    // September made it into its manifest, so its loose copy (and side files) went.
    expect(readManifest(path.join(archives, "2026-09.sha256")).get("pre-a-2026-09-30_09-00-00.db")).toBe(
      septSum,
    );
    expect(fs.existsSync(sept)).toBe(false);
    expect(fs.existsSync(`${sept}-wal`)).toBe(false);
    expect(fs.existsSync(`${sept}-shm`)).toBe(false);
    // October never reached a manifest, so its loose copy stays.
    expect(fs.existsSync(oct)).toBe(true);
    expect(fs.existsSync(path.join(archives, "2026-10.sha256"))).toBe(false);
    expect(fs.existsSync(backupPaths(home).rollLock)).toBe(false);
  });

  it("is skipped, removing nothing, when zstd is not found", async () => {
    for (let i = 0; i < 5; i++) backup(`pre-a-2026-10-0${i + 1}_09-00-00.db`, 500 - i * 100);
    const before = recentNames();
    const r = await rollOldBackups(home, { env: { PATH: "" }, now: NOW, zstd: null });
    expect(r).toEqual({ rolled: [], kept: before, skipped: "zstd not found" });
    expect(recentNames()).toEqual(before);
    expect(fs.existsSync(archives)).toBe(false);
  });

  it.skipIf(noZstd)("finishes an interrupted roll: file already archived, loose copy still present", async () => {
    const a = backup("pre-a-2026-10-01_09-00-00.db", 600);
    const b = backup("pre-a-2026-10-02_09-00-00.db", 500);
    const archive = path.join(archives, "2026-10.tar.zst");
    const manifest = path.join(archives, "2026-10.sha256");
    fs.mkdirSync(archives, { recursive: true });
    // A previous roll archived `a` but died before removing the loose copy.
    await addToArchive(archive, manifest, [a], ZSTD as string);
    const aSum = await sha256File(a);
    for (let i = 0; i < 3; i++) backup(`pre-b-2026-11-1${i}_09-00-00.db`, 100 - i);

    const r = await roll();
    expect(r.rolled).toEqual(["pre-a-2026-10-01_09-00-00.db", "pre-a-2026-10-02_09-00-00.db"]);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    const members = await listMembers(archive);
    expect(members.filter((m) => m === "pre-a-2026-10-01_09-00-00.db")).toHaveLength(1);
    expect(members).toEqual(["pre-a-2026-10-01_09-00-00.db", "pre-a-2026-10-02_09-00-00.db"]);
    expect(readManifest(manifest).get("pre-a-2026-10-01_09-00-00.db")).toBe(aSum);
    expect(recentNames()).toHaveLength(3);
  });

  it.skipIf(noZstd)("ignores and cleans a stale .new file", async () => {
    for (let i = 0; i < 4; i++) backup(`pre-a-2026-10-0${i + 1}_09-00-00.db`, 400 - i * 100);
    fs.mkdirSync(archives, { recursive: true });
    const staleArchive = path.join(archives, "2026-10.tar.zst.new");
    const staleRecent = path.join(recent, "pre-x-2026-10-09_09-00-00.db.new");
    const stalePartial = path.join(archives, "2026-10.tar.zst.123-1.partial");
    const freshNew = path.join(archives, "2026-09.tar.zst.new");
    fs.writeFileSync(staleArchive, "half-written");
    fs.writeFileSync(staleRecent, "half-written");
    fs.mkdirSync(stalePartial);
    fs.writeFileSync(path.join(stalePartial, "x.db"), "half-extracted");
    fs.writeFileSync(freshNew, "being written right now");
    const old = new Date(NOW.getTime() - 31 * MIN);
    for (const p of [staleArchive, staleRecent, stalePartial]) fs.utimesSync(p, old, old);
    const fresh = new Date(NOW.getTime() - 5 * MIN);
    fs.utimesSync(freshNew, fresh, fresh);

    const r = await roll();
    expect(r.rolled).toEqual(["pre-a-2026-10-01_09-00-00.db"]);
    expect(fs.existsSync(staleArchive)).toBe(false);
    expect(fs.existsSync(staleRecent)).toBe(false);
    expect(fs.existsSync(stalePartial)).toBe(false);
    expect(fs.existsSync(freshNew)).toBe(true);
    expect(await listMembers(path.join(archives, "2026-10.tar.zst"))).toEqual(["pre-a-2026-10-01_09-00-00.db"]);
  });

  it.skipIf(noZstd)("skips when the lock is held and takes over a stale lock", async () => {
    for (let i = 0; i < 4; i++) backup(`pre-a-2026-10-0${i + 1}_09-00-00.db`, 400 - i * 100);
    const lock = backupPaths(home).rollLock;
    fs.mkdirSync(lock);
    const held = new Date(NOW.getTime() - 10 * MIN);
    fs.utimesSync(lock, held, held);

    const before = recentNames();
    const r1 = await roll();
    expect(r1).toEqual({ rolled: [], kept: before, skipped: "another roll is running" });
    expect(recentNames()).toEqual(before);
    expect(fs.existsSync(lock)).toBe(true);

    const stale = new Date(NOW.getTime() - 31 * MIN);
    fs.utimesSync(lock, stale, stale);
    const r2 = await roll();
    expect(r2.skipped).toBeUndefined();
    expect(r2.rolled).toEqual(["pre-a-2026-10-01_09-00-00.db"]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it.skipIf(noZstd)("never touches a file outside <home>/recent", async () => {
    for (let i = 0; i < 5; i++) backup(`pre-a-2026-10-0${i + 1}_09-00-00.db`, 500 - i * 100);
    const old = new Date(NOW.getTime() - 600 * MIN);
    const outside = [
      path.join(home, "pre-z-2026-01-01_09-00-00.db"),
      path.join(home, "stray.db.new"),
      path.join(top, "sibling-2026-01-01.db"),
      path.join(home, "other", "pre-z-2026-01-02_09-00-00.db"),
    ];
    fs.mkdirSync(path.join(home, "other"));
    for (const p of outside) {
      fs.writeFileSync(p, "keep me");
      fs.utimesSync(p, old, old);
    }
    // Non-.db files inside recent/ are not candidates either.
    const notes = path.join(recent, "notes-2026-10-01.txt");
    fs.writeFileSync(notes, "keep me");
    fs.utimesSync(notes, old, old);

    const r = await roll();
    expect(r.rolled).toHaveLength(2);
    for (const p of [...outside, notes]) expect(fs.readFileSync(p, "utf8")).toBe("keep me");
    expect(fs.readdirSync(archives).sort()).toEqual(["2026-10.sha256", "2026-10.tar.zst"]);
  });
});
