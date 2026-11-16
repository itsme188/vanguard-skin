import fs from "node:fs";
import path from "node:path";
import { addToArchive, findZstd, readManifest, sha256File } from "@/lib/backup/archive";
import { RECENT_BACKUPS_KEPT, archiveMonth, backupPaths, backupStamp } from "@/lib/backup/backup-home";
import type { EnvLike } from "@/lib/db/db-path";

export interface RollResult {
  rolled: string[];
  kept: string[];
  skipped?: string;
}

/** A lock, `.new`, or `.partial` older than this belongs to a dead run. */
const STALE_MS = 30 * 60 * 1000;
const LEFTOVER = /\.(new|partial)$/;

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

/** Takes the roll lock (an atomic mkdir). Returns false while a live roll holds it. */
function takeLock(lock: string, now: Date, log: (l: string) => void): boolean {
  try {
    fs.mkdirSync(lock);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  if (now.getTime() - fs.statSync(lock).mtime.getTime() < STALE_MS) return false;
  log(`taking over stale roll lock ${lock}`);
  fs.rmSync(lock, { recursive: true, force: true });
  try {
    fs.mkdirSync(lock);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Moves all but the newest `keep` backups in `<home>/recent` into monthly
 * archives (`archives/YYYY-MM.tar.zst` + `.sha256`). A loose file is deleted
 * only once its exact checksum is in its month's manifest, so an interrupted
 * roll loses nothing and the next roll finishes the job. One month failing
 * does not stop the others; the roll then throws naming the failed months.
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

  if (!takeLock(rollLock, now, log)) {
    log("roll skipped: another roll is running");
    return { rolled: [], kept: allNames, skipped: "another roll is running" };
  }
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
      try {
        await addToArchive(archivePath, manifestPath, group.map((c) => c.file), zstd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${month}: ${msg}`);
        log(`roll of ${month} failed, loose copies kept: ${msg}`);
        continue;
      }
      const manifest = readManifest(manifestPath);
      for (const c of group) {
        // Re-hash: delete only the exact bytes the manifest vouches for.
        if (manifest.get(c.name) !== (await sha256File(c.file))) {
          log(`${c.name} not in ${month} manifest with a matching checksum; kept`);
          continue;
        }
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
    fs.rmSync(rollLock, { recursive: true, force: true });
  }
}
