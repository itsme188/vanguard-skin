import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RECENT_BACKUPS_KEPT,
  DEFAULT_BACKUP_DIRNAME,
  resolveBackupHome,
  backupPaths,
  backupStamp,
  backupFileName,
  archiveMonth,
  isLiveDatabase,
  resolveLiveDbPath,
} from "@/lib/backup/backup-home";

describe("backup home and naming", () => {
  it("exposes the retention constants", () => {
    expect(RECENT_BACKUPS_KEPT).toBe(3);
    expect(DEFAULT_BACKUP_DIRNAME).toBe("portfolio-desk-backups");
  });
  it("uses VANGUARD_BACKUP_DIR when set", () => {
    expect(resolveBackupHome({ VANGUARD_BACKUP_DIR: "/tmp/x" }, "/Users/u")).toBe("/tmp/x");
  });
  it("resolves a relative VANGUARD_BACKUP_DIR under the home directory, never the cwd", () => {
    const r = resolveBackupHome({ VANGUARD_BACKUP_DIR: "rel/backups" }, "/Users/u");
    expect(r).toBe("/Users/u/rel/backups");
    expect(r.startsWith(process.cwd())).toBe(false);
  });
  it("defaults to a folder in the home directory, never inside the project", () => {
    expect(resolveBackupHome({}, "/Users/u")).toBe("/Users/u/portfolio-desk-backups");
  });
  it("lays out the backup folder", () => {
    expect(backupPaths("/b")).toEqual({
      recent: "/b/recent",
      archives: "/b/archives",
      log: "/b/backup-log.jsonl",
      rollLock: "/b/.roll.lock",
    });
  });
  it("stamps in Eastern time", () => {
    expect(backupStamp(new Date("2026-11-16T15:27:57Z"))).toBe("2026-11-16_10-27-57");
  });
  it("names a backup and never doubles the prefix", () => {
    const now = new Date("2026-11-16T15:27:57Z");
    expect(backupFileName("etf-type-repair", now)).toBe("pre-etf-type-repair-2026-11-16_10-27-57.db");
    expect(backupFileName("pre-etf-type-repair", now)).toBe("pre-etf-type-repair-2026-11-16_10-27-57.db");
  });
  it("rejects a purpose that is not a plain slug", () => {
    expect(() => backupFileName("../x", new Date())).toThrow();
    expect(() => backupFileName("a b", new Date())).toThrow();
  });
  it("rejects a bare pre- purpose but accepts pre as a slug", () => {
    const now = new Date("2026-11-16T15:27:57Z");
    expect(() => backupFileName("pre-", now)).toThrow();
    expect(backupFileName("pre", now)).toBe("pre-pre-2026-11-16_10-27-57.db");
  });
  it("returns no archive month for an impossible month or day", () => {
    expect(archiveMonth("pre-x-2026-13-01.db")).toBeNull();
    expect(archiveMonth("pre-x-2026-00-10.db")).toBeNull();
    expect(archiveMonth("pre-x-2026-05-32.db")).toBeNull();
    expect(archiveMonth("pre-x-2026-05-00.db")).toBeNull();
  });
  it("reads the archive month from old and new name styles", () => {
    expect(archiveMonth("pre-x-2026-11-16_10-27-57.db")).toBe("2026-11");
    expect(archiveMonth("pre-x-2026-10-27T03-54-23.369Z.db")).toBe("2026-10");
    expect(archiveMonth("pre-x-2026-08-10.db")).toBe("2026-08");
    expect(archiveMonth("rehearse-089.db")).toBeNull();
  });
  it("takes the LAST date in the name, so a date inside the purpose is ignored", () => {
    expect(archiveMonth("pre-fix-2026-01-05-rows-2026-11-16_10-27-57.db")).toBe("2026-11");
    expect(archiveMonth("pre-fix-2026-01-05-rows-2026-13-40.db")).toBe("2026-01");
  });
});

