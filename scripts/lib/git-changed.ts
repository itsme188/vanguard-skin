/** Read-only working or complete-task diff collection. Rename sources are retained. */
import { execFileSync } from "node:child_process";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function parsePorcelainZ(raw: string): string[] {
  const fields = raw.split("\0");
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec) continue;
    if (rec.slice(3)) out.push(rec.slice(3));
    if (/[RC]/.test(rec.slice(0, 2)) && fields[i + 1]) out.push(fields[++i]);
  }
  return [...new Set(out)];
}

export function resolveBase(base: string, cwd = process.cwd()): { integrationBase: string; mergeBase: string } {
  const integrationBase = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim();
  const mergeBase = git(cwd, ["merge-base", integrationBase, "HEAD"]).trim();
  return { integrationBase, mergeBase };
}

export function getChangedFiles(options: { cwd?: string; base?: string } = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const working = parsePorcelainZ(git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  if (!options.base) return working.sort();
  const { mergeBase } = resolveBase(options.base, cwd);
  // --no-renames includes both old and new paths, including cross-domain moves.
  const committed = git(cwd, ["diff", "--name-only", "-z", "--no-renames", mergeBase, "HEAD", "--"]).split("\0").filter(Boolean);
  return [...new Set([...committed, ...working])].sort();
}
