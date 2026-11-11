/**
 * Chat evaluation: never write a result or a database to a tracked path.
 *
 * Inside this git checkout an output path must be git-ignored (data/ is);
 * outside the checkout (for example the session scratchpad) any path is
 * allowed. Answer text and figures from the eval database therefore never
 * land in a file git would pick up.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

function repoRoot(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Why `outPath` may not be written, or null when it may. */
export function outputPathRefusal(outPath: string): string | null {
  const abs = path.resolve(outPath);
  const root = repoRoot();
  if (!root) return null;
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null; // outside the checkout
  try {
    execFileSync("git", ["check-ignore", "-q", "--", rel], { cwd: root, stdio: "ignore" });
    return null; // ignored
  } catch {
    return `refusing ${abs}: it is inside the repository and not git-ignored (use data/chat-eval/ or a scratch directory)`;
  }
}
