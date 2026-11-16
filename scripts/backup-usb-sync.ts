/**
 * Refresh the USB copy of the backups.
 * Run: npm run backup:usb -- --volume "/Volumes/<name>"
 * Copies every archive file plus HOW-TO-RESTORE.txt into
 * "<volume>/Portfolio Desk Backups/" when missing or different, and verifies
 * each copy by checksum. Never deletes anything on the drive. An archive
 * already on the drive is replaced only after the local one is proven to
 * decode; otherwise the drive's copy (and its manifest) is kept and the
 * command exits non-zero.
 */
import fs from "node:fs";
import path from "node:path";
import { findZstd, listArchiveMembers, readManifest, sha256File } from "../lib/backup/archive";
import { backupPaths, resolveBackupHome } from "../lib/backup/backup-home";
import { USB_MARKER_NAME } from "../lib/backup/storage-report";

export const USB_FOLDER = "Portfolio Desk Backups";
/** FAT32 cannot hold a file of 4 GiB or more. */
export const FAT32_MAX_FILE_BYTES = 4 * 1024 ** 3 - 1;

const ARCHIVE_SUFFIX = ".tar.zst";
const manifestOf = (archive: string) => archive.slice(0, -ARCHIVE_SUFFIX.length) + ".sha256";

export interface SyncResult {
  copied: string[];
  skipped: string[];
  /** Files left as they are on the drive because the local copy could not be trusted. */
  refused: { name: string; reason: string }[];
  /** True when the home holds no monthly archive yet: nothing was copied. */
  nothingToSync: boolean;
  /** `.tar.zst` archives on the drive that match their local source after this sync. */
  archivesOnDrive: number;
  /** True when the USB marker was written: at least one archive matches on the
   *  drive and nothing was refused. The marker means "the drive copy is current". */
  stamped: boolean;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Null when `archive` decodes and holds every member its manifest names; else why not. */
async function whyNotTrusted(archive: string, zstd: string | null): Promise<string | null> {
  if (!zstd) return "zstd is not installed, so the local archive cannot be proven before replacing the drive's copy";
  try {
    const members = new Set(await listArchiveMembers(archive, zstd));
    const manifestPath = manifestOf(archive);
    if (fs.existsSync(manifestPath)) {
      const missing = [...readManifest(manifestPath).keys()].filter((n) => !members.has(n));
      if (missing.length > 0) return `the local archive does not hold ${missing.join(", ")} named in its manifest`;
    }
    return null;
  } catch (err) {
    return `the local archive does not decode: ${message(err)}`;
  }
}

/** Volume root -> where the files go. Throws when the volume is not there. */
export async function syncToVolume(
  home: string,
  volumeDir: string,
  opts: {
    maxFileBytes?: number;
    copyFile?: (src: string, dest: string) => void;
    /** zstd binary used to prove a local archive before it replaces one on the drive. */
    zstd?: string | null;
  } = {},
): Promise<SyncResult> {
  const maxFileBytes = opts.maxFileBytes ?? FAT32_MAX_FILE_BYTES;
  const copyFile = opts.copyFile ?? ((src: string, dest: string) => fs.copyFileSync(src, dest));
  if (!fs.existsSync(volumeDir) || !fs.statSync(volumeDir).isDirectory()) {
    throw new Error(`Volume folder does not exist: ${volumeDir}`);
  }

  const sources: string[] = [];
  const { archives } = backupPaths(home);
  if (fs.existsSync(archives)) {
    for (const name of fs.readdirSync(archives).sort()) {
      // Skip dotfiles and the temp files a roll in progress keeps here.
      if (name.startsWith(".") || name.endsWith(".partial") || name.endsWith(".new")) continue;
      const file = path.join(archives, name);
      if (fs.statSync(file).isFile()) sources.push(file);
    }
  }
  const archiveSources = sources.filter((f) => f.endsWith(ARCHIVE_SUFFIX));
  const result: SyncResult = {
    copied: [],
    skipped: [],
    refused: [],
    nothingToSync: archiveSources.length === 0,
    archivesOnDrive: 0,
    stamped: false,
  };
  if (result.nothingToSync) return result;

  const howTo = path.join(home, "HOW-TO-RESTORE.txt");
  if (fs.existsSync(howTo)) sources.push(howTo);

  // Refuse before copying anything.
  for (const src of sources) {
    if (fs.statSync(src).size > maxFileBytes) {
      throw new Error(
        `${path.basename(src)} is larger than 4 GB and a FAT32 drive cannot hold it. Reformat the drive as exFAT or APFS.`,
      );
    }
  }

  const destDir = path.join(volumeDir, USB_FOLDER);
  fs.mkdirSync(destDir, { recursive: true });

  const sums = new Map<string, string>();
  const sumOf = async (src: string) => {
    let sum = sums.get(src);
    if (sum === undefined) {
      sum = await sha256File(src);
      sums.set(src, sum);
    }
    return sum;
  };
  const sameOnDrive = async (src: string, dest: string) =>
    fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size && (await sha256File(dest)) === (await sumOf(src));

  // Before anything is written: an archive that would REPLACE one on the drive
  // must decode. If it does not, the drive keeps that archive and its manifest.
  const zstd = opts.zstd !== undefined ? opts.zstd : findZstd();
  const keepOnDrive = new Set<string>();
  for (const src of archiveSources) {
    const dest = path.join(destDir, path.basename(src));
    if (!fs.existsSync(dest) || (await sameOnDrive(src, dest))) continue;
    const why = await whyNotTrusted(src, zstd);
    if (why === null) continue;
    keepOnDrive.add(src).add(manifestOf(src));
    result.refused.push({ name: path.basename(src), reason: why });
  }

  for (const src of sources) {
    const name = path.basename(src);
    const dest = path.join(destDir, name);
    if (src.endsWith(ARCHIVE_SUFFIX) && keepOnDrive.has(src)) continue; // already reported
    if (await sameOnDrive(src, dest)) {
      result.skipped.push(name);
      continue;
    }
    if (keepOnDrive.has(src)) {
      result.refused.push({ name, reason: "kept with the drive's copy of its archive" });
      continue;
    }
    // Copy beside the final name, verify, then rename over it, so a crash or a
    // pulled drive never leaves a truncated file where a good one was.
    const partial = `${dest}.partial`;
    try {
      copyFile(src, partial);
      if ((await sha256File(partial)) !== (await sumOf(src))) {
        throw new Error(`Copy of ${name} failed its checksum check; the bad copy was removed.`);
      }
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    }
    fs.renameSync(partial, dest);
    result.copied.push(name);
  }

  const done = new Set([...result.copied, ...result.skipped]);
  result.archivesOnDrive = archiveSources.filter((src) => done.has(path.basename(src))).length;
  // A refusal means the drive is not current: leave any existing marker untouched.
  if (result.archivesOnDrive > 0 && result.refused.length === 0) {
    fs.writeFileSync(path.join(home, USB_MARKER_NAME), `${new Date().toISOString()}\n`);
    result.stamped = true;
  }
  return result;
}

function listVolumes(): string[] {
  try {
    return fs.readdirSync("/Volumes").map((n) => path.join("/Volumes", n));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--volume");
  const volume = i === -1 ? undefined : argv[i + 1];
  if (!volume || volume.startsWith("--")) {
    console.error('Usage: npm run backup:usb -- --volume "/Volumes/<name>"');
    console.error("Mounted volumes:");
    for (const v of listVolumes()) console.error(`  ${v}`);
    process.exit(2);
  }
  const home = resolveBackupHome();
  const r = await syncToVolume(home, volume);
  if (r.nothingToSync) {
    console.log(`Nothing to sync yet: there is no monthly archive in ${backupPaths(home).archives}. The drive was not touched.`);
    return;
  }
  console.log(`USB sync done: ${r.copied.length} copied, ${r.skipped.length} already up to date.`);
  for (const n of r.copied) console.log(`  copied  ${n}`);
  if (r.refused.length > 0) {
    console.error(`${r.refused.length} file(s) were NOT replaced; the drive keeps its own copy:`);
    console.error("The USB sync marker was NOT updated, because the drive copy is not current.");
    for (const x of r.refused) console.error(`  kept    ${x.name}: ${x.reason}`);
    console.error("Run `npm run backup:restore-test` and fix the local archive before syncing again.");
    process.exit(1);
  }
}

const isMain =
  typeof process !== "undefined" && process.argv[1] != null && /backup-usb-sync\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
