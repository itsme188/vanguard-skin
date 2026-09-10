import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source = process.cwd();
const temporary: string[] = [];
const fixtureEnv = { ...process.env, PATH: `/opt/homebrew/opt/node@24/bin:${process.env.PATH}`, ANTHROPIC_API_KEY: "verification-fixture-only" };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "workflow-integration-")); temporary.push(root);
  const cwd = path.join(root, "renamed-checkout"); mkdirSync(cwd);
  const put = (file: string, content: string) => { mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); writeFileSync(path.join(cwd, file), content); };
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Workflow Fixture"); git("config", "user.email", "fixture@example.invalid");
  put("package.json", JSON.stringify({ name: "vanguard-skin", repository: { url: "https://github.com/itsme188/vanguard-skin.git" } }));
  put(".gitignore", "node_modules/\n");
  for (const file of ["scripts/verify.sh", "scripts/verify-runner.ts", "scripts/lib/git-changed.ts", "scripts/lib/verification.ts", "scripts/lib/verification-loader.mjs", "scripts/lib/verify-mapping.ts"]) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); cpSync(path.join(source, file), path.join(cwd, file));
  }
  git("add", "."); git("commit", "-qm", "integration base"); git("checkout", "-qb", "task");
  put("tests/example.test.ts", "// synthetic runner target\n"); git("add", "."); git("commit", "-qm", "committed task changes");
  put("node_modules/vitest/vitest.mjs", "console.error('synthetic child result'); process.exit(Number(process.env.FIXTURE_TEST_EXIT || 0));\n");
  const coord = path.join(root, "coord");
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bash", ["scripts/verify.sh", ...args], { cwd, env: { ...fixtureEnv, ...env }, encoding: "utf8" });
  const stop = (agent: "claude" | "codex", session = "fixture-A", active = false, env: Record<string, string> = {}) => spawnSync("bash", [path.join(source, agent === "claude" ? ".claude/hooks/stop-verify.sh" : ".codex/hooks/stop-vitest.sh")], { cwd, input: JSON.stringify({ cwd, session_id: session, stop_hook_active: active }), env: { ...fixtureEnv, CLAUDE_PROJECT_DIR: cwd, PD_COORD_DIR: coord, ...env }, encoding: "utf8" });
  return { root, cwd, put, git, coord, run, stop };
}
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("combined Claude/Codex verification contract", () => {
  it("both hooks enforce evidence for a clean committed branch and accept only current full evidence", () => {
    const f = fixture(); expect(f.git("status", "--porcelain")).toBe("");
    for (const agent of ["claude", "codex"] as const) {
      const result = f.stop(agent); expect(result.status, `${agent}: ${result.stdout} ${result.stderr}`).toBe(2);
      expect(result.stderr).toContain("verify.sh full --base");
    }
    expect(f.run(["changed", "--base", "main"]).status).toBe(0);
    expect(f.stop("claude").status).toBe(2);
    expect(f.run(["full", "--base", "main"]).status).toBe(0);
    const passedStop = f.stop("claude"); expect(passedStop.status, passedStop.stderr + passedStop.stdout).toBe(0); expect(f.stop("codex").status).toBe(0);
    f.put("tests/example.test.ts", "// newer content\n"); f.git("add", "."); f.git("commit", "-qm", "newer task commit");
    expect(f.git("status", "--porcelain")).toBe("");
    expect(f.stop("claude").status).toBe(2); expect(f.stop("codex").status).toBe(2);
  }, 30_000); // Multiple real Node/Git/hook subprocesses; allow full-suite CPU contention.
  it("preserves failing child results and neither hook treats a failed full run as verified", () => {
    const f = fixture();
    const failed = f.run(["full", "--base", "main"], { FIXTURE_TEST_EXIT: "17" });
    expect(failed.status).toBe(17); expect(failed.stderr).toContain("synthetic child result");
    expect(f.stop("claude").status).toBe(2); expect(f.stop("codex").status).toBe(2);
  });
  it("keeps separate sessions' outcomes and unique logs in a shared coordination directory", () => {
    const f = fixture(); f.put("dirty.txt", "fixture");
    expect(f.stop("claude", "A", false, { PD_STOP_VERIFY_CMD: "echo session-A; exit 4" }).status).toBe(2);
    expect(f.stop("claude", "B", false, { PD_STOP_VERIFY_CMD: "echo session-B; exit 0" }).status).toBe(0);
    const resumed = f.stop("claude", "A", true);
    expect(JSON.parse(resumed.stdout).systemMessage).toMatch(/unverified|no verification evidence/);
    function logs(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? logs(path.join(dir, e.name)) : e.name.endsWith(".log") ? [readFileSync(path.join(dir, e.name), "utf8")] : []); }
    const saved = logs(f.coord);
    expect(saved.some((log) => log.includes("session-A") && !log.includes("session-B"))).toBe(true);
    expect(saved.some((log) => log.includes("session-B") && !log.includes("session-A"))).toBe(true);
  });
  it("keeps simultaneous Stop hooks from separate sessions and worktrees isolated", async () => {
    const a = fixture(); const b = fixture();
    function asyncStop(f: ReturnType<typeof fixture>, session: string, cmd: string) {
      return new Promise<number | null>((resolve) => {
        const child = spawn("bash", [path.join(source, ".claude/hooks/stop-verify.sh")], { cwd: f.cwd, env: { ...fixtureEnv, CLAUDE_PROJECT_DIR: f.cwd, PD_COORD_DIR: a.coord, PD_STOP_VERIFY_CMD: cmd }, stdio: ["pipe", "ignore", "ignore"] });
        child.stdin.end(JSON.stringify({ cwd: f.cwd, session_id: session, stop_hook_active: false }));
        child.on("close", resolve);
      });
    }
    expect(await Promise.all([
      asyncStop(a, "same-session", "echo from-A; sleep 0.1; exit 4"),
      asyncStop(b, "same-session", "echo from-B; exit 0"),
      asyncStop(a, "other-session", "echo other-A; exit 0"),
    ])).toEqual([2, 0, 0]);
    expect(JSON.parse(a.stop("claude", "same-session", true).stdout).systemMessage).toContain("no verification evidence");
    const scopes = readdirSync(path.join(a.coord, "logs", "stop-verify")); expect(scopes).toHaveLength(3);
  });

  it("releases its named lock when the command cannot launch and preserves the failure", () => {
    const f = fixture(); const coord = path.join(source, "scripts/coord/coord.sh");
    const call = (cmd: string[]) => spawnSync("bash", [coord, "lock", "run", "integration", "--task", "fixture", "--exclusive", "--", ...cmd], { cwd: f.cwd, env: { ...fixtureEnv, PD_COORD_DIR: f.coord }, encoding: "utf8" });
    const missing = call(["/nonexistent-portfolio-command"]);
    expect(missing.status, missing.stderr).toBe(127); expect(missing.stderr).toContain("could not launch");
    expect(readdirSync(path.join(f.coord, "locks"))).toEqual([]);
    f.put("not-executable", "fixture"); expect(call([path.join(f.cwd, "not-executable")]).status).toBe(126);
    expect(readdirSync(path.join(f.coord, "locks"))).toEqual([]);
    expect(call(["/bin/sh", "-c", "exit 17"]).status).toBe(17);
    expect(readdirSync(path.join(f.coord, "locks"))).toEqual([]);
  });

  it("lock run is exclusive even for the same task ID and cannot release an outer holder", async () => {
    const f = fixture(); const coord = path.join(source, "scripts/coord/coord.sh");
    const env = { ...fixtureEnv, PD_COORD_DIR: f.coord };
    const holder = spawnSync("bash", [coord, "lock", "acquire", "integration", "--task", "same", "--pid", String(process.pid)], { cwd: f.cwd, env, encoding: "utf8" });
    expect(holder.status).toBe(0);
    const owner = path.join(f.coord, "locks/integration/owner.json");
    const before = readFileSync(owner, "utf8");
    const contender = spawnSync("bash", [coord, "lock", "run", "integration", "--task", "same", "--", "/nonexistent-command"], { cwd: f.cwd, env, encoding: "utf8" });
    expect(contender.status, contender.stderr).toBe(75);
    expect(readFileSync(owner, "utf8")).toBe(before);
    const waiting = spawn("bash", [coord, "lock", "run", "integration", "--task", "same", "--wait", "5", "--", "/bin/sh", "-c", "exit 17"], { cwd: f.cwd, env, stdio: "ignore" });
    const finished = new Promise<number | null>((resolve) => waiting.on("close", resolve));
    spawnSync("bash", [coord, "lock", "release", "integration", "--task", "same"], { cwd: f.cwd, env });
    expect(await finished).toBe(17); expect(existsSync(owner)).toBe(false);
  });

});
