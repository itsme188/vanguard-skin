import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Source-pin + behavior tests for the Claude Code hooks under .claude/hooks/
// (T4 of docs/superpowers/specs/2026-09-08-agent-coordination-design.md §7).
// Hooks are spawned as real bash subprocesses with JSON on stdin — this
// mirrors exactly how Claude Code itself invokes them, so it catches the
// "PostToolUse read $CLAUDE_FILE_PATHS which doesn't exist" class of bug
// that motivated this rewrite in the first place.

const ROOT = path.resolve(__dirname, "..", "..");
const HOOKS_DIR = path.join(ROOT, ".claude", "hooks");
const SETTINGS_PATH = path.join(ROOT, ".claude", "settings.json");

function runHook(
  scriptPath: string,
  stdin: string,
  extraEnv: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("bash", [scriptPath], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-hook-repo-"));
  spawnSync("git", ["init", "-q", "."], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "--allow-empty", "-q", "-m", "init"],
    { cwd: dir }
  );
  return dir;
}

describe("settings.json (source pin)", () => {
  const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
  let settings: any;

  it("parses as valid JSON", () => {
    expect(() => {
      settings = JSON.parse(raw);
    }).not.toThrow();
  });

  it("never references CLAUDE_FILE_PATHS (verified absent from the installed binary)", () => {
    expect(raw).not.toContain("CLAUDE_FILE_PATHS");
  });

  it("every hook command referencing .claude/hooks/ names an existing, executable file", () => {
    settings = JSON.parse(raw);
    const commands: string[] = [];
    for (const eventGroups of Object.values<any>(settings.hooks ?? {})) {
      for (const group of eventGroups) {
        for (const h of group.hooks ?? []) {
          if (typeof h.command === "string") commands.push(h.command);
        }
      }
    }
    expect(commands.length).toBeGreaterThan(0);

    const hookRefs = commands.filter((c) => c.includes(".claude/hooks/"));
    expect(hookRefs.length).toBeGreaterThan(0);

    for (const cmd of hookRefs) {
      const match = cmd.match(/\.claude\/hooks\/([A-Za-z0-9._-]+\.sh)/);
      expect(match, `could not extract a hook filename from: ${cmd}`).not.toBeNull();
      const file = path.join(HOOKS_DIR, match![1]);
      expect(fs.existsSync(file), `${file} does not exist`).toBe(true);
      expect(() => fs.accessSync(file, fs.constants.X_OK)).not.toThrow();
    }
  });

  it("no hook command loses its exit code through a trailing tail/head pipe", () => {
    settings = JSON.parse(raw);
    const commands: string[] = [];
    for (const eventGroups of Object.values<any>(settings.hooks ?? {})) {
      for (const group of eventGroups) {
        for (const h of group.hooks ?? []) {
          if (typeof h.command === "string") commands.push(h.command);
        }
      }
    }
    for (const cmd of commands) {
      expect(cmd).not.toMatch(/\|\s*(tail|head)\b/);
    }
  });

  it("PreToolUse Bash matcher stays exactly \"Bash\" (glob widening lives in the script)", () => {
    settings = JSON.parse(raw);
    const bashGroup = settings.hooks.PreToolUse.find((g: any) =>
      g.hooks.some((h: any) => typeof h.command === "string" && h.command.includes("check-todo-reconciled.sh"))
    );
    expect(bashGroup.matcher).toBe("Bash");
  });
});

