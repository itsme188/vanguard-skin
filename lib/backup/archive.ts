import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EnvLike } from "@/lib/db/db-path";

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

/**
 * Runs `stages` as a pipeline (each stdout feeds the next stdin). Rejects when
 * ANY process fails to start, exits non-zero, or dies from a signal, so a
 * failed `zstd -d` in the middle can never produce a silently short output.
 * On the first failure the rest are killed. `sink` receives the last stage's
 * output: an open file descriptor, or a function fed each chunk.
 */
function runPipeline(stages: Stage[], sink?: number | ((chunk: Buffer) => void)): Promise<void> {
  return new Promise((resolve, reject) => {
    const procs: ChildProcess[] = [];
    let pending = stages.length;
    let failed = false;

    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGTERM");
      reject(err);
    };

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
      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        fail(new Error(`${path.basename(stage.cmd)} failed to start: ${err.message}`));
      });
      proc.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          const why = signal ? `was killed by ${signal}` : `exited with ${code}`;
          fail(new Error(`${path.basename(stage.cmd)} ${stage.args.join(" ")} ${why}: ${stderr.trim()}`));
          return;
        }
        pending -= 1;
        if (pending === 0 && !failed) resolve();
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

/**
 * Walks raw tar headers. Unlike `bsdtar -t`, which silently folds macOS `._`
 * AppleDouble entries into the file before them, this reports EVERY member,
 * so a listing proves there is no junk. Checks each header checksum and that
 * the stream ends cleanly.
 */
class TarHeaderReader {
  readonly names: string[] = [];
  private buf: Buffer[] = [];
  private have = 0;
  private want = BLOCK;
  private skip = 0;
  private meta: { kind: "pax" | "global" | "gnuname"; len: number } | null = null;
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

  finish(): string[] {
    if (this.error) throw this.error;
    if (!this.ended || this.skip > 0 || this.meta) throw new Error("tar stream is truncated");
    return this.names;
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
    if (type === "x" || type === "g" || type === "L") {
      const kind = type === "x" ? "pax" : type === "g" ? "global" : "gnuname";
      if (ownSize > 0) {
        this.meta = { kind, len: ownSize };
        this.want = padded(ownSize);
      }
      return;
    }
    const size = this.next.size ?? ownSize;
    const prefix = h.subarray(257, 263).toString("latin1").startsWith("ustar") ? cString(h.subarray(345, 500)) : "";
    const name = cString(h.subarray(0, 100));
    this.names.push(this.next.path ?? (prefix ? `${prefix}/${name}` : name));
    this.next = {};
    // Links, devices, directories and FIFOs carry no data whatever their size field says.
    this.skip = "123456".includes(type) ? 0 : padded(size);
  }
}

/** Every member name of an archive, in order, `._` entries included.
 *  Decodes (and so proves) the whole stream. */
export async function listArchiveMembers(archivePath: string, zstd: string): Promise<string[]> {
  const reader = new TarHeaderReader();
  await runPipeline([decompress(zstd, archivePath)], reader.push);
  return reader.finish();
}

/** Extracts `members` into `dir` in one pass over the archive. */
async function extractInto(archivePath: string, members: string[], dir: string, zstd: string): Promise<void> {
  await runPipeline([
    decompress(zstd, archivePath),
    { cmd: TAR, args: ["-xf", "-", "--no-mac-metadata", "-C", dir, ...members] },
  ]);
}

/** Names tar would read as an option, an `@archive`, or a pattern are refused. */
function assertSafeMemberName(name: string): void {
  if (!name || name.startsWith("-") || name.startsWith("@") || /[/\\*?[\n\0]/.test(name)) {
    throw new Error(`Unsafe archive member name: ${JSON.stringify(name)}`);
  }
}

function fsyncFile(p: string): void {
  const fd = fs.openSync(p, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeManifestFile(p: string, manifest: Map<string, string>): void {
  const body = [...manifest].map(([name, sum]) => `${sum}  ${name}\n`).join("");
  fs.writeFileSync(p, body);
  fsyncFile(p);
}

/** A temp folder beside the archive. Its `.partial` suffix lets a later roll
 *  clean it up if this process dies. */
function makeTempDir(archivePath: string): string {
  const dir = `${archivePath}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.partial`;
  fs.mkdirSync(dir);
  return dir;
}

/**
 * Adds files to the archive (creating it if absent) and rewrites the manifest.
 * Atomic: writes <archive>.new, verifies, renames.
 *
 * A name whose checksum is already in the manifest is skipped; the same name
 * with a different checksum throws before anything is written. A name already
 * in the archive but missing from the manifest (a run that died between the
 * two renames) is checked against the archived copy and only recorded.
 */
export async function addToArchive(
  archivePath: string,
  manifestPath: string,
  files: string[],
  zstd: string,
): Promise<void> {
  const archiveNew = `${archivePath}.new`;
  const manifestNew = `${manifestPath}.new`;
  const temps: string[] = [];
  try {
    const manifest = readManifest(manifestPath);
    const oldMembers = fs.existsSync(archivePath) ? await listArchiveMembers(archivePath, zstd) : [];
    const oldSet = new Set(oldMembers);
    for (const name of manifest.keys()) {
      if (!oldSet.has(name)) throw new Error(`${manifestPath} lists ${name} but ${archivePath} does not hold it`);
    }

    const seen = new Set<string>();
    const toAdd: { file: string; name: string; sum: string }[] = [];
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
      else toAdd.push({ file: path.resolve(file), name, sum });
    }

    if (unrecorded.length > 0) {
      const dir = makeTempDir(archivePath);
      temps.push(dir);
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
        fs.renameSync(manifestNew, manifestPath);
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
    temps.push(archiveNew);
    await runPipeline(stages);

    // Verify: exact member list in order (this also decodes the whole stream),
    // then every new member byte-for-byte by checksum.
    const expected = [...oldMembers, ...toAdd.map((a) => a.name)];
    const actual = await listArchiveMembers(archiveNew, zstd);
    if (actual.length !== expected.length || actual.some((m, i) => m !== expected[i])) {
      throw new Error(
        `Verification failed for ${archiveNew}: expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
      );
    }
    const dir = makeTempDir(archivePath);
    temps.push(dir);
    await extractInto(archiveNew, toAdd.map((a) => a.name), dir, zstd);
    for (const a of toAdd) {
      if ((await sha256File(path.join(dir, a.name))) !== a.sum) {
        throw new Error(`Verification failed: ${a.name} in ${archiveNew} does not match its source`);
      }
      manifest.set(a.name, a.sum);
    }

    fsyncFile(archiveNew);
    temps.push(manifestNew);
    writeManifestFile(manifestNew, manifest);
    fs.renameSync(archiveNew, archivePath);
    fs.renameSync(manifestNew, manifestPath);
  } finally {
    for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
    fs.rmSync(manifestNew, { force: true });
  }
}

/** Writes one member to destPath. Throws if the member is not in the archive. */
export async function extractMember(
  archivePath: string,
  member: string,
  destPath: string,
  zstd: string,
): Promise<void> {
  assertSafeMemberName(member);
  const partial = `${destPath}.partial`;
  const fd = fs.openSync(partial, "w");
  try {
    await runPipeline(
      [decompress(zstd, archivePath), { cmd: TAR, args: ["-xOf", "-", member] }],
      fd,
    );
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(partial, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(partial, destPath);
}
