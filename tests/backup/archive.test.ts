import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ZSTD_LEVEL,
  ZSTD_LONG,
  addToArchive,
  extractMember,
  findZstd,
  listArchiveMembers,
  readManifest,
  sha256File,
} from "@/lib/backup/archive";

const ZSTD = findZstd();
const noZstd = ZSTD === null;

let dir: string;
let src: string;
let archives: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-test-"));
  src = path.join(dir, "src");
  archives = path.join(dir, "archives");
  fs.mkdirSync(src);
  fs.mkdirSync(archives);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A small real SQLite file with synthetic rows. */
function makeDb(name: string, rows = 300, salt = 0): string {
  const p = path.join(src, name);
  const db = new Database(p);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT, amount REAL)");
  const ins = db.prepare("INSERT INTO t (label, amount) VALUES (?, ?)");
  db.transaction(() => {
    for (let i = 0; i < rows; i++) ins.run(`row-${i}-${salt}`, i + salt / 10);
  })();
  db.close();
  return p;
}

/** Member names as `bsdtar -t` reports them (which hides `._` entries). */
function bsdtarList(archive: string): string[] {
  const z = spawnSync(ZSTD as string, ["-dc", `--long=${ZSTD_LONG}`, archive]);
  expect(z.status).toBe(0);
  const t = spawnSync("/usr/bin/tar", ["-tf", "-"], { input: z.stdout });
  expect(t.status).toBe(0);
  return t.stdout.toString().split("\n").filter(Boolean);
}

/** Every raw member name, `._` entries included. */
const listMembers = (archive: string) => listArchiveMembers(archive, ZSTD as string);

