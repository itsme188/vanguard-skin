import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EnvLike } from "../db/db-path";

/** zstd compression level for monthly archives. */
export const ZSTD_LEVEL = 10;
/** Long-distance window (2^31 bytes). Consecutive backups are nearly identical,
 *  so one stream with a long window stores each extra backup as a small diff.
 *  Decoding a stream written with it REQUIRES the same flag. */
export const ZSTD_LONG = 31;

/** bsdtar: the `@-` re-read and `--no-mac-metadata` are bsdtar features. */
const TAR = "/usr/bin/tar";
const ZSTD_FALLBACKS = ["/opt/homebrew/bin/zstd", "/usr/local/bin/zstd"];
/** Children get a minimal, explicit environment. COPYFILE_DISABLE stops macOS
 *  tar from adding a `._name` AppleDouble member per file. */
const CHILD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: process.env.NODE_ENV, // typed as required by Next; unused by tar and zstd
  PATH: "/usr/bin:/bin",
  COPYFILE_DISABLE: "1",
};
const STDERR_LIMIT = 16 * 1024;

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The zstd binary: first on `env.PATH`, then the Homebrew locations. */
export function findZstd(env: EnvLike = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, "zstd");
    if (isExecutable(p)) return p;
  }
  return ZSTD_FALLBACKS.find(isExecutable) ?? null;
}

const MANIFEST_LINE = /^([0-9a-f]{64}) {2}(.+)$/;

/** Member name -> sha256, in file order. A missing manifest is empty. */
export function readManifest(manifestPath: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(manifestPath)) return out;
  for (const line of fs.readFileSync(manifestPath, "utf8").split("\n")) {
    if (!line) continue;
    const m = MANIFEST_LINE.exec(line);
    if (!m) throw new Error(`Malformed manifest line in ${manifestPath}: ${JSON.stringify(line)}`);
    out.set(m[2], m[1]);
  }
  return out;
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

interface Stage {
  cmd: string;
  args: string[];
}

/** A whole pipeline gets this long before every child is killed. Generous:
 *  a real month is ~13 GiB of tar, which takes well under a minute. */
const PIPELINE_TIMEOUT_MS = 30 * 60 * 1000;
/** After a stage exits, a still-running upstream stage gets this long to
 *  finish on its own (its output is drained meanwhile) before it is killed. */
const UPSTREAM_GRACE_MS = 5_000;

/**
 * Runs `stages` as a pipeline (each stdout feeds the next stdin). Rejects when
 * ANY process fails to start, exits non-zero, or dies from a signal, so a
 * failed `zstd -d` in the middle can never produce a silently short output.
 * On the first failure the rest are killed. The promise always settles: an
 * upstream stage left running after its reader exits is drained and then
 * killed, and the whole pipeline is killed after PIPELINE_TIMEOUT_MS.
 * `sink` receives the last stage's output: an open file descriptor, or a
 * function fed each chunk.
 */
function runPipeline(stages: Stage[], sink?: number | ((chunk: Buffer) => void)): Promise<void> {
  return new Promise((resolve, reject) => {
    const procs: ChildProcess[] = [];
    const running = stages.map(() => true);
    const timers: NodeJS.Timeout[] = [];
    let pending = stages.length;
    let done = false;

    const settle = (err?: Error) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      if (err) {
        procs.forEach((p, j) => {
          if (running[j]) p.kill("SIGTERM");
        });
        reject(err);
      } else {
        resolve();
      }
    };

    timers.push(
      setTimeout(
        () => settle(new Error(`pipeline timed out after ${PIPELINE_TIMEOUT_MS / 60000} minutes`)),
        PIPELINE_TIMEOUT_MS,
      ),
    );

    stages.forEach((stage, i) => {
      const last = i === stages.length - 1;
      let stdout: "pipe" | "ignore" | number = "pipe";
      if (last) stdout = typeof sink === "number" ? sink : sink ? "pipe" : "ignore";
      const stdio: StdioOptions = [i === 0 ? "ignore" : "pipe", stdout, "pipe"];
      const proc: ChildProcess = spawn(stage.cmd, stage.args, { env: CHILD_ENV, stdio });
      procs.push(proc);
      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < STDERR_LIMIT) stderr += d.toString();
      });
      // A dead neighbour shows up as EPIPE here; the exit status is the truth.
      proc.stdin?.on("error", () => {});
      proc.stdout?.on("error", () => {});
      if (i > 0 && proc.stdin) procs[i - 1].stdout?.pipe(proc.stdin);
      if (last && typeof sink === "function") proc.stdout?.on("data", sink);

      let settled = false;
      const finished = (err: Error | null) => {
        if (settled) return;
        settled = true;
        running[i] = false;
        if (err) {
          settle(err);
          return;
        }
        // A reader that exits leaves its upstream writing into a pipe nobody
        // reads, which would block forever: drain it, then kill it if it lingers.
        for (let j = 0; j < i; j++) {
          if (!running[j]) continue;
          const up = procs[j];
          up.stdout?.unpipe();
          up.stdout?.resume();
          timers.push(setTimeout(() => running[j] && up.kill("SIGTERM"), UPSTREAM_GRACE_MS));
        }
        pending -= 1;
        if (pending === 0) settle();
      };
      proc.on("error", (err) => finished(new Error(`${path.basename(stage.cmd)} failed to start: ${err.message}`)));
      proc.on("close", (code, signal) => {
        if (code === 0) {
          finished(null);
          return;
        }
        const why = signal ? `was killed by ${signal}` : `exited with ${code}`;
        finished(new Error(`${path.basename(stage.cmd)} ${stage.args.join(" ")} ${why}: ${stderr.trim()}`));
      });
    });
  });
}

