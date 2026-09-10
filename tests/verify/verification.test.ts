import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getChangedFiles } from "../../scripts/lib/git-changed";
import { currentEvidence, focusedSelection, projectRoot, runLogged, snapshot, verify } from "../../scripts/lib/verification";

const roots: string[] = [];
function repo() {
  const cwd = mkdtempSync(path.join(tmpdir(), "renamed-portfolio-")); roots.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Verification Test");
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "vanguard-skin", repository: { url: "https://github.com/itsme188/vanguard-skin.git" } }));
  git("add", "."); git("commit", "-qm", "fixture base");
  return { cwd, git, base: git("rev-parse", "HEAD").trim(), put: (p: string, content = "fixture") => { mkdirSync(path.dirname(path.join(cwd, p)), { recursive: true }); writeFileSync(path.join(cwd, p), content); } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("checkout identity and complete task diff", () => {
  it("recognizes differently named linked worktrees and subdirectories, rejects another project", () => {
    const r = repo(); const linked = `${r.cwd}-linked`; roots.push(linked);
    r.git("worktree", "add", "--detach", linked);
    mkdirSync(path.join(linked, "nested"));
    expect(projectRoot(path.join(linked, "nested"))).toBe(realpathSync(linked));
    r.put("package.json", '{"name":"other"}'); expect(projectRoot(r.cwd)).toBeNull();
  });
  it("unions committed, staged, unstaged, and individual untracked files while preserving working mode", () => {
    const r = repo(); r.put("lib/compute/branch.ts"); r.git("add", "."); r.git("commit", "-qm", "branch change");
    r.put("lib/compute/staged.ts"); r.git("add", "."); r.put("package.json", readFileSync(path.join(r.cwd, "package.json"), "utf8") + "\n"); r.put("new/sub/file.ts");
    expect(getChangedFiles({ cwd: r.cwd })).toEqual(["lib/compute/staged.ts", "new/sub/file.ts", "package.json"]);
    expect(getChangedFiles({ cwd: r.cwd, base: r.base })).toEqual(["lib/compute/branch.ts", "lib/compute/staged.ts", "new/sub/file.ts", "package.json"]);
    expect(() => getChangedFiles({ cwd: r.cwd, base: "nonexistent" })).toThrow();
  });
  it("uses merge-base when integration branch advanced independently", () => {
    const r = repo(); r.git("branch", "integration"); r.put("task.ts"); r.git("add", "."); r.git("commit", "-qm", "task");
    const task = r.git("rev-parse", "HEAD").trim(); r.git("checkout", "-q", "integration"); r.put("unrelated.ts"); r.git("add", "."); r.git("commit", "-qm", "integration advanced"); r.git("checkout", "-q", "--detach", task);
    expect(getChangedFiles({ cwd: r.cwd, base: "integration" })).toEqual(["task.ts"]);
  });
  it("keeps both domains for a committed rename", () => {
    const r = repo(); r.put("lib/compute/old.ts"); r.git("add", "."); r.git("commit", "-qm", "old"); const base = r.git("rev-parse", "HEAD").trim();
    r.git("mv", "lib/compute/old.ts", "new.ts"); r.git("commit", "-qm", "rename");
    expect(getChangedFiles({ cwd: r.cwd, base })).toEqual(["lib/compute/old.ts", "new.ts"]);
  });
});

describe("selection and subprocess evidence", () => {
  it("distinguishes irrelevant docs from unmapped code, including mixed mapped/unmapped changes", () => {
    const r = repo(); r.put("tests/verify/example.test.ts");
    expect(focusedSelection(["docs/notes.md"], r.cwd).noRelevant).toBe(true);
    expect(focusedSelection(["unknown.ts"], r.cwd).needsManual).toBe(true);
    expect(focusedSelection(["tests/verify/example.test.ts", "unknown.ts"], r.cwd).needsManual).toBe(true);
    expect(focusedSelection(["unknown.ts"], r.cwd, ["tests/verify/example.test.ts"]).needsManual).toBe(false);
    expect(focusedSelection(["tests/deleted.test.ts"], r.cwd).needsManual).toBe(true);
  });
  it("preserves failing exit codes and all stdout/stderr instead of the last pipeline status", async () => {
    const r = repo(); const log = path.join(r.cwd, "result.log");
    const result = await runLogged(process.execPath, ["-e", "console.log('first failure'); console.error('last failure'); process.exit(17)"], r.cwd, log);
    expect(result.exitCode).toBe(17); expect(readFileSync(log, "utf8")).toContain("first failure"); expect(readFileSync(log, "utf8")).toContain("last failure");
    expect((await runLogged("/nonexistent-verification-command", [], r.cwd, log)).exitCode).not.toBe(0);
    expect((await runLogged(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], r.cwd, log)).signal).toBe("SIGTERM");
  });
  it("binds evidence to HEAD, index, working content, untracked content and integration base", async () => {
    const r = repo(); r.put("extra.ts", "one");
    const commands = [{ command: process.execPath, args: ["-e", "console.log('pass')"] }];
    const result = await verify(r.cwd, "full", r.base, commands);
    expect(currentEvidence(r.cwd)?.id).toBe(result.id);
    r.put("extra.ts", "two"); expect(currentEvidence(r.cwd)).toBeNull();
    r.put("extra.ts", "one"); expect(currentEvidence(r.cwd)?.id).toBe(result.id);
    r.git("add", "extra.ts"); expect(currentEvidence(r.cwd)).toBeNull();
    r.git("commit", "-qm", "new head"); expect(currentEvidence(r.cwd)).toBeNull();
    const newer = await verify(r.cwd, "full", r.base, commands);
    expect(newer.before.head).not.toBe(result.before.head);
    expect(currentEvidence(r.cwd, "full", "HEAD")).toBeNull();
  });
  it("records changes during a run as stale and a later failure replaces earlier passing evidence", async () => {
    const r = repo();
    const stale = await verify(r.cwd, "full", r.base, [{ command: process.execPath, args: ["-e", "require('fs').writeFileSync('new.ts','changed')"] }]);
    expect(stale.result).toBe("stale"); expect(stale.exitCode).toBe(4); expect(currentEvidence(r.cwd)).toBeNull();
    await verify(r.cwd, "full", r.base, [{ command: process.execPath, args: ["-e", "process.exit(0)"] }]);
    const fail = await verify(r.cwd, "full", r.base, [{ command: process.execPath, args: ["-e", "process.exit(7)"] }]);
    expect(fail.result).toBe("failed"); expect(fail.exitCode).toBe(7); expect(currentEvidence(r.cwd)).toBeNull();
    expect(snapshot(r.cwd).head).toBe(r.base);
  });
});