function sha(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

describe("archive", () => {
  it("exposes the compression settings", () => {
    expect(ZSTD_LEVEL).toBe(10);
    expect(ZSTD_LONG).toBe(31);
  });

  it("findZstd honours the passed PATH before the fallbacks", () => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const fake = path.join(bin, "zstd");
    fs.writeFileSync(fake, "#!/bin/sh\n");
    fs.chmodSync(fake, 0o755);
    expect(findZstd({ PATH: bin })).toBe(fake);
  });

  it.skipIf(noZstd)("round-trips: every member comes back byte-identical", async () => {
    const files = [makeDb("a-2026-10-01.db", 300, 1), makeDb("b-2026-10-02.db", 300, 2)];
    const archive = path.join(archives, "2026-10.tar.zst");
    const manifest = path.join(archives, "2026-10.sha256");
    await addToArchive(archive, manifest, files, ZSTD as string);

    expect(await listMembers(archive)).toEqual(["a-2026-10-01.db", "b-2026-10-02.db"]);
    expect(bsdtarList(archive)).toEqual(["a-2026-10-01.db", "b-2026-10-02.db"]);
    const m = readManifest(manifest);
    for (const f of files) {
      const name = path.basename(f);
      expect(m.get(name)).toBe(await sha256File(f));
      const out = path.join(dir, `out-${name}`);
      await extractMember(archive, name, out, ZSTD as string);
      expect(sha(out)).toBe(sha(f));
    }
    await expect(
      extractMember(archive, "missing.db", path.join(dir, "out-missing"), ZSTD as string),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, "out-missing"))).toBe(false);
  });

  it.skipIf(noZstd)("adding to an existing archive keeps the old members and adds the new ones", async () => {
    const archive = path.join(archives, "2026-10.tar.zst");
    const manifest = path.join(archives, "2026-10.sha256");
    const a = makeDb("a-2026-10-01.db", 300, 1);
    const b = makeDb("b-2026-10-02.db", 300, 2);
    await addToArchive(archive, manifest, [a, b], ZSTD as string);
    const c = makeDb("c-2026-10-03.db", 300, 3);
    const d = makeDb("d-2026-10-04.db", 300, 4);
    await addToArchive(archive, manifest, [c, d], ZSTD as string);

    const names = ["a-2026-10-01.db", "b-2026-10-02.db", "c-2026-10-03.db", "d-2026-10-04.db"];
    expect(await listMembers(archive)).toEqual(names);
    expect([...readManifest(manifest).keys()]).toEqual(names);
    for (const f of [a, b, c, d]) {
      const out = path.join(dir, `out-${path.basename(f)}`);
      await extractMember(archive, path.basename(f), out, ZSTD as string);
      expect(sha(out)).toBe(sha(f));
    }
  });

  it.skipIf(noZstd)("skips a file already in the manifest with the same checksum", async () => {
    const archive = path.join(archives, "2026-10.tar.zst");
    const manifest = path.join(archives, "2026-10.sha256");
    const a = makeDb("a-2026-10-01.db", 300, 1);
    await addToArchive(archive, manifest, [a], ZSTD as string);
    const b = makeDb("b-2026-10-02.db", 300, 2);
    await addToArchive(archive, manifest, [a, b], ZSTD as string);
    expect(await listMembers(archive)).toEqual(["a-2026-10-01.db", "b-2026-10-02.db"]);
    expect(readManifest(manifest).size).toBe(2);
  });

  it.skipIf(noZstd)(
    "throws on the same name with a different checksum and leaves the archive untouched",
    async () => {
      const archive = path.join(archives, "2026-10.tar.zst");
      const manifest = path.join(archives, "2026-10.sha256");
      const a = makeDb("a-2026-10-01.db", 300, 1);
      await addToArchive(archive, manifest, [a], ZSTD as string);
      const archiveBefore = sha(archive);
      const manifestBefore = fs.readFileSync(manifest, "utf8");

      fs.rmSync(a);
      makeDb("a-2026-10-01.db", 300, 99); // same name, different content
      await expect(addToArchive(archive, manifest, [a], ZSTD as string)).rejects.toThrow(/checksum/);
      expect(sha(archive)).toBe(archiveBefore);
      expect(fs.readFileSync(manifest, "utf8")).toBe(manifestBefore);
    },
  );

  it.skipIf(noZstd)("records, without re-adding, a member archived but missing from the manifest", async () => {
    // A run that died after renaming the archive but before renaming the manifest.
    const archive = path.join(archives, "2026-10.tar.zst");
    const manifest = path.join(archives, "2026-10.sha256");
    const a = makeDb("a-2026-10-01.db", 300, 1);
    await addToArchive(archive, manifest, [a], ZSTD as string);
    fs.writeFileSync(manifest, "");
    const b = makeDb("b-2026-10-02.db", 300, 2);
    await addToArchive(archive, manifest, [a, b], ZSTD as string);
    expect(await listMembers(archive)).toEqual(["a-2026-10-01.db", "b-2026-10-02.db"]);
    expect(readManifest(manifest).get("a-2026-10-01.db")).toBe(await sha256File(a));

    // Same situation, but the loose file no longer matches the archived copy.
    fs.writeFileSync(manifest, "");
    fs.rmSync(a);
    makeDb("a-2026-10-01.db", 300, 99);
    await expect(addToArchive(archive, manifest, [a], ZSTD as string)).rejects.toThrow(/checksum/);
    expect(fs.readFileSync(manifest, "utf8")).toBe("");
  });

  it.skipIf(noZstd)("writes no ._ metadata members", async () => {
    const files = [makeDb("a-2026-10-01.db"), makeDb("b-2026-10-02.db")];
    // Extended attributes are what make macOS tar emit a ._ member per file.
    for (const f of files) spawnSync("/usr/bin/xattr", ["-w", "com.example.test", "x", f]);

    // Control: plain system tar on the same files DOES write ._ members, and
    // the listing used below sees them even though `bsdtar -t` hides them.
    const tarred = spawnSync("/usr/bin/tar", ["-cf", "-", "-C", src, "a-2026-10-01.db"], {
      env: { ...process.env, PATH: "/usr/bin:/bin", COPYFILE_DISABLE: undefined },
    });
    expect(tarred.status).toBe(0);
    const control = path.join(dir, "control.tar.zst");
    const z = spawnSync(ZSTD as string, ["-q", `--long=${ZSTD_LONG}`, "-o", control], { input: tarred.stdout });
    expect(z.status).toBe(0);
    expect(await listMembers(control)).toEqual(["._a-2026-10-01.db", "a-2026-10-01.db"]);
    expect(bsdtarList(control)).toEqual(["a-2026-10-01.db"]);

    const archive = path.join(archives, "2026-10.tar.zst");
    await addToArchive(archive, path.join(archives, "2026-10.sha256"), files, ZSTD as string);
    const c = makeDb("c-2026-10-03.db");
    spawnSync("/usr/bin/xattr", ["-w", "com.example.test", "x", c]);
    await addToArchive(archive, path.join(archives, "2026-10.sha256"), [c], ZSTD as string);

    const members = await listMembers(archive);
    expect(members).toEqual(["a-2026-10-01.db", "b-2026-10-02.db", "c-2026-10-03.db"]);
    expect(members.filter((m) => path.basename(m).startsWith("._"))).toEqual([]);
  });

  it.skipIf(noZstd)("leaves no .new or temp files behind on success or on failure", async () => {
    const archive = path.join(archives, "2026-10.tar.zst");
    const manifest = path.join(archives, "2026-10.sha256");
    await addToArchive(archive, manifest, [makeDb("a-2026-10-01.db")], ZSTD as string);
    await addToArchive(archive, manifest, [makeDb("b-2026-10-02.db")], ZSTD as string);
    expect(fs.readdirSync(archives).sort()).toEqual(["2026-10.sha256", "2026-10.tar.zst"]);

    // Failure: a truncated old archive makes `zstd -d` fail in the middle of the pipeline.
    const full = fs.readFileSync(archive);
    fs.writeFileSync(archive, full.subarray(0, Math.floor(full.length / 2)));
    const truncated = sha(archive);
    await expect(
      addToArchive(archive, manifest, [makeDb("c-2026-10-03.db")], ZSTD as string),
    ).rejects.toThrow();
    expect(fs.readdirSync(archives).sort()).toEqual(["2026-10.sha256", "2026-10.tar.zst"]);
    expect(sha(archive)).toBe(truncated);
    expect([...readManifest(manifest).keys()]).toEqual(["a-2026-10-01.db", "b-2026-10-02.db"]);
  });

  it.skipIf(noZstd)(
    "three near-identical 5 MB files compress to less than twice one file's compressed size",
    async () => {
      const base = path.join(src, "big-2026-10-01.db");
      const db = new Database(base);
      db.exec("CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)");
      const ins = db.prepare("INSERT INTO blobs (data) VALUES (?)");
      db.transaction(() => {
        for (let i = 0; i < 1280; i++) ins.run(crypto.randomBytes(4096));
      })();
      db.close();
      expect(fs.statSync(base).size).toBeGreaterThan(5_000_000);

      const copies = [base];
      for (const n of [2, 3]) {
        const p = path.join(src, `big-2026-10-0${n}.db`);
        fs.copyFileSync(base, p);
        const c = new Database(p);
        c.prepare("UPDATE blobs SET data = ? WHERE id = ?").run(Buffer.from(`changed-${n}`), n * 7);
        c.close();
        copies.push(p);
      }

      const one = path.join(archives, "one.tar.zst");
      await addToArchive(one, path.join(archives, "one.sha256"), [base], ZSTD as string);
      const three = path.join(archives, "three.tar.zst");
      await addToArchive(three, path.join(archives, "three.sha256"), copies, ZSTD as string);

      const oneSize = fs.statSync(one).size;
      expect(oneSize).toBeGreaterThan(4_000_000); // random bytes: no shrinking alone
      expect(fs.statSync(three).size).toBeLessThan(2 * oneSize);
    },
    60_000,
  );
});