const decompress = (zstd: string, archivePath: string): Stage => ({
  cmd: zstd,
  args: ["-q", "-dc", `--long=${ZSTD_LONG}`, archivePath],
});

const BLOCK = 512;
const padded = (n: number) => Math.ceil(n / BLOCK) * BLOCK;

/** A tar header number: octal text, or base-256 when the high bit is set. */
function tarNumber(field: Buffer): number {
  if (field[0] & 0x80) {
    let n = field[0] & 0x7f;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    return n;
  }
  const text = field.toString("latin1").replace(/[\0 ]+$/g, "").trim();
  return text ? parseInt(text, 8) : 0;
}

function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** `path` / `size` overrides from a pax extended header body. */
function parsePax(body: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    if (space === -1) break;
    const len = parseInt(body.subarray(pos, space).toString("latin1"), 10);
    if (!(len > 0)) break;
    const record = body.subarray(space + 1, pos + len - 1).toString("utf8"); // drop trailing \n
    const eq = record.indexOf("=");
    if (eq !== -1) {
      const key = record.slice(0, eq);
      const value = record.slice(eq + 1);
      if (key === "path") out.path = value;
      if (key === "size") out.size = parseInt(value, 10);
    }
    pos += len;
  }
  return out;
}

/** One archive member as its raw tar header describes it. */
export interface ArchiveEntry {
  name: string;
  size: number;
}

const USTAR_MAGIC = Buffer.from("ustar\0", "latin1");

/**
 * Walks raw tar headers. Unlike `bsdtar -t`, which silently folds macOS `._`
 * AppleDouble entries into the file before them, this reports EVERY member,
 * so a listing proves there is no junk. Checks each header checksum and that
 * the stream ends cleanly.
 */
class TarHeaderReader {
  readonly entries: ArchiveEntry[] = [];
  private buf: Buffer[] = [];
  private have = 0;
  private want = BLOCK;
  private skip = 0;
  private meta: { kind: "pax" | "global" | "gnuname" | "gnulink"; len: number } | null = null;
  private next: { path?: string; size?: number } = {};
  private ended = false;
  private error: Error | null = null;

  push = (chunk: Buffer): void => {
    if (this.error) return;
    try {
      this.consume(chunk);
    } catch (err) {
      this.error = err instanceof Error ? err : new Error(String(err));
    }
  };

  finish(): ArchiveEntry[] {
    if (this.error) throw this.error;
    if (!this.ended || this.skip > 0 || this.meta) throw new Error("tar stream is truncated");
    return this.entries;
  }

