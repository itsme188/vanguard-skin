import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { addToArchive, findZstd, readManifest, sha256File } from "./archive";
import { RECENT_BACKUPS_KEPT, archiveMonth, backupPaths, backupStamp } from "./backup-home";
import type { EnvLike } from "../db/db-path";

export interface RollResult {
  rolled: string[];
  kept: string[];
  skipped?: string;
}

/** A lock, `.new`, or `.partial` older than this belongs to a dead run. */
const STALE_MS = 30 * 60 * 1000;
const LEFTOVER = /\.(new|partial)$/;
/** File inside the lock folder naming its owner (a random token per roll). */
const LOCK_TOKEN_FILE = "owner";

/** Points in a roll where ownership of the lock is re-checked. */
export type RollStep = "archive" | "rename" | "delete";

/** Thrown when another roll took the lock over. The roll stops at once:
 *  nothing more is renamed or deleted. */
export class RollLockLostError extends Error {}

interface Candidate {
  name: string;
  file: string;
  mtime: Date;
}

/** `*.db` regular files directly in `recent/`, oldest first. */
function listCandidates(recent: string): Candidate[] {
  if (!fs.existsSync(recent)) return [];
  const out: Candidate[] = [];
  for (const name of fs.readdirSync(recent)) {
    if (!name.endsWith(".db")) continue;
    const file = path.join(recent, name);
    const st = fs.lstatSync(file);
    if (st.isFile()) out.push({ name, file, mtime: st.mtime });
  }
  return out.sort((a, b) => a.mtime.getTime() - b.mtime.getTime() || a.name.localeCompare(b.name));
}

/** Deletes `.new` / `.partial` leftovers older than STALE_MS directly in `dir`. */
function removeStaleLeftovers(dir: string, now: Date, log: (l: string) => void): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!LEFTOVER.test(name)) continue;
    const p = path.join(dir, name);
    if (now.getTime() - fs.lstatSync(p).mtime.getTime() < STALE_MS) continue;
    fs.rmSync(p, { recursive: true, force: true });
    log(`removed stale leftover ${p}`);
  }
}

const isCode = (err: unknown, code: string) => (err as NodeJS.ErrnoException)?.code === code;

function readToken(lock: string): string | null {
  try {
    return fs.readFileSync(path.join(lock, LOCK_TOKEN_FILE), "utf8");
  } catch {
    return null;
  }
}

/**
 * Takes the roll lock: an atomic mkdir plus a random owner token inside it.
 * Returns the token, or null while a live roll holds the lock. A lock whose
 * folder was not touched for STALE_MS is taken over by renaming it aside
 * (atomic: only one contender's rename succeeds).
 */
