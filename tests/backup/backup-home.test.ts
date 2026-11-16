import { describe, expect, it } from "vitest";
import {
  RECENT_BACKUPS_KEPT,
  DEFAULT_BACKUP_DIRNAME,
  resolveBackupHome,
  backupPaths,
  backupStamp,
  backupFileName,
  archiveMonth,
  isLiveDatabase,
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
  it("knows the live database from a copy", () => {
    const env = { VANGUARD_DB_DIR: "/d" };
    expect(isLiveDatabase("/d/vanguard.db", env, "/repo")).toBe(true);
    expect(isLiveDatabase("/tmp/rehearsal.db", env, "/repo")).toBe(false);
  });
});
