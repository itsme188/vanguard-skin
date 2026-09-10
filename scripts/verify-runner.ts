/** Shared CLI contract: see --help. Full means regression suite, not browser/build acceptance. */
import { pathToFileURL } from "node:url";
import { getChangedFiles, resolveBase } from "./lib/git-changed";
import { formatPlan } from "./lib/verify-mapping";
import { currentEvidence, focusedSelection, projectRoot, verify } from "./lib/verification";

export async function main(args: string[]): Promise<number> {
  const mode = args.shift() ?? "changed";
  if (mode === "--help") {
    console.log("bash scripts/verify.sh changed [--base REF] [--test PATH ...] [--dry-run]\nbash scripts/verify.sh full --base REF\nbash scripts/verify.sh typecheck\nbash scripts/verify.sh status [--base REF]\nExit: 0 passed/no-relevant-changes (see result), 3 manual-selection-required, 4 stale/missing evidence; subprocess failures preserve their code.\nchanged defaults to working diff; --base adds branch changes since merge-base. Logs/evidence: worktree git-dir/verification. No automatic builds or browser runs.");
    return 0;
  }
  if (!["changed", "full", "typecheck", "status"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  let base: string | undefined; let dryRun = false; const tests: string[] = [];
  while (args.length) {
    const flag = args.shift();
    if (flag === "--dry-run" && mode === "changed") dryRun = true;
    else if (flag === "--base" && args[0] && !args[0].startsWith("--")) base = args.shift();
    else if (flag === "--test" && mode === "changed" && args[0] && !args[0].startsWith("--")) tests.push(args.shift()!);
    else throw new Error(`Invalid or incomplete argument: ${flag}`);
  }
  if (process.versions.node.split(".")[0] !== "24") throw new Error("Use bash scripts/verify.sh with the pinned Node 24 runtime");
  const cwd = projectRoot(process.cwd());
  if (!cwd) throw new Error("Not a Portfolio Desk checkout");
  if (mode === "full" && !base) throw new Error("full requires --base REF (the explicit integration base)");
  if (mode === "status") {
    const saved = currentEvidence(cwd, "full", base);
    console.log(saved ? `passed: current full-suite evidence ${saved.id}` : "stale-or-missing: run bash scripts/verify.sh full --base <integration-base>");
    console.log(`verify: result=${saved ? "passed" : "stale-or-missing"} run=${saved?.id ?? "none"} base=${saved?.before.bases?.integrationBase ?? "none"}`);
    return saved ? 0 : 4;
  }
  const vitest = (targets: string[]) => ({ command: process.execPath, args: ["node_modules/vitest/vitest.mjs", "run", "--exclude", ".claude/**", "--exclude", ".agents/**", "--exclude", ".Codex/**", ...targets] });
  if (mode === "full") return (await verify(cwd, mode, base, [vitest([])])).exitCode;
  if (mode === "typecheck") return (await verify(cwd, mode, base, [{ command: process.execPath, args: ["node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"] }])).exitCode;
  const selection = focusedSelection(getChangedFiles({ cwd, base }), cwd, tests);
  console.log(formatPlan(selection.plan));
  console.log(`Manual coverage needed: ${[...selection.manual, ...selection.missing].join(", ") || "none"}`);
  const result = selection.noRelevant && !tests.length ? "no-relevant-changes" : selection.needsManual ? "manual-selection-required" : "passed";
  if (dryRun) {
    console.log(`Plan only: ${result}; no tests executed`);
    console.log(`verify: result=plan-only run=none base=${base ? resolveBase(base, cwd).integrationBase : "none"}`);
    return selection.needsManual ? 3 : 0;
  }
  return (await verify(cwd, mode, base, selection.targets.length ? [vitest(selection.targets)] : [], result, selection.needsManual ? 3 : 0)).exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 1; });
}