describe("the live database", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backup-live-")));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function touchDb(file: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "synthetic");
    return file;
  }

  describe("resolveLiveDbPath", () => {
    it("uses VANGUARD_LIVE_DB_PATH when set", () => {
      const moduleDir = path.join(tmp, "main", "lib", "backup");
      fs.mkdirSync(path.join(tmp, "main", ".git"), { recursive: true });
      fs.mkdirSync(moduleDir, { recursive: true });
      expect(resolveLiveDbPath({ VANGUARD_LIVE_DB_PATH: path.join(tmp, "x", "..", "y.db") }, moduleDir)).toBe(
        path.join(tmp, "y.db"),
      );
    });

    it("finds the main checkout from the module's own folder", () => {
      const moduleDir = path.join(tmp, "main", "lib", "backup");
      fs.mkdirSync(path.join(tmp, "main", ".git"), { recursive: true });
      fs.mkdirSync(moduleDir, { recursive: true });
      expect(resolveLiveDbPath({}, moduleDir)).toBe(path.join(tmp, "main", "data", "vanguard.db"));
    });

    it("finds the MAIN checkout from inside a linked worktree", () => {
      const gitdir = path.join(tmp, "main", ".git", "worktrees", "wt");
      fs.mkdirSync(gitdir, { recursive: true });
      fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
      const moduleDir = path.join(tmp, "wt", "lib", "backup");
      fs.mkdirSync(moduleDir, { recursive: true });
      fs.writeFileSync(path.join(tmp, "wt", ".git"), `gitdir: ${gitdir}\n`);
      expect(resolveLiveDbPath({}, moduleDir)).toBe(path.join(tmp, "main", "data", "vanguard.db"));
    });

    it("returns null when no .git is found", () => {
      const moduleDir = path.join(tmp, "loose", "lib", "backup");
      fs.mkdirSync(moduleDir, { recursive: true });
      expect(resolveLiveDbPath({}, moduleDir)).toBeNull();
    });

    it("from this checkout, finds a main checkout (a folder with a .git DIRECTORY), read-only", () => {
      const live = resolveLiveDbPath({});
      expect(live).not.toBeNull();
      expect(live!.endsWith(`${path.sep}data${path.sep}vanguard.db`)).toBe(true);
      const mainRoot = path.dirname(path.dirname(live!));
      expect(fs.statSync(path.join(mainRoot, ".git")).isDirectory()).toBe(true);
    });
  });

  describe("isLiveDatabase", () => {
    it("is true for the same file reached through a symlinked folder", () => {
      const live = touchDb(path.join(tmp, "main", "data", "vanguard.db"));
      const link = path.join(tmp, "link");
      fs.symlinkSync(path.join(tmp, "main", "data"), link);
      expect(isLiveDatabase(path.join(link, "vanguard.db"), { VANGUARD_LIVE_DB_PATH: live })).toBe(true);
    });

    it("is false for a different file with the same name", () => {
      const live = touchDb(path.join(tmp, "main", "data", "vanguard.db"));
      const other = touchDb(path.join(tmp, "wt", "data", "vanguard.db"));
      expect(isLiveDatabase(other, { VANGUARD_LIVE_DB_PATH: live })).toBe(false);
    });

    it("is false for :memory: and an empty name", () => {
      const live = touchDb(path.join(tmp, "main", "data", "vanguard.db"));
      expect(isLiveDatabase(":memory:", { VANGUARD_LIVE_DB_PATH: live })).toBe(false);
      expect(isLiveDatabase("", { VANGUARD_LIVE_DB_PATH: live })).toBe(false);
    });

    it("is false when the live file does not exist", () => {
      const live = path.join(tmp, "main", "data", "vanguard.db");
      expect(isLiveDatabase(live, { VANGUARD_LIVE_DB_PATH: live })).toBe(false);
    });

    it("is false when no live path can be found", () => {
      const db = touchDb(path.join(tmp, "loose", "data", "vanguard.db"));
      const moduleDir = path.join(tmp, "loose", "lib", "backup");
      fs.mkdirSync(moduleDir, { recursive: true });
      expect(isLiveDatabase(db, {}, moduleDir)).toBe(false);
    });

    it("ignores the working folder, DATABASE_PATH and VANGUARD_DB_DIR", () => {
      const live = touchDb(path.join(tmp, "main", "data", "vanguard.db"));
      const scratch = touchDb(path.join(tmp, "scratch", "vanguard.db"));
      expect(path.relative(process.cwd(), live).startsWith("..")).toBe(true);
      // The live file is live from an unrelated working folder.
      expect(isLiveDatabase(live, { VANGUARD_LIVE_DB_PATH: live })).toBe(true);
      // A database named by DATABASE_PATH / VANGUARD_DB_DIR is not live because of it.
      expect(isLiveDatabase(scratch, { VANGUARD_LIVE_DB_PATH: live, DATABASE_PATH: scratch })).toBe(false);
      expect(
        isLiveDatabase(scratch, { VANGUARD_LIVE_DB_PATH: live, VANGUARD_DB_DIR: path.dirname(scratch) }),
      ).toBe(false);
    });
  });
});