describe("Codex deployment TODO gate", () => {
  it("gates both the checked deployment wrapper and npm alias in renamed checkouts", () => {
    const r = repo(); r.put("docs/plans/TODO.md", "fixture todo"); r.git("add", "."); r.git("commit", "-qm", "todo reconciled");
    r.put("later.ts"); r.git("add", "."); r.git("commit", "-qm", "later code");
    for (const command of ["bash scripts/coord/deploy.sh", "npm run deploy", "npm run electron:deploy"]) {
      const result = spawnSync("bash", [path.resolve(".codex/hooks/check-todo-reconciled.sh")], { cwd: tmpdir(), input: JSON.stringify({ cwd: r.cwd, tool_input: { command } }), encoding: "utf8" });
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });
});

describe("Codex Stop adapter", () => {
  const hook = path.resolve(".codex/hooks/stop-vitest.sh");
  it("uses event cwd in renamed worktrees, blocks missing/failing evidence, limits continuation, permits current evidence", () => {
    const r = repo(); r.put("scripts/verify.sh", '#!/bin/bash\necho "verification failed with complete logs" >&2\nexit 7\n');
    const call = (active = false) => spawnSync("bash", [hook], { cwd: tmpdir(), input: JSON.stringify({ cwd: r.cwd, stop_hook_active: active }), encoding: "utf8" });
    const blocked = call(); expect(blocked.status).toBe(2); expect(blocked.stderr).toContain("verification failed with complete logs"); expect(blocked.stdout).toBe("");
    const repeated = call(true); expect(repeated.status).toBe(0); expect(JSON.parse(repeated.stdout).continue).toBe(false);
    r.put("scripts/verify.sh", "#!/bin/bash\nexit 0\n"); expect(call().status).toBe(0);
    r.put("package.json", '{"name":"unrelated"}'); expect(call().status).toBe(0);
  });
});

describe("native Node CLI end-to-end", () => {
  const node = "/opt/homebrew/opt/node@24/bin/node";
  const loader = path.resolve("scripts/lib/verification-loader.mjs");
  const cli = path.resolve("scripts/verify-runner.ts");
  function run(cwd: string, args: string[]) {
    return spawnSync(node, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", loader, cli, ...args], { cwd, encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } });
  }
  it("reports no-relevant versus manual-required, and dry-run does not manufacture evidence", () => {
    const r = repo(); r.put("docs/notes.md");
    const docs = run(r.cwd, ["changed"]); expect(docs.status, docs.stderr).toBe(0); expect(docs.stdout).toContain("no-relevant-changes");
    expect(docs.stdout.trim().split("\n").at(-1)).toMatch(/^verify: result=no-relevant-changes run=.+ base=none$/);
    r.put("unknown.ts"); const manual = run(r.cwd, ["changed"]); expect(manual.status, manual.stderr).toBe(3); expect(manual.stdout).toContain("manual-selection-required");
    expect(run(r.cwd, ["changed", "--dry-run"]).status).toBe(3);
    const missing = run(r.cwd, ["status"]); expect(missing.status).toBe(4); expect(missing.stdout).toContain("verify: result=stale-or-missing run=none base=none");
  });
  it("runs committed branch tests, propagates failure, and invalidates a previous full pass after an edit", () => {
    const r = repo(); r.put(".gitignore", "node_modules/\n"); r.git("add", "."); r.git("commit", "-qm", "ignore deps");
    const base = r.git("rev-parse", "HEAD").trim();
    r.put("tests/example.test.ts", "fixture"); r.git("add", "."); r.git("commit", "-qm", "committed test");
    r.put("node_modules/vitest/vitest.mjs", "console.error('subprocess failure detail'); process.exit(13)");
    expect(run(r.cwd, ["changed"]).stdout).toContain("no-relevant-changes");
    const fail = run(r.cwd, ["changed", "--base", base]); expect(fail.status, fail.stderr).toBe(13); expect(fail.stderr).toContain("subprocess failure detail");
    r.put("node_modules/vitest/vitest.mjs", "console.log('synthetic test pass')");
    expect(run(r.cwd, ["full", "--base", base]).status).toBe(0);
    expect(run(r.cwd, ["status", "--base", base]).status).toBe(0);
    r.put("tests/example.test.ts", "new edit"); expect(run(r.cwd, ["status", "--base", base]).status).toBe(4);
    expect(run(r.cwd, ["full"]).status).toBe(1);
  });
  it("extracts actual Codex patch paths for PostToolUse and surfaces lint failure", () => {
    const r = repo(); r.put("source.ts");
    r.put("node_modules/eslint/bin/eslint.js", "console.error('linted: '+process.argv.at(-1)); process.exit(9)");
    const result = spawnSync("bash", [path.resolve(".codex/hooks/post-edit-lint.sh")], { cwd: tmpdir(), input: JSON.stringify({ cwd: r.cwd, tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: source.ts\n@@\n-old\n+new\n*** End Patch" } }), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(2); expect(result.stderr).toContain("linted: source.ts"); expect(result.stderr).toContain("exit 9");
  });
});
