/**
 * Read-only disk-use report for this project and its backups.
 * Run: npm run storage:report
 * Add --trim-scratch to delete scratch files older than a week
 * (qa/tmp and .playwright-mcp only). Nothing else is ever changed.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveBackupHome } from "../lib/backup/backup-home";
import {
  LOW_FREE_SPACE_BYTES,
  SCRATCH_MAX_AGE_DAYS,
  USB_STALE_DAYS,
  buildStorageReport,
  trimScratch,
} from "../lib/backup/storage-report";

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  return `${(n / 1024 ** 2).toFixed(1)} MiB`;
}

function listWorktrees(repoRoot: string): string[] {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
  } catch {
    return [];
  }
}

function findRepoRoot(): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const top = r.status === 0 ? r.stdout.trim() : "";
  return top || process.cwd();
}

function main(): void {
  const repoRoot = findRepoRoot();
  const backupHome = resolveBackupHome();
  const now = new Date();
  const stat = fs.statfsSync(repoRoot);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);

  const report = buildStorageReport({
    repoRoot,
    backupHome,
    freeBytes,
    now,
    worktrees: listWorktrees(repoRoot),
  });

  console.log(`Free space: ${formatBytes(report.freeBytes)}`);
  if (report.lowFreeSpace) {
    console.log(
      `WARNING: free space is under ${formatBytes(LOW_FREE_SPACE_BYTES)}. Free some space soon.`,
    );
  }

  console.log("\nSize by category (largest first):");
  const sorted = [...report.categories].sort((a, b) => b.bytes - a.bytes);
  const width = Math.max(...sorted.map((c) => c.name.length));
  for (const c of sorted) {
    console.log(`  ${c.name.padEnd(width)}  ${formatBytes(c.bytes).padStart(11)}`);
  }

  const trimBytes = report.trimCandidates.reduce((s, c) => s + c.bytes, 0);
  console.log(
    `\nScratch files older than ${SCRATCH_MAX_AGE_DAYS} days: ${report.trimCandidates.length} (${formatBytes(trimBytes)})`,
  );

  if (report.usbLastSync === null) {
    console.log("USB copy: never");
  } else {
    const days = Math.floor((now.getTime() - Date.parse(report.usbLastSync)) / 86_400_000);
    console.log(`USB copy: last sync ${days} days ago (${report.usbLastSync})`);
  }
  if (report.usbStale) {
    console.log(`WARNING: the USB copy is missing or older than ${USB_STALE_DAYS} days.`);
  }

  if (process.argv.includes("--trim-scratch")) {
    const res = trimScratch(report.trimCandidates, path.resolve(repoRoot));
    console.log(`\nTrimmed ${res.removed} scratch files (${formatBytes(res.bytes)}).`);
  } else if (report.trimCandidates.length > 0) {
    console.log("Run with --trim-scratch to delete them.");
  }
}

main();