function takeLock(lock: string, now: Date, log: (l: string) => void): string | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(lock);
      const token = `${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
      fs.writeFileSync(path.join(lock, LOCK_TOKEN_FILE), token);
      return token;
    } catch (err) {
      if (!isCode(err, "EEXIST")) throw err;
    }
    let mtime: number;
    try {
      mtime = fs.statSync(lock).mtime.getTime();
    } catch (err) {
      if (isCode(err, "ENOENT")) continue; // released between our mkdir and stat: try again
      throw err;
    }
    if (now.getTime() - mtime < STALE_MS) return null;
    const aside = `${lock}.${process.pid}-${crypto.randomBytes(6).toString("hex")}.stale`;
    try {
      fs.renameSync(lock, aside);
    } catch (err) {
      if (isCode(err, "ENOENT")) continue; // another contender moved it first
      throw err;
    }
    log(`took over stale roll lock ${lock}`);
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch {
      // A leftover `.stale` folder is harmless.
    }
  }
  return null;
}

/**
 * Moves all but the newest `keep` backups in `<home>/recent` into monthly
 * archives (`archives/YYYY-MM.tar.zst` + `.sha256`). A loose file is deleted
 * only once its exact checksum is in its month's manifest, so an interrupted
 * roll loses nothing and the next roll finishes the job. One month failing
 * does not stop the others; the roll then throws naming the failed months.
 *
 * The lock is owned by a token. Its folder is touched (heartbeat) before each
 * month and each deletion pass, and ownership is re-checked right before every
 * rename into a final path and every deletion. If another roll took the lock
 * over, this one throws RollLockLostError having renamed and deleted nothing
 * more, and leaves the new owner's lock alone.
 */
export async function rollOldBackups(
  home: string,
  opts: {
    keep?: number;
    env?: EnvLike;
    now?: Date;
    log?: (l: string) => void;
    /** Explicit zstd path, or null for "not found". Overrides the PATH lookup. */
    zstd?: string | null;
    /** Test seam: called just before each ownership check. */
    onStep?: (step: RollStep, detail: string) => void;
  } = {},
): Promise<RollResult> {
  const keep = opts.keep ?? RECENT_BACKUPS_KEPT;
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const { recent, archives, rollLock } = backupPaths(home);

  const all = listCandidates(recent);
  const allNames = all.map((c) => c.name);
  const zstd = opts.zstd !== undefined ? opts.zstd : findZstd(opts.env ?? process.env);
  if (zstd === null) {
    log("roll skipped: zstd not found");
    return { rolled: [], kept: allNames, skipped: "zstd not found" };
  }
  if (all.length === 0) return { rolled: [], kept: [] };

  const token = takeLock(rollLock, now, log);
  if (token === null) {
    log("roll skipped: another roll is running");
    return { rolled: [], kept: allNames, skipped: "another roll is running" };
  }
  const assertOwned = (step: RollStep, detail: string) => {
    opts.onStep?.(step, detail);
    if (readToken(rollLock) !== token) {
      throw new RollLockLostError(`roll lock ${rollLock} was taken over (at ${step} ${detail}); stopping`);
    }
  };
  // Heartbeat with the real clock (not opts.now) so a live roll never looks stale.
  const heartbeat = (step: RollStep, detail: string) => {
    assertOwned(step, detail);
    const t = new Date();
    fs.utimesSync(rollLock, t, t);
  };

  try {
    removeStaleLeftovers(recent, now, log);
    removeStaleLeftovers(archives, now, log);

    // Re-list under the lock: another roll may have finished in between.
    const candidates = listCandidates(recent);
    const cut = Math.max(0, candidates.length - keep);
    const toRoll = candidates.slice(0, cut);
    const kept = candidates.slice(cut).map((c) => c.name);
    if (toRoll.length === 0) return { rolled: [], kept };

    const byMonth = new Map<string, Candidate[]>();
    for (const c of toRoll) {
      const month = archiveMonth(c.name) ?? backupStamp(c.mtime).slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), c]);
    }

    fs.mkdirSync(archives, { recursive: true });
    const rolled: string[] = [];
    const failures: string[] = [];
    for (const [month, group] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
      const archivePath = path.join(archives, `${month}.tar.zst`);
      const manifestPath = path.join(archives, `${month}.sha256`);
      heartbeat("archive", month);
      try {
        await addToArchive(archivePath, manifestPath, group.map((c) => c.file), zstd, {
          beforeRename: () => assertOwned("rename", month),
        });
      } catch (err) {
        if (err instanceof RollLockLostError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${month}: ${msg}`);
        log(`roll of ${month} failed, loose copies kept: ${msg}`);
        continue;
      }
      heartbeat("delete", month);
      const manifest = readManifest(manifestPath);
      for (const c of group) {
        // Re-hash: delete only the exact bytes the manifest vouches for.
        if (manifest.get(c.name) !== (await sha256File(c.file))) {
          log(`${c.name} not in ${month} manifest with a matching checksum; kept`);
          continue;
        }
        assertOwned("delete", c.name);
        fs.rmSync(c.file);
        fs.rmSync(`${c.file}-wal`, { force: true });
        fs.rmSync(`${c.file}-shm`, { force: true });
        rolled.push(c.name);
        log(`rolled ${c.name} into ${month}.tar.zst`);
      }
    }
    if (failures.length > 0) throw new Error(`Backup roll failed for ${failures.join("; ")}`);
    return { rolled, kept };
  } finally {
    // Release only our own lock; a roll that took over keeps theirs.
    if (readToken(rollLock) === token) fs.rmSync(rollLock, { recursive: true, force: true });
  }
}
