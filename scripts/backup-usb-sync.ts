/**
 * Refresh the USB copy of the backups.
 * Run: npm run backup:usb -- --volume "/Volumes/<name>"
 * Copies every archive file plus HOW-TO-RESTORE.txt into
 * "<volume>/Portfolio Desk Backups/" when missing or different, and verifies
 * each copy by checksum. Never deletes anything on the drive.
 */
import fs from "node:fs";
import path from "node:path";
import { sha256File } from "../lib/backup/archive";
import { backupPaths, resolveBackupHome } from "../lib/backup/backup-home";

export const USB_FOLDER = "Portfolio Desk Backups";
/** FAT32 cannot hold a file of 4 GiB or more. */
export const FAT32_MAX_FILE_BYTES = 4 * 1024 ** 3 - 1;

export interface SyncResult {
  copied: string[];
  skipped: string[];
}

/** Volume root -> where the files go. Throws when the volume is not there. */
export async function syncToVolume(
  home: string,
  volumeDir: string,
  opts: { maxFileBytes?: number; copyFile?: (src: string, dest: string) => void } = {},
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

  const result: SyncResult = { copied: [], skipped: [] };
  for (const src of sources) {
    const name = path.basename(src);
    const dest = path.join(destDir, name);
    const srcSum = await sha256File(src);
    if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size && (await sha256File(dest)) === srcSum) {
      result.skipped.push(name);
      continue;
    }
    // Copy beside the final name, verify, then rename over it, so a crash or a
    // pulled drive never leaves a truncated file where a good one was.
    const partial = `${dest}.partial`;
    try {
      copyFile(src, partial);
      if ((await sha256File(partial)) !== srcSum) {
        throw new Error(`Copy of ${name} failed its checksum check; the bad copy was removed.`);
      }
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    }
    fs.renameSync(partial, dest);
    result.copied.push(name);
  }

  fs.writeFileSync(path.join(home, ".usb-last-sync"), `${new Date().toISOString()}\n`);
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
  const r = await syncToVolume(resolveBackupHome(), volume);
  console.log(`USB sync done: ${r.copied.length} copied, ${r.skipped.length} already up to date.`);
  for (const n of r.copied) console.log(`  copied  ${n}`);
}

const isMain =
  typeof process !== "undefined" && process.argv[1] != null && /backup-usb-sync\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