describe("post-edit-check.sh", () => {
  const HOOK = path.join(HOOKS_DIR, "post-edit-check.sh");
  const TMP_PARENT = path.join(ROOT, "tests", "coord", ".tmp-hooks");
  let tmpDir: string;

  beforeEach(() => {
    fs.mkdirSync(TMP_PARENT, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(TMP_PARENT, "run-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const SKIP_ENV = { PD_HOOK_SKIP_ESLINT: "1", PD_HOOK_SKIP_TSC: "1" };

  it("flags a case-sensitive security_type comparison and names the file", () => {
    const file = path.join(tmpDir, "probe.ts");
    fs.writeFileSync(file, `const q = "security_type = 'Stock'";\n`);
    const stdin = JSON.stringify({ tool_input: { file_path: file } });
    const res = runHook(HOOK, stdin, { ...SKIP_ENV, CLAUDE_PROJECT_DIR: ROOT });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain(path.relative(ROOT, file));
    expect(res.stderr).toContain("LOWER(");
  });

  it("exits 0 with empty stderr for a clean file", () => {
    const file = path.join(tmpDir, "clean.ts");
    fs.writeFileSync(file, `export const x = 1;\n`);
    const stdin = JSON.stringify({ tool_input: { file_path: file } });
    const res = runHook(HOOK, stdin, { ...SKIP_ENV, CLAUDE_PROJECT_DIR: ROOT });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
  });

  it("exits 0 for a non-TS/JS path (e.g. .md)", () => {
    const file = path.join(tmpDir, "note.md");
    fs.writeFileSync(file, `# hi\n`);
    const stdin = JSON.stringify({ tool_input: { file_path: file } });
    const res = runHook(HOOK, stdin, { ...SKIP_ENV, CLAUDE_PROJECT_DIR: ROOT });
    expect(res.status).toBe(0);
  });

  it("exits 0 on empty stdin", () => {
    const res = runHook(HOOK, "", { ...SKIP_ENV, CLAUDE_PROJECT_DIR: ROOT });
    expect(res.status).toBe(0);
  });

  it("exits 0 for tool_input.path fallback and a path outside the project root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-project-"));
    const file = path.join(outside, "probe.ts");
    fs.writeFileSync(file, `const q = "security_type = 'Stock'";\n`);
    const stdin = JSON.stringify({ tool_input: { path: file } });
    const res = runHook(HOOK, stdin, { ...SKIP_ENV, CLAUDE_PROJECT_DIR: ROOT });
    expect(res.status).toBe(0);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe("stop-verify.sh", () => {
  const HOOK = path.join(HOOKS_DIR, "stop-verify.sh");
  let coordDir: string;
  let repoDir: string;

  beforeEach(() => {
    coordDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-dir-"));
    repoDir = makeGitRepo();
  });

  afterEach(() => {
    fs.rmSync(coordDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("stop_hook_active guard: never runs the verify command, marker not created", () => {
    const marker = path.join(repoDir, "marker");
    fs.writeFileSync(path.join(repoDir, "dirty.txt"), "x");
    const res = runHook(HOOK, JSON.stringify({ stop_hook_active: true }), {
      PD_COORD_DIR: coordDir,
      PD_STOP_VERIFY_CMD: `touch ${marker}`,
      CLAUDE_PROJECT_DIR: repoDir,
    });
    expect(res.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("clean working tree: exits 0 without running the verify command", () => {
    const marker = path.join(repoDir, "marker");
    const res = runHook(HOOK, "{}", {
      PD_COORD_DIR: coordDir,
      PD_STOP_VERIFY_CMD: `touch ${marker}`,
      CLAUDE_PROJECT_DIR: repoDir,
    });
    expect(res.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("real failure (exit 7): exits 2, stderr names the exit code, log file is written", () => {
    fs.writeFileSync(path.join(repoDir, "dirty.txt"), "x");
    const res = runHook(HOOK, "{}", {
      PD_COORD_DIR: coordDir,
      PD_STOP_VERIFY_CMD: "exit 7",
      CLAUDE_PROJECT_DIR: repoDir,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("FAILED (exit 7)");
    const logs = fs.readdirSync(path.join(coordDir, "logs")).filter((f) => f.startsWith("stop-verify-") && f.endsWith(".log"));
    expect(logs.length).toBeGreaterThan(0);
  });

  it("advisory exit 4 (no current evidence): exit 0, systemMessage JSON on stdout, stderr empty", () => {
    fs.writeFileSync(path.join(repoDir, "dirty.txt"), "x");
    const res = runHook(HOOK, "{}", {
      PD_COORD_DIR: coordDir,
      PD_STOP_VERIFY_CMD: "exit 4",
      CLAUDE_PROJECT_DIR: repoDir,
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    const parsed = JSON.parse(res.stdout);
    expect(parsed.systemMessage).toContain("no current evidence");
  });

  it("advisory exit 3 (manual test selection): exit 0, systemMessage JSON on stdout, stderr empty", () => {
    fs.writeFileSync(path.join(repoDir, "dirty.txt"), "x");
    const res = runHook(HOOK, "{}", {
      PD_COORD_DIR: coordDir,
      PD_STOP_VERIFY_CMD: "exit 3",
      CLAUDE_PROJECT_DIR: repoDir,
    });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    const parsed = JSON.parse(res.stdout);
    expect(parsed.systemMessage).toContain("manual test selection");
  });

  it("a prior failure is remembered: a later stop_hook_active run reports it as possibly unresolved", () => {
    fs.writeFileSync(path.join(repoDir, "dirty.txt"), "x");
    const first = runHook(HOOK, "{}", {
      PD_COORD_DIR: coordDir,
      PD_STOP_VERIFY_CMD: "exit 7",
      CLAUDE_PROJECT_DIR: repoDir,
    });
    expect(first.status).toBe(2);

    const statusFile = path.join(coordDir, "logs", "stop-verify-last-status");
    expect(fs.existsSync(statusFile)).toBe(true);
    expect(fs.readFileSync(statusFile, "utf8")).toMatch(/^failed\t/);

    const marker = path.join(repoDir, "should-not-run");
    const second = runHook(HOOK, JSON.stringify({ stop_hook_active: true }), {
      PD_COORD_DIR: coordDir,
      PD_STOP_VERIFY_CMD: `touch ${marker}`,
      CLAUDE_PROJECT_DIR: repoDir,
    });
    expect(second.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    const parsed = JSON.parse(second.stdout);
    expect(parsed.systemMessage).toContain("unresolved");
  });

  it("a genuine pass (exit 0) is silent", () => {
    fs.writeFileSync(path.join(repoDir, "dirty.txt"), "x");
    const res = runHook(HOOK, "{}", {
      PD_COORD_DIR: coordDir,
      PD_STOP_VERIFY_CMD: "exit 0",
      CLAUDE_PROJECT_DIR: repoDir,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });
});

describe("check-todo-reconciled.sh", () => {
  const HOOK = path.join(HOOKS_DIR, "check-todo-reconciled.sh");
  let repoDir: string;

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("denies `npm run deploy` when commits landed after the last TODO.md update", () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-todo-repo-"));
    spawnSync("git", ["init", "-q", "."], { cwd: repoDir });
    fs.mkdirSync(path.join(repoDir, "docs", "plans"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "docs", "plans", "TODO.md"), "todo\n");
    spawnSync("git", ["add", "docs/plans/TODO.md"], { cwd: repoDir });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-q", "-m", "todo"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "other.txt"), "later\n");
    spawnSync("git", ["add", "other.txt"], { cwd: repoDir });
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-q", "-m", "later"], { cwd: repoDir });

    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ tool_input: { command: "npm run deploy" } }),
      encoding: "utf8",
      cwd: repoDir,
      env: process.env,
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("exits 0 with empty stdout for a non-matching command", () => {
    repoDir = makeGitRepo();
    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ tool_input: { command: "ls" } }),
      encoding: "utf8",
      cwd: repoDir,
      env: process.env,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });
});
