import fs from "node:fs";
import path from "node:path";

/** Warn when the disk has less free space than this. */
export const LOW_FREE_SPACE_BYTES = 25 * 1024 ** 3;

/** Scratch files older than this many days may be trimmed. */
export const SCRATCH_MAX_AGE_DAYS = 7;

/** The USB copy counts as stale after this many days (or when never synced). */
export const USB_STALE_DAYS = 35;

/** Marker file inside the backup home; holds one ISO timestamp. */
export const USB_MARKER_NAME = ".usb-last-sync";

/** Folders (relative to the repo root) that hold throwaway files. */
const SCRATCH_DIRS = ["qa/tmp", ".playwright-mcp"] as const;

const DAY_MS = 86_400_000;

export interface CategorySize {
  name: string;
  path: string;
  bytes: number;
}

export interface TrimCandidate {
  path: string;
  bytes: number;
  ageDays: number;
}

export interface StorageReport {
  freeBytes: number;
  lowFreeSpace: boolean;
  categories: CategorySize[];
  trimCandidates: TrimCandidate[];
  usbLastSync: string | null;
  usbStale: boolean;
}

/** Calls `visit` for every regular file under `dir`, recursively. Symlinks are
 *  neither followed nor visited. A missing or unreadable folder yields nothing. */
function walkFiles(dir: string, visit: (file: string, stat: fs.Stats) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, visit);
    } else if (entry.isFile()) {
      try {
        visit(full, fs.lstatSync(full));
      } catch {
        // file vanished while walking; skip it
      }
    }
  }
}

function dirBytes(dir: string): number {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return 0;
  } catch {
    return 0;
  }
  let total = 0;
  walkFiles(dir, (_file, stat) => {
    total += stat.size;
  });
  return total;
}

function sameDir(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function readUsbLastSync(backupHome: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(backupHome, USB_MARKER_NAME), "utf8").trim();
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/**
 * Disk use by category, plus the scratch files old enough to trim.
 * Reads sizes from the folders it is given; `freeBytes`, `now` and `worktrees`
 * are inputs, so it never shells out. `worktrees` are absolute paths; the repo
 * itself is skipped if listed.
 */
export function buildStorageReport(input: {
  repoRoot: string;
  backupHome: string;
  freeBytes: number;
  now: Date;
  worktrees?: string[];
}): StorageReport {
  const { repoRoot, backupHome, freeBytes, now } = input;

  const fixed: Array<[string, string]> = [
    ["backup home", backupHome],
    ["data", path.join(repoRoot, "data")],
    [".next", path.join(repoRoot, ".next")],
    ["dist", path.join(repoRoot, "dist")],
    ["qa/findings", path.join(repoRoot, "qa/findings")],
    ["qa/tmp", path.join(repoRoot, "qa/tmp")],
    [".playwright-mcp", path.join(repoRoot, ".playwright-mcp")],
  ];
  const categories: CategorySize[] = fixed.map(([name, p]) => ({
    name,
    path: p,
    bytes: dirBytes(p),
  }));

  for (const wt of input.worktrees ?? []) {
    if (sameDir(wt, repoRoot)) continue;
    for (const sub of ["node_modules", ".next"]) {
      const p = path.join(wt, sub);
      categories.push({ name: `${wt} ${sub}`, path: p, bytes: dirBytes(p) });
    }
  }

  const trimCandidates: TrimCandidate[] = [];
  const cutoff = now.getTime() - SCRATCH_MAX_AGE_DAYS * DAY_MS;
  for (const rel of SCRATCH_DIRS) {
    walkFiles(path.join(repoRoot, rel), (file, stat) => {
      if (stat.mtimeMs < cutoff) {
        trimCandidates.push({
          path: file,
          bytes: stat.size,
          ageDays: Math.floor((now.getTime() - stat.mtimeMs) / DAY_MS),
        });
      }
    });
  }

  const usbLastSync = readUsbLastSync(backupHome);
  const usbStale =
    usbLastSync === null ||
    now.getTime() - Date.parse(usbLastSync) > USB_STALE_DAYS * DAY_MS;

  return {
    freeBytes,
    lowFreeSpace: freeBytes < LOW_FREE_SPACE_BYTES,
    categories,
    trimCandidates,
    usbLastSync,
    usbStale,
  };
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Deletes the given scratch files. Deletes FILES only. Each path is resolved
 * with realpath and must sit under `<repoRoot>/qa/tmp` or
 * `<repoRoot>/.playwright-mcp`; anything else (including a symlink that points
 * outside, a directory, or a missing file) is skipped and not counted.
 */
export function trimScratch(
  candidates: TrimCandidate[],
  repoRoot: string,
): { removed: number; bytes: number } {
  const roots: string[] = [];
  for (const rel of SCRATCH_DIRS) {
    try {
      roots.push(fs.realpathSync(path.join(repoRoot, rel)));
    } catch {
      // folder missing: nothing can live under it
    }
  }

  let removed = 0;
  let bytes = 0;
  for (const c of candidates) {
    try {
      const real = fs.realpathSync(c.path);
      if (!roots.some((root) => isUnder(real, root))) continue;
      const stat = fs.lstatSync(c.path);
      if (!stat.isFile()) continue; // never a directory, never a symlink
      fs.unlinkSync(c.path);
      removed += 1;
      bytes += stat.size;
    } catch {
      // vanished or unreadable: skip
    }
  }
  return { removed, bytes };
}
