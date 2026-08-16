/**
 * verify-changed.ts — Select and run the smallest relevant Vitest checks for
 * the current working diff. Part of the #52 evidence-driven verification loop.
 *
 * Usage:
 *   npm run verify:changed                # plan + run selected tests
 *   npm run verify:changed -- --dry-run   # plan only, deterministic output
 *
 * Guarantees: read-only (one `git status`), never applies migrations, never
 * touches the DB, no network. With zero selected targets it exits 0 WITHOUT
 * invoking vitest (a bare `vitest run` would run the full suite).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { planVerification, formatPlan } from "./lib/verify-mapping";
import { getChangedFiles } from "./lib/git-changed";

const dryRun = process.argv.includes("--dry-run");

const changed = getChangedFiles();
if (changed.length === 0) {
  console.log("Working tree clean — nothing to verify.");
  process.exit(0);
}

const plan = planVerification(changed);
console.log(formatPlan(plan));
console.log("");
console.log("Recommended optional checks (not run automatically):");
console.log("  npx tsc --noEmit");
console.log("  npx next build");

if (dryRun) process.exit(0);

if (plan.selectedTests.length === 0) {
  console.log("");
  console.log("No focused tests mapped — manual test selection required (see reminders above).");
  process.exit(0);
}

// Deleted/renamed test files can still be `selectedTests` (a `D  tests/foo.test.ts`
// git-status entry is a legitimate changed path the planner routes straight to
// directTests). Vitest exits 1 on a nonexistent target ("No test files found"),
// which would turn a clean deletion into a spurious verify:changed failure —
// drop those targets here, in the CLI layer, before spawning vitest.
const existingTargets = plan.selectedTests.filter((t) => {
  if (existsSync(t)) return true;
  console.log(`Skipping deleted/missing target: ${t}`);
  return false;
});

if (existingTargets.length === 0) {
  console.log("");
  console.log("No focused tests mapped — manual test selection required (see reminders above).");
  process.exit(0);
}

const env = {
  ...process.env,
  PATH: `/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? ""}`,
};
console.log("");
console.log(`Running: npx vitest run ${existingTargets.join(" ")}`);
const res = spawnSync("npx", ["vitest", "run", ...existingTargets], {
  stdio: "inherit",
  env,
});
process.exit(res.status ?? 1);