  private consume(chunk: Buffer): void {
    let off = 0;
    while (off < chunk.length) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - off);
        this.skip -= n;
        off += n;
        continue;
      }
      const n = Math.min(this.want - this.have, chunk.length - off);
      this.buf.push(chunk.subarray(off, off + n));
      this.have += n;
      off += n;
      if (this.have < this.want) continue;
      const block = Buffer.concat(this.buf);
      this.buf = [];
      this.have = 0;
      this.want = BLOCK;
      if (this.meta) {
        const body = block.subarray(0, this.meta.len);
        if (this.meta.kind === "pax") this.next = { ...this.next, ...parsePax(body) };
        if (this.meta.kind === "gnuname") this.next.path = cString(body);
        // "global" and "gnulink" (a long LINK target) never rename the member.
        this.meta = null;
      } else {
        this.header(block);
      }
    }
  }

  private header(h: Buffer): void {
    if (h.every((b) => b === 0)) {
      this.ended = true;
      return;
    }
    if (this.ended) throw new Error("tar data after the end-of-archive marker");
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== tarNumber(h.subarray(148, 156))) throw new Error("tar header checksum mismatch");
    const type = String.fromCharCode(h[156]);
    const ownSize = tarNumber(h.subarray(124, 136));
    const metaKinds = { x: "pax", g: "global", L: "gnuname", K: "gnulink" } as const;
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (ownSize > 0) {
        this.meta = { kind: metaKinds[type], len: ownSize };
        this.want = padded(ownSize);
      }
      return;
    }
    const size = this.next.size ?? ownSize;
    // Only POSIX ustar ("ustar\0") has the prefix field; old GNU ("ustar  ") uses those bytes otherwise.
    const prefix = h.subarray(257, 263).equals(USTAR_MAGIC) ? cString(h.subarray(345, 500)) : "";
    const name = cString(h.subarray(0, 100));
    this.entries.push({ name: this.next.path ?? (prefix ? `${prefix}/${name}` : name), size });
    this.next = {};
    // Links, devices, directories and FIFOs carry no data whatever their size field says.
    this.skip = "123456".includes(type) ? 0 : padded(size);
  }
}

/** Every member of an archive with its size, in order, `._` entries included.
 *  Decodes (and so proves) the whole stream. */
async function readArchiveEntries(archivePath: string, zstd: string): Promise<ArchiveEntry[]> {
  const reader = new TarHeaderReader();
  await runPipeline([decompress(zstd, archivePath)], reader.push);
  return reader.finish();
}

/** Every member name of an archive, in order, `._` entries included.
 *  Decodes (and so proves) the whole stream. */
export async function listArchiveMembers(archivePath: string, zstd: string): Promise<string[]> {
  return (await readArchiveEntries(archivePath, zstd)).map((e) => e.name);
}

/** Extracts `members` into `dir` in one pass over the archive. */
async function extractInto(archivePath: string, members: string[], dir: string, zstd: string): Promise<void> {
  await runPipeline([
    decompress(zstd, archivePath),
    { cmd: TAR, args: ["-xf", "-", "--no-mac-metadata", "-C", dir, ...members] },
  ]);
}

const unsafe = (name: string) => new Error(`Unsafe archive member name: ${JSON.stringify(name)}`);

/** For members we write: bare file names only. Names tar would read as an
 *  option, an `@archive`, a pattern, or a path are refused. */
function assertSafeMemberName(name: string): void {
  if (!name || name.startsWith("-") || name.startsWith("@") || /[/\\*?[\]{}\n\0]/.test(name)) throw unsafe(name);
}

/** For members we read back: a relative path is allowed (legacy archives hold
 *  `data/backups/x.db`), but no absolute path, no `.`/`..` or empty segment,
 *  no segment tar could read as an option or `@archive`, no glob character,
 *  no backslash, and no control character. */
function assertSafeExtractName(name: string): void {
  if (!name || name.startsWith("/") || /[\\*?[\]{}\x00-\x1f\x7f]/.test(name)) throw unsafe(name);
  for (const seg of name.split("/")) {
    if (!seg || seg === "." || seg === ".." || seg.startsWith("-") || seg.startsWith("@")) throw unsafe(name);
  }
}

/** A temp path beside `finalPath`, unique to this call, so two runs never
 *  share (or delete) each other's files. The suffix lets a later roll find
 *  and remove it if this process dies. */
export function uniqueTempPath(finalPath: string, suffix: ".new" | ".partial"): string {
  return `${finalPath}.${process.pid}-${crypto.randomBytes(6).toString("hex")}${suffix}`;
}

