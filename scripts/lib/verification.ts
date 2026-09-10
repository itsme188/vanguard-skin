import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { git, getChangedFiles, resolveBase } from "./git-changed";
import { planVerification } from "./verify-mapping";

export function projectRoot(cwd: string): string | null {
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    return pkg.name === "vanguard-skin" && pkg.repository?.url === "https://github.com/itsme188/vanguard-skin.git" ? root : null;
  } catch { return null; }
}

export function focusedSelection(changed: string[], cwd: string, manualTests: string[] = []) {
  // Documentation alone is deliberately not a claim that executable changes passed.
  const relevant = changed.filter((p) => !p.endsWith(".md"));
  const plan = planVerification(relevant);
  const manual = relevant.filter((p) => planVerification([p]).selectedTests.length === 0);
  const targets = [...new Set([...plan.selectedTests, ...manualTests])].filter((p) => existsSync(path.join(cwd, p)));
  const missing = [...plan.selectedTests, ...manualTests].filter((p) => !existsSync(path.join(cwd, p)));
  return { plan, targets, manual, missing, noRelevant: relevant.length === 0,
    needsManual: missing.length > 0 || (manualTests.length === 0 && (manual.length > 0 || (relevant.length > 0 && targets.length === 0))) };
}

export function snapshot(cwd: string, base?: string) {
  const head = git(cwd, ["rev-parse", "HEAD"]).trim();
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const hash = createHash("sha256");
  for (const args of [["diff", "--binary", "--no-ext-diff", "HEAD", "--"], ["diff", "--binary", "--no-ext-diff", "--cached", "--"]]) hash.update(git(cwd, args));
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  for (const file of untracked) {
    const absolute = path.join(cwd, file);
    const stat = lstatSync(absolute);
    hash.update(JSON.stringify([file, stat.mode]));
    hash.update(stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute));
  }
  hash.update(status);
  const bases = base ? resolveBase(base, cwd) : null;
  const state = { head, dirtyHash: hash.digest("hex"), bases, node: process.version, changed: getChangedFiles({ cwd, base }) };
  return { ...state, fingerprint: createHash("sha256").update(JSON.stringify(state)).digest("hex") };
}

export function evidenceDirectory(cwd: string): string {
  // Worktree-specific git directory; never pollutes the measured working diff.
  return path.join(git(cwd, ["rev-parse", "--absolute-git-dir"]).trim(), "verification");
}

export type CommandResult = { command: string; args: string[]; exitCode: number; signal: string | null; log: string };
export async function runLogged(command: string, args: string[], cwd: string, log: string): Promise<CommandResult> {
  const fd = openSync(log, "w", 0o600);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data: Buffer) => {
      writeSync(fd, data); process.stderr.write(data);
    });
    child.on("error", (error) => { writeSync(fd, `${error}\n`); process.stderr.write(`${error}\n`); });
    child.on("close", (status, signal) => {
      closeSync(fd);
      resolve({ command, args, exitCode: status ?? 1, signal, log });
    });
  });
}

export type Evidence = {
  schema: 1; id: string; mode: string; base?: string; startedAt: string; finishedAt: string;
  before: ReturnType<typeof snapshot>; after: ReturnType<typeof snapshot>;
  result: string; exitCode: number; commands: CommandResult[];
};
export async function verify(cwd: string, mode: string, base: string | undefined, commands: { command: string; args: string[] }[], initialResult = "passed", initialCode = 0): Promise<Evidence> {
  const dir = evidenceDirectory(cwd); mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${randomUUID()}`;
  const before = snapshot(cwd, base);
  const latest = path.join(dir, `${mode}-latest.json`);
  writeFileSync(latest, JSON.stringify({ schema: 1, id, mode, result: "running" }), { mode: 0o600 });
  const startedAt = new Date().toISOString();
  const results: CommandResult[] = [];
  let exitCode = initialCode;
  for (const [i, command] of commands.entries()) {
    const result = await runLogged(command.command, command.args, cwd, path.join(dir, `${id}-${i}.log`));
    results.push(result);
    if (result.exitCode !== 0) { exitCode = result.exitCode; break; }
  }
  const after = snapshot(cwd, base);
  const changedDuringRun = before.fingerprint !== after.fingerprint;
  if (changedDuringRun && exitCode === 0) exitCode = 4;
  const result = changedDuringRun ? "stale" : results.some((r) => r.exitCode !== 0) ? "failed" : initialResult;
  const evidence: Evidence = { schema: 1, id, mode, base, startedAt, finishedAt: new Date().toISOString(), before, after, result, exitCode, commands: results };
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  const temp = `${latest}.${id}.tmp`;
  if (JSON.parse(readFileSync(latest, "utf8")).id === id) {
    writeFileSync(temp, JSON.stringify(evidence, null, 2), { mode: 0o600 }); renameSync(temp, latest);
  }
  console.log(`Verification: ${result}; exit ${exitCode}; evidence ${path.join(dir, `${id}.json`)}`);
  console.log(`verify: result=${result} run=${id} base=${before.bases?.integrationBase ?? "none"}`);
  return evidence;
}

export function currentEvidence(cwd: string, mode = "full", base?: string): Evidence | null {
  try {
    const saved: Evidence = JSON.parse(readFileSync(path.join(evidenceDirectory(cwd), `${mode}-latest.json`), "utf8"));
    if (saved.schema !== 1 || saved.mode !== mode || saved.result !== "passed" || saved.exitCode !== 0 || !saved.commands.length) return null;
    if (mode === "full" && !saved.base) return null;
    const current = snapshot(cwd, base ?? saved.base);
    return current.fingerprint === saved.before.fingerprint && current.fingerprint === saved.after.fingerprint ? saved : null;
  } catch { return null; }
}
