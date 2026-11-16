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
    const scratchDir = path.join(repoRoot, rel);
    if (isSymlink(scratchDir)) continue; // never list files behind a link
    walkFiles(scratchDir, (file, stat) => {
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

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Deletes the given scratch files. Deletes FILES only. A candidate is removed
 * only when all of these hold: the path is absolute and already normalized (no
 * `..`); it lies lexically under `<repoRoot>/qa/tmp` or `<repoRoot>/.playwright-mcp`;
 * lstat says it is a regular file (a symlink is refused first); and its parent
 * directory resolves to itself, so no symlink sits anywhere below the repo root
 * (this also refuses a scratch root that is itself a symlink). Anything else is
 * skipped and not counted.
 */
export function trimScratch(
  candidates: TrimCandidate[],
  repoRoot: string,
): { removed: number; bytes: number } {
  const root = path.resolve(repoRoot);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { removed: 0, bytes: 0 };
  }
  const scratchRoots = SCRATCH_DIRS.map((rel) => path.join(root, rel));

  let removed = 0;
  let bytes = 0;
  for (const c of candidates) {
    try {
      if (!path.isAbsolute(c.path) || c.path !== path.resolve(c.path)) continue;
      if (!scratchRoots.some((r) => isUnder(c.path, r))) continue;
      const stat = fs.lstatSync(c.path);
      if (!stat.isFile()) continue; // refuses symlinks and directories
      const parent = path.dirname(c.path);
      const expectedParent = path.join(realRoot, path.relative(root, parent));
      if (fs.realpathSync(parent) !== expectedParent) continue;
      // Safe: unlink removes this directory entry, never a link target.
      fs.unlinkSync(c.path);
      removed += 1;
      bytes += stat.size;
    } catch {
      // vanished or unreadable: skip
    }
  }
  return { removed, bytes };
}