function fsyncPath(p: string, flags: "r" | "r+"): void {
  const fd = fs.openSync(p, flags);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeManifestFile(p: string, manifest: Map<string, string>): void {
  const body = [...manifest].map(([name, sum]) => `${sum}  ${name}\n`).join("");
  fs.writeFileSync(p, body);
  fsyncPath(p, "r+");
}

/** Identity of a file at a path: changes when anything renames or rewrites it. */
function fingerprint(p: string): string {
  try {
    const s = fs.statSync(p);
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw err;
  }
}

function manifestText(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface AddToArchiveOptions {
  /** Called immediately before each rename into a final path. Throw to abort
   *  (the roll uses it to re-check that it still owns the roll lock). */
  beforeRename?: () => void;
}

/**
 * Adds files to the archive (creating it if absent) and rewrites the manifest.
 * Atomic: writes a uniquely named `<archive>.<pid>-<random>.new`, verifies,
 * renames.
 *
 * A name whose checksum is already in the manifest is skipped; the same name
 * with a different checksum throws before anything is written. A name already
 * in the archive but missing from the manifest (a run that died between the
 * two renames) is checked against the archived copy and only recorded.
 *
 * Lost-update guard: if the archive or manifest at the final path changes
 * after it was read (another writer renamed over it), nothing is renamed.
 */
export async function addToArchive(
  archivePath: string,
  manifestPath: string,
  files: string[],
  zstd: string,
  opts: AddToArchiveOptions = {},
): Promise<void> {
  const archiveNew = uniqueTempPath(archivePath, ".new");
  const manifestNew = uniqueTempPath(manifestPath, ".new");
  const temps: string[] = [archiveNew, manifestNew];
  const makeTempDir = () => {
    const dir = uniqueTempPath(archivePath, ".partial");
    temps.push(dir);
    fs.mkdirSync(dir);
    return dir;
  };
  try {
    const archiveSeen = fingerprint(archivePath);
    const manifestSeen = manifestText(manifestPath);
    const manifest = readManifest(manifestPath);
    const oldEntries = archiveSeen === "absent" ? [] : await readArchiveEntries(archivePath, zstd);
    const changed = () => new Error(`${archivePath} or its manifest changed while this run was using it; not renaming`);
    const assertArchiveUnchanged = () => {
      if (fingerprint(archivePath) !== archiveSeen) throw changed();
    };
    const assertManifestUnchanged = () => {
      if (manifestText(manifestPath) !== manifestSeen) throw changed();
    };
    assertArchiveUnchanged();
    assertManifestUnchanged();
    // Ownership hook, then the lost-update check, then the rename: the checks
    // sit as close to the rename as they can.
    const guardedRename = (from: string, to: string, check: () => void) => {
      opts.beforeRename?.();
      check();
      fs.renameSync(from, to);
    };

    const oldMembers = oldEntries.map((e) => e.name);
    const oldSet = new Set(oldMembers);
    for (const name of manifest.keys()) {
      if (!oldSet.has(name)) throw new Error(`${manifestPath} lists ${name} but ${archivePath} does not hold it`);
    }

    const seen = new Set<string>();
    const toAdd: { file: string; name: string; sum: string; size: number }[] = [];
    const unrecorded: { name: string; sum: string }[] = [];
    for (const file of files) {
      const name = path.basename(file);
      assertSafeMemberName(name);
      if (seen.has(name)) throw new Error(`Two files named ${name} in one addToArchive call`);
      seen.add(name);
      const sum = await sha256File(file);
      const recorded = manifest.get(name);
      if (recorded !== undefined) {
        if (recorded !== sum) throw new Error(`${name} is already archived with a different checksum`);
        continue;
      }
      if (oldSet.has(name)) unrecorded.push({ name, sum });
      else toAdd.push({ file: path.resolve(file), name, sum, size: fs.statSync(file).size });
    }

    if (unrecorded.length > 0) {
      const dir = makeTempDir();
      await extractInto(archivePath, unrecorded.map((u) => u.name), dir, zstd);
      for (const u of unrecorded) {
        if ((await sha256File(path.join(dir, u.name))) !== u.sum) {
          throw new Error(`${u.name} is already archived with a different checksum`);
        }
        manifest.set(u.name, u.sum);
      }
    }

    if (toAdd.length === 0) {
      if (unrecorded.length > 0) {
        writeManifestFile(manifestNew, manifest);
        guardedRename(manifestNew, manifestPath, () => {
          assertArchiveUnchanged();
          assertManifestUnchanged();
        });
        fsyncPath(path.dirname(manifestPath), "r");
      }
      return;
    }

    // One zstd stream: the old members first (re-read by bsdtar via `@-`), then the new files.
    const tarArgs = ["-cf", "-", "--no-mac-metadata"];
    if (oldMembers.length > 0) tarArgs.push("@-");
    for (const a of toAdd) tarArgs.push("-C", path.dirname(a.file), a.name);
    const stages: Stage[] = [];
    if (oldMembers.length > 0) stages.push(decompress(zstd, archivePath));
    stages.push({ cmd: TAR, args: tarArgs });
    stages.push({
      cmd: zstd,
      args: ["-q", "-f", `-${ZSTD_LEVEL}`, "-T0", `--long=${ZSTD_LONG}`, "-o", archiveNew],
    });
    await runPipeline(stages);

    // Verify: exact members (name and size) in order, which also decodes the
    // whole stream; then every new member byte-for-byte by checksum.
    const expected: ArchiveEntry[] = [...oldEntries, ...toAdd.map((a) => ({ name: a.name, size: a.size }))];
    const actual = await readArchiveEntries(archiveNew, zstd);
    const show = (l: ArchiveEntry[]) => l.map((e) => `${e.name}(${e.size})`).join(", ");
    if (actual.length !== expected.length || actual.some((e, i) => e.name !== expected[i].name || e.size !== expected[i].size)) {
      throw new Error(`Verification failed for ${archiveNew}: expected [${show(expected)}], got [${show(actual)}]`);
    }
    const dir = makeTempDir();
    await extractInto(archiveNew, toAdd.map((a) => a.name), dir, zstd);
    for (const a of toAdd) {
      if ((await sha256File(path.join(dir, a.name))) !== a.sum) {
        throw new Error(`Verification failed: ${a.name} in ${archiveNew} does not match its source`);
      }
      manifest.set(a.name, a.sum);
    }

    fsyncPath(archiveNew, "r+");
    writeManifestFile(manifestNew, manifest);
    guardedRename(archiveNew, archivePath, () => {
      assertArchiveUnchanged();
      assertManifestUnchanged();
    });
    guardedRename(manifestNew, manifestPath, assertManifestUnchanged);
    // Make both renames durable before anyone deletes a loose copy on their word.
    fsyncPath(path.dirname(archivePath), "r");
    if (path.dirname(manifestPath) !== path.dirname(archivePath)) fsyncPath(path.dirname(manifestPath), "r");
  } finally {
    // Only this call's own temp files; a cleanup error must not hide the real one.
    for (const t of temps) {
      try {
        fs.rmSync(t, { recursive: true, force: true });
      } catch {
        // A leftover `.new` / `.partial` is removed by a later roll.
      }
    }
  }
}

/** Writes one member to destPath. Throws if the member is not in the archive.
 *  `member` may hold folder parts (legacy archives); output only ever goes to
 *  `destPath`. */
export async function extractMember(
  archivePath: string,
  member: string,
  destPath: string,
  zstd: string,
): Promise<void> {
  assertSafeExtractName(member);
  // bsdtar matches names as patterns: `a/b.db` would also match `./a/b.db`
  // or anything under `a/b.db/`. Require exactly one member that the name
  // can match, so the output is exactly that member.
  const entries = await readArchiveEntries(archivePath, zstd);
  const strip = (n: string) => n.replace(/^(\.\/)+/, "");
  const exact = entries.filter((e) => e.name === member);
  const lookalikes = entries.filter((e) => e.name !== member && (strip(e.name) === member || strip(e.name).startsWith(`${member}/`)));
  if (exact.length !== 1) {
    throw new Error(`${member} is ${exact.length === 0 ? "not in" : "in more than once in"} ${archivePath}`);
  }
  if (lookalikes.length > 0) throw new Error(`${member} is ambiguous in ${archivePath}`);

  const partial = uniqueTempPath(destPath, ".partial");
  try {
    const fd = fs.openSync(partial, "w");
    try {
      await runPipeline([decompress(zstd, archivePath), { cmd: TAR, args: ["-xOf", "-", member] }], fd);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.statSync(partial).size !== exact[0].size) {
      throw new Error(`Extracted ${member} has the wrong size`);
    }
    fs.renameSync(partial, destPath);
  } finally {
    try {
      fs.rmSync(partial, { force: true });
    } catch {
      // Left for a later cleanup; never hide the real error.
    }
  }
}
