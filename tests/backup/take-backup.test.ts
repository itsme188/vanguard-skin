import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeBackup } from "@/lib/backup/take-backup";
import { backupPaths } from "@/lib/backup/backup-home";
import { RESTORE_NOTES_NAME } from "@/lib/backup/restore-notes";

const NOW = new Date("2026-03-05T15:00:00Z");

let tmp: string;
let liveDir: string;
let home: string;
let lines: string[];
const log = (l: string) => lines.push(l);

function seed(db: Database.Database, withMigrations = true): void {
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)");
  db.exec("INSERT INTO t (n) VALUES (1), (2), (3)");
  if (withMigrations) {
    db.exec("CREATE TABLE schema_migrations (id TEXT)");
    db.exec("INSERT INTO schema_migrations VALUES ('a'), ('b')");
  }
}

function openLive(withMigrations = true): Database.Database {
  const db = new Database(path.join(liveDir, "vanguard.db"));
  seed(db, withMigrations);
  return db;
}

/** Marks `<liveDir>/vanguard.db` as the owner's real database for this test. */
const liveEnv = () => ({ VANGUARD_LIVE_DB_PATH: path.join(liveDir, "vanguard.db"), VANGUARD_BACKUP_DIR: home });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "take-backup-")));
  liveDir = path.join(tmp, "live");
  home = path.join(tmp, "home");
  fs.mkdirSync(liveDir);
  lines = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("takeBackup", () => {
  it("writes a valid database copy and returns its path and size", async () => {
    const db = new Database(":memory:");
    seed(db);
    const dir = path.join(tmp, "out");
    const res = await takeBackup(db, { purpose: "unit", now: NOW, backupDir: dir, log });
    expect(path.dirname(res.path)).toBe(dir);
    expect(res.sizeBytes).toBe(fs.statSync(res.path).size);
    expect(res.sizeBytes).toBeGreaterThan(0);
    const copy = new Database(res.path, { readonly: true });
    expect((copy.prepare("SELECT count(*) AS c FROM t").get() as { c: number }).c).toBe(3);
    copy.close();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".partial"))).toEqual([]);
    db.close();
  });

  it("refuses when the target already exists and writes nothing", async () => {
    const db = new Database(":memory:");
    seed(db);
    const dir = path.join(tmp, "out");
    const first = await takeBackup(db, { purpose: "unit", now: NOW, backupDir: dir, log });
    const before = fs.readFileSync(first.path);
    await expect(takeBackup(db, { purpose: "unit", now: NOW, backupDir: dir, log })).rejects.toThrow(/already exists/);
    expect(fs.readdirSync(dir)).toEqual([path.basename(first.path)]);
    expect(fs.readFileSync(first.path).equals(before)).toBe(true);
    db.close();
  });

  it("throws for :memory: with no backupDir", async () => {
    const db = new Database(":memory:");
    await expect(takeBackup(db, { purpose: "unit", now: NOW, env: liveEnv(), log })).rejects.toThrow(/backupDir/);
    expect(fs.existsSync(home)).toBe(false);
    db.close();
  });

  it("puts a live-database backup in <home>/recent and logs one line", async () => {
    const db = openLive();
    const roll = vi.fn().mockResolvedValue({ rolled: [], kept: [] });
    const res = await takeBackup(db, {
      purpose: "repair-thing", now: NOW, env: liveEnv(), script: "fix.ts", roll, log,
    });
    const { recent, log: logFile } = backupPaths(home);
    expect(path.dirname(res.path)).toBe(recent);
    expect(roll).toHaveBeenCalledWith(home);
    expect(res.rolled).toBe(true);
    const entries = fs.readFileSync(logFile, "utf8").trim().split("\n");
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0])).toEqual({
      file: res.path,
      purpose: "repair-thing",
      script: "fix.ts",
      takenAt: NOW.toISOString(),
      sizeBytes: res.sizeBytes,
      migrations: 2,
      source: path.join(liveDir, "vanguard.db"),
    });
    db.close();
  });

  it("records migrations as null when schema_migrations is absent", async () => {
    const db = openLive(false);
    await takeBackup(db, { purpose: "unit", now: NOW, env: liveEnv(), roll: () => ({ rolled: [], kept: [] }), log });
    const entry = JSON.parse(fs.readFileSync(backupPaths(home).log, "utf8").trim());
    expect(entry.migrations).toBeNull();
    db.close();
  });

  it("puts a rehearsal copy's backup beside the copy, logs nothing, never rolls", async () => {
    const copyDir = path.join(tmp, "rehearsal");
    fs.mkdirSync(copyDir);
    const db = new Database(path.join(copyDir, "copy.db"));
    seed(db);
    const roll = vi.fn();
    const res = await takeBackup(db, { purpose: "unit", now: NOW, env: liveEnv(), roll, log });
    expect(path.dirname(res.path)).toBe(path.join(copyDir, "backups"));
    expect(res.rolled).toBe(false);
    expect(roll).not.toHaveBeenCalled();
    expect(fs.existsSync(home)).toBe(false);
    db.close();
  });

  it("throws when the backup folder cannot be created", async () => {
    const db = new Database(":memory:");
    seed(db);
    const blocker = path.join(tmp, "a-file");
    fs.writeFileSync(blocker, "x");
    const dir = path.join(blocker, "sub");
    await expect(takeBackup(db, { purpose: "unit", now: NOW, backupDir: dir, log })).rejects.toThrow();
    expect(fs.readFileSync(blocker, "utf8")).toBe("x");
    expect(fs.readdirSync(tmp).filter((f) => f.includes(".partial"))).toEqual([]);
    db.close();
  });

  function memDb(): Database.Database {
    const db = new Database(":memory:");
    seed(db);
    return db;
  }
  const leftovers = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".partial"));

  it("removes the partial and writes no target when the finishing step throws", async () => {
    const db = memDb();
    const dir = path.join(tmp, "out");
    const spy = vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw new Error("link boom");
    });
    await expect(takeBackup(db, { purpose: "unit", now: NOW, backupDir: dir, log })).rejects.toThrow(/link boom/);
    spy.mockRestore();
    expect(fs.readdirSync(dir)).toEqual([]);
    db.close();
  });

  it("refuses without clobbering when the target appears before the finish", async () => {
    const db = memDb();
    const dir = path.join(tmp, "out");
    const realLink = fs.linkSync;
    const spy = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      fs.writeFileSync(to, "precious");
      realLink(from, to);
    });
    await expect(takeBackup(db, { purpose: "unit", now: NOW, backupDir: dir, log })).rejects.toThrow(/already exists/);
    spy.mockRestore();
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, files[0]), "utf8")).toBe("precious");
    db.close();
  });

  it("rejects an invalid copy: no target, no partial", async () => {
    const db = memDb();
    const dir = path.join(tmp, "out");
    const realFsync = fs.fsyncSync;
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      realFsync(fd);
      const part = leftovers(dir)[0];
      fs.writeFileSync(path.join(dir, part), "this is not a database, just garbage text padding ".repeat(50));
    });
    await expect(takeBackup(db, { purpose: "unit", now: NOW, backupDir: dir, log })).rejects.toThrow();
    spy.mockRestore();
    expect(fs.readdirSync(dir)).toEqual([]);
    db.close();
  });

  it("fails cleanly when VACUUM INTO itself fails", async () => {
    const db = memDb();
    const dir = path.join(tmp, "out");
    db.exec("BEGIN");
    await expect(takeBackup(db, { purpose: "unit", now: NOW, backupDir: dir, log })).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
    db.exec("ROLLBACK");
    db.close();
  });

  it("uses its own partial name and never deletes another run's partial", async () => {
    const db = memDb();
    const dir = path.join(tmp, "out");
    fs.mkdirSync(dir);
    // The name a concurrent run with the same purpose in the same second used to share.
    const other = path.join(dir, "pre-unit-2026-03-05_10-00-00.db.partial");
    fs.writeFileSync(other, "another run's copy in progress");
    const seen: string[] = [];
    const realFsync = fs.fsyncSync;
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      seen.push(...leftovers(dir));
      realFsync(fd);
    });
    const res = await takeBackup(db, { purpose: "unit", now: NOW, backupDir: dir, log });
    spy.mockRestore();
    expect(fs.readFileSync(other, "utf8")).toBe("another run's copy in progress");
    expect(fs.existsSync(res.path)).toBe(true);
    const ours = seen.filter((n) => n !== path.basename(other));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((n) => n.startsWith(`${path.basename(res.path)}.`) && n.endsWith(".partial"))).toBe(true);
    expect(leftovers(dir)).toEqual([path.basename(other)]);
    db.close();
  });

  it("throws before returning when the home cannot be created", async () => {
    const db = openLive();
    const blocker = path.join(tmp, "a-file");
    fs.writeFileSync(blocker, "x");
    const env = { VANGUARD_LIVE_DB_PATH: path.join(liveDir, "vanguard.db"), VANGUARD_BACKUP_DIR: path.join(blocker, "home") };
    await expect(takeBackup(db, { purpose: "unit", now: NOW, env, roll: vi.fn(), log })).rejects.toThrow();
    db.close();
  });

  it("still returns the backup when the roll throws, with rolled false", async () => {
    const db = openLive();
    const roll = vi.fn().mockRejectedValue(new Error("disk on fire"));
    const res = await takeBackup(db, { purpose: "unit", now: NOW, env: liveEnv(), roll, log });
    expect(res.rolled).toBe(false);
    expect(fs.existsSync(res.path)).toBe(true);
    expect(lines).toContain("backup taken; roll skipped: disk on fire");
    db.close();
  });

  it("live file opened by an absolute path from an unrelated working folder: recent/, logged, rolled", async () => {
    const db = openLive();
    expect(path.relative(process.cwd(), liveDir).startsWith("..")).toBe(true);
    const roll = vi.fn().mockResolvedValue({ rolled: [], kept: [] });
    const res = await takeBackup(db, { purpose: "unit", now: NOW, env: liveEnv(), roll, log });
    expect(path.dirname(res.path)).toBe(backupPaths(home).recent);
    expect(roll).toHaveBeenCalledWith(home);
    const entry = JSON.parse(fs.readFileSync(backupPaths(home).log, "utf8").trim());
    expect(entry.source).toBe(fs.realpathSync(path.join(liveDir, "vanguard.db")));
    db.close();
  });

  it("a scratch database pinned through DATABASE_PATH is not live: beside it, no log, no roll", async () => {
    openLive().close();
    const scratchDir = path.join(tmp, "scratch");
    fs.mkdirSync(scratchDir);
    const scratch = path.join(scratchDir, "vanguard.db");
    const db = new Database(scratch);
    seed(db);
    const roll = vi.fn();
    const env = { ...liveEnv(), DATABASE_PATH: scratch };
    const res = await takeBackup(db, { purpose: "unit", now: NOW, env, roll, log });
    expect(path.dirname(res.path)).toBe(path.join(scratchDir, "backups"));
    expect(roll).not.toHaveBeenCalled();
    expect(fs.existsSync(home)).toBe(false);
    db.close();
  });

  it("a worktree's seeded copy reached through VANGUARD_DB_DIR never lands in recent/", async () => {
    openLive().close();
    const wtData = path.join(tmp, "wt", "data");
    fs.mkdirSync(wtData, { recursive: true });
    const db = new Database(path.join(wtData, "vanguard.db"));
    seed(db);
    const roll = vi.fn();
    const env = { ...liveEnv(), VANGUARD_DB_DIR: wtData };
    const res = await takeBackup(db, { purpose: "unit", now: NOW, env, roll, log });
    expect(path.dirname(res.path)).toBe(path.join(wtData, "backups"));
    expect(roll).not.toHaveBeenCalled();
    expect(fs.existsSync(backupPaths(home).recent)).toBe(false);
    db.close();
  });

  it("refuses a second database inside the main data folder and writes nothing", async () => {
    openLive().close();
    const db = new Database(path.join(liveDir, "demo.db"));
    seed(db);
    const before = fs.readdirSync(liveDir).sort();
    const roll = vi.fn();
    await expect(takeBackup(db, { purpose: "unit", now: NOW, env: liveEnv(), roll, log })).rejects.toThrow(
      /never written under the project's data folder[\s\S]*VANGUARD_BACKUP_DIR/,
    );
    expect(fs.readdirSync(liveDir).sort()).toEqual(before);
    expect(fs.existsSync(home)).toBe(false);
    expect(roll).not.toHaveBeenCalled();
    db.close();
  });

  it("writes the restore notes into the home on a live backup", async () => {
    const db = openLive();
    await takeBackup(db, { purpose: "unit", now: NOW, env: liveEnv(), roll: vi.fn().mockResolvedValue({ rolled: [], kept: [] }), log });
    expect(fs.readFileSync(path.join(home, RESTORE_NOTES_NAME), "utf8")).toMatch(/--long=31/);
    db.close();
  });

  it("a restore-notes write failure never fails the backup", async () => {
    const db = openLive();
    fs.mkdirSync(path.join(home, RESTORE_NOTES_NAME), { recursive: true }); // a folder where the file goes
    const roll = vi.fn().mockResolvedValue({ rolled: [], kept: [] });
    const res = await takeBackup(db, { purpose: "unit", now: NOW, env: liveEnv(), roll, log });
    expect(fs.existsSync(res.path)).toBe(true);
    expect(roll).toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith("backup taken; restore notes not written:"))).toBe(true);
    db.close();
  });

  it("reports rolled false and logs the reason when the roll is skipped", async () => {
    const db = openLive();
    const roll = vi.fn().mockResolvedValue({ rolled: [], kept: [], skipped: "zstd not found" });
    const res = await takeBackup(db, { purpose: "unit", now: NOW, env: liveEnv(), roll, log });
    expect(res.rolled).toBe(false);
    expect(lines).toContain("backup taken; roll skipped: zstd not found");
    db.close();
  });
});
