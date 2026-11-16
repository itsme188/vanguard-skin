import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { addToArchive, findZstd, sha256File } from "@/lib/backup/archive";
import { parseBackupArgs } from "../../scripts/backup-db";
import { runRestoreTest } from "../../scripts/backup-restore-test";
import { syncToVolume } from "../../scripts/backup-usb-sync";

const zstd = findZstd();
const hasZstd = zstd !== null;

let root: string;
let home: string;
let volume: string;

function makeDb(file: string, tables: number): void {
  const db = new Database(file);
  db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY)");
  db.exec("INSERT INTO schema_migrations (id) VALUES (1), (2)");
  for (let i = 1; i < tables; i++) db.exec(`CREATE TABLE t${i} (x INTEGER)`);
  db.close();
}

async function archiveOf(name: string, files: string[]): Promise<{ archive: string; manifest: string }> {
  const archives = path.join(home, "archives");
  fs.mkdirSync(archives, { recursive: true });
  const archive = path.join(archives, `${name}.tar.zst`);
  const manifest = path.join(archives, `${name}.sha256`);
  await addToArchive(archive, manifest, files, zstd as string);
  return { archive, manifest };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-commands-"));
  home = path.join(root, "home");
  volume = path.join(root, "volume");
  fs.mkdirSync(home);
  fs.mkdirSync(volume);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("backup-db arguments", () => {
  it("requires --purpose and reads --db", () => {
    expect(parseBackupArgs([])).toBeNull();
    expect(parseBackupArgs(["--purpose"])).toBeNull();
    expect(parseBackupArgs(["--purpose", "x"])).toEqual({ purpose: "x", db: null });
    expect(parseBackupArgs(["--db", "/a/b.db", "--purpose", "x"])).toEqual({ purpose: "x", db: "/a/b.db" });
  });
});

describe("restore test", () => {
  it.skipIf(!hasZstd)("restore test passes on a good archive and reports counts", async () => {
    const src = path.join(root, "pre-a-2026-01-02_03-04-05.db");
    makeDb(src, 3);
    await archiveOf("2026-01", [src]);
    const r = await runRestoreTest(home, zstd);
    expect(r).toMatchObject({ ok: true, member: path.basename(src), tables: 3, migrations: 2 });
  });

  it.skipIf(!hasZstd)("restore test fails with exit data when a member's checksum does not match the manifest", async () => {
    const src = path.join(root, "pre-a-2026-01-02_03-04-05.db");
    makeDb(src, 2);
    const { manifest } = await archiveOf("2026-01", [src]);
    fs.writeFileSync(manifest, `${"0".repeat(64)}  ${path.basename(src)}\n`);
    const r = await runRestoreTest(home, zstd);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/checksum mismatch/);
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("backup-restore-test-"))).toEqual([]);
  });

  it.skipIf(!hasZstd)("restore test handles the legacy archive whose member names contain folders", async () => {
    const tree = path.join(root, "tree");
    fs.mkdirSync(path.join(tree, "data", "backups"), { recursive: true });
    const member = "data/backups/pre-x-2026-01-02.db";
    makeDb(path.join(tree, member), 4);
    const archives = path.join(home, "archives");
    fs.mkdirSync(archives);
    const name = "portfolio-desk-backups-through-2026-11-16";
    const tar = path.join(root, "legacy.tar");
    execFileSync("/usr/bin/tar", ["-cf", tar, "--no-mac-metadata", "-C", tree, member], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    execFileSync(zstd as string, ["-q", "--long=31", tar, "-o", path.join(archives, `${name}.tar.zst`)]);
    const sum = await sha256File(path.join(tree, member));
    fs.writeFileSync(path.join(archives, `${name}.sha256`), `${sum}  ${member}\n`);
    const r = await runRestoreTest(home, zstd);
    expect(r).toMatchObject({ ok: true, member, tables: 4, migrations: 2 });
  });

  it("falls back to the newest .db in recent/ when there is no archive", async () => {
    const recent = path.join(home, "recent");
    fs.mkdirSync(recent);
    makeDb(path.join(recent, "pre-a-2026-01-02_03-04-05.db"), 2);
    const r = await runRestoreTest(home, null);
    expect(r).toMatchObject({ ok: true, archive: null, tables: 2, migrations: 2 });
  });

  it("fails clearly with nothing to test, and when zstd is missing", async () => {
    expect(await runRestoreTest(home, null)).toMatchObject({ ok: false, archive: null });
    fs.mkdirSync(path.join(home, "archives"));
    fs.writeFileSync(path.join(home, "archives", "2026-01.tar.zst"), "x");
    const r = await runRestoreTest(home, null);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/zstd/);
  });
});

describe("usb sync", () => {
  const dest = () => path.join(volume, "Portfolio Desk Backups");

  async function twoFiles(): Promise<void> {
    const archives = path.join(home, "archives");
    fs.mkdirSync(archives);
    fs.writeFileSync(path.join(archives, "2026-01.tar.zst"), "archive-one");
    fs.writeFileSync(path.join(archives, "2026-01.sha256"), "manifest");
    fs.writeFileSync(path.join(home, "HOW-TO-RESTORE.txt"), "steps");
  }

  it("usb sync copies new archives and verifies them", async () => {
    await twoFiles();
    const r = await syncToVolume(home, volume);
    expect(r.copied.sort()).toEqual(["2026-01.sha256", "2026-01.tar.zst", "HOW-TO-RESTORE.txt"]);
    expect(fs.readFileSync(path.join(dest(), "2026-01.tar.zst"), "utf8")).toBe("archive-one");
    expect(fs.readFileSync(path.join(home, ".usb-last-sync"), "utf8").trim()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("usb sync skips a file that is already identical", async () => {
    await twoFiles();
    await syncToVolume(home, volume);
    fs.writeFileSync(path.join(home, "archives", "2026-01.sha256"), "manifest-2");
    const r = await syncToVolume(home, volume);
    expect(r.copied).toEqual(["2026-01.sha256"]);
    expect(r.skipped.sort()).toEqual(["2026-01.tar.zst", "HOW-TO-RESTORE.txt"]);
  });

  it("usb sync never deletes other files on the volume", async () => {
    await twoFiles();
    fs.mkdirSync(dest());
    fs.writeFileSync(path.join(dest(), "someone-elses.txt"), "keep");
    await syncToVolume(home, volume);
    expect(fs.readFileSync(path.join(dest(), "someone-elses.txt"), "utf8")).toBe("keep");
  });

  it("usb sync refuses a file larger than 4 GB with a message naming FAT32", async () => {
    await twoFiles();
    await expect(syncToVolume(home, volume, { maxFileBytes: 5 })).rejects.toThrow(/FAT32/);
    expect(fs.existsSync(dest())).toBe(false);
    expect(fs.existsSync(path.join(home, ".usb-last-sync"))).toBe(false);
  });

  it("usb sync refuses a volume folder that does not exist", async () => {
    await twoFiles();
    await expect(syncToVolume(home, path.join(root, "nope"))).rejects.toThrow(/does not exist/);
  });
});
