/**
 * git-changed.ts — Collect changed files for verify:changed via
 * `git status --porcelain=v1 -z` (staged + unstaged + untracked; -z avoids
 * quoted-path ambiguity). Read-only: runs exactly one git status command.
 *
 * Usage: imported by scripts/verify-changed.ts; not run directly.
 */
import { execFileSync } from "node:child_process";

export function parsePorcelainZ(raw: string): string[] {
  const fields = raw.split("\0");
  const out: string[] = [];
  let i = 0;
  while (i < fields.length) {
    const rec = fields[i];
    i += 1;
    if (!rec) continue; // trailing empty field after final NUL
    const status = rec.slice(0, 2);
    const p = rec.slice(3);
    if (p) out.push(p);
    // rename/copy records carry ONE extra field: the original path — skip it
    if (status.includes("R") || status.includes("C")) i += 1;
  }
  return [...new Set(out)];
}

export function getChangedFiles(): string[] {
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return parsePorcelainZ(raw);
}
