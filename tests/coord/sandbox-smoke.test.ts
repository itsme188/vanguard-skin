import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * scripts/coord/sandbox.sh + scripts/coord/smoke.sh + the additive
 * scripts/verify-smoke.sh env hooks — design
 * docs/superpowers/specs/2026-09-08-agent-coordination-design.md §5, §6 and
 * the §11 review fold (F15-F20).
 *
 * Everything runs against a temp PD_COORD_DIR with PD_SANDBOX_TEST_MODE=1:
 * the "dev server" is a python http.server serving a fake /login page and the
 * "session mint" is a two-line shell script, so no Next build, no real
 * database and no reserved port (3000/3097/3099) is ever touched.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SANDBOX_SH = path.join(REPO_ROOT, "scripts", "coord", "sandbox.sh");
const SMOKE_SH = path.join(REPO_ROOT, "scripts", "coord", "smoke.sh");
const COORD_SH = path.join(REPO_ROOT, "scripts", "coord", "coord.sh");
const VERIFY_SMOKE_SH = path.join(REPO_ROOT, "scripts", "verify-smoke.sh");
const PYTHON = "/usr/bin/python3";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

let root: string;
let coordDir: string;
let worktree: string;
let sourceDb: string;
let envDump: string;
let mintScript: string;
let devScript: string;
let fakeSmoke: string;
const startedTasks: string[] = [];
const startedPids: number[] = [];

function write(file: string, content: string, mode?: number): void {
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pd-sandbox-test-"));
  coordDir = path.join(root, "coord");
  worktree = path.join(root, "wt");
  sourceDb = path.join(root, "source.db");
  envDump = path.join(root, "env.dump");
  mintScript = path.join(root, "mint.sh");
  devScript = path.join(root, "dev.sh");
  fakeSmoke = path.join(root, "fake-smoke.sh");

  fs.mkdirSync(coordDir);
  fs.mkdirSync(worktree);
  write(path.join(worktree, "package.json"), "{}\n");
  // Two dotenv keys that MUST reach the child pinned to empty (F15).
  write(path.join(worktree, ".env.local"), "FAKE_SECRET=abc\nANOTHER=1\n");
  // Never pinned, never read: the exempt example file.
  write(path.join(worktree, ".env.local.example"), "EXAMPLE_ONLY=1\n");

  const serve = path.join(root, "serve");
  fs.mkdirSync(serve);
  write(path.join(serve, "login"), "<h1>Portfolio Desk</h1>\n");

  const seed = spawnSync(
    PYTHON,
    [
      "-c",
      [
        "import sqlite3, sys",
        "con = sqlite3.connect(sys.argv[1])",
        "con.execute('CREATE TABLE marker (id INTEGER PRIMARY KEY, label TEXT)')",
        "con.execute(\"INSERT INTO marker (label) VALUES ('sandbox-fixture')\")",
        "con.commit()",
        "con.close()",
      ].join("\n"),
      sourceDb,
    ],
    { encoding: "utf8" },
  );
  expect(seed.status, seed.stderr).toBe(0);

  write(mintScript, "#!/bin/bash\necho \"VGS_SESSION='x'\"\necho \"VGS_CSRF='y'\"\n", 0o755);
  write(
    devScript,
    [
      "#!/bin/bash",
      'env > "$PD_SANDBOX_DUMP"',
      `exec python3 -m http.server "$PD_SANDBOX_PORT" --bind 127.0.0.1 --directory ${serve}`,
      "",
    ].join("\n"),
    0o755,
  );
  write(fakeSmoke, "#!/bin/bash\nenv > \"$FAKE_SMOKE_DUMP\"\nexit 3\n", 0o755);
});

afterEach(() => {
  for (const task of startedTasks.splice(0)) {
    spawnSync("bash", [SANDBOX_SH, "down", "--task", task, "--purge"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PD_COORD_DIR: coordDir },
      encoding: "utf8",
    });
  }
  for (const pid of startedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function run(script: string, args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync("bash", [script, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, PD_COORD_DIR: coordDir, ...extraEnv },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function sandboxEnv(): Record<string, string> {
  return {
    PD_SANDBOX_TEST_MODE: "1",
    PD_SANDBOX_MINT_CMD: `bash ${mintScript}`,
    PD_SANDBOX_DEV_CMD: `bash ${devScript}`,
    PD_SANDBOX_DUMP: envDump,
  };
}

function up(task: string, args: string[] = [], extraEnv: Record<string, string> = {}): RunResult {
  const result = run(
    SANDBOX_SH,
    ["up", "--task", task, "--worktree", worktree, "--db-source", sourceDb, ...args],
    { ...sandboxEnv(), ...extraEnv },
  );
  if (result.status === 0) {
    startedTasks.push(task);
    const pid = Number(field(result.stdout, "PID"));
    if (Number.isFinite(pid) && pid > 0) startedPids.push(pid);
  }
  return result;
}

function field(stdout: string, key: string): string {
  const line = stdout.split("\n").find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : "";
}

function parseEnvDump(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function listenerOn(port: number | string): string {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  return (result.stdout ?? "").trim();
}

function readManifest(task: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(coordDir, "sandboxes", task, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
}

function writeManifest(task: string, data: Record<string, unknown>): string {
  const dir = path.join(coordDir, "sandboxes", task);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "manifest.json");
  write(file, JSON.stringify(data, null, 2));
  return file;
}

function sessionEnvFile(): string {
  const file = path.join(root, "session.env");
  write(file, "VGS_SESSION='x'\nVGS_CSRF='y'\n");
  return file;
}

describe("scripts/coord/sandbox.sh", () => {
  it(
    "boots an isolated sandbox, refuses a second task on the same worktree, and stops cleanly",
    () => {
      const before = fs.statSync(sourceDb);

      const result = up("t1");
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      // --- manifest ---
      const manifest = readManifest("t1");
      expect(manifest.task).toBe("t1");
      const port = Number(manifest.port);
      expect(port).toBeGreaterThanOrEqual(3090);
      expect(port).toBeLessThanOrEqual(3096);
      expect(manifest.base_url).toBe(`http://localhost:${port}`);
      expect(manifest.lock).toBe(`sandbox:${path.basename(worktree)}`);
      expect(field(result.stdout, "BASE_URL")).toBe(`http://localhost:${port}`);
      expect(field(result.stdout, "DB")).toBe(manifest.db);

      // --- the DB the server sees is a COPY, and the source is untouched ---
      const copy = String(manifest.db);
      expect(copy).not.toBe(sourceDb);
      expect(fs.existsSync(copy)).toBe(true);
      const rows = spawnSync(
        PYTHON,
        ["-c", "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('SELECT label FROM marker').fetchall())", copy],
        { encoding: "utf8" },
      );
      expect(rows.status, rows.stderr).toBe(0);
      expect(rows.stdout).toContain("sandbox-fixture");
      const after = fs.statSync(sourceDb);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);

      // --- child environment: secret-free by construction ---
      const childEnv = parseEnvDump(envDump);
      expect(childEnv).toHaveProperty("FAKE_SECRET");
      expect(childEnv.FAKE_SECRET).toBe("");
      expect(childEnv).toHaveProperty("ANOTHER");
      expect(childEnv.ANOTHER).toBe("");
      expect(childEnv.TWS_HOST).toBe("192.0.2.1");
      expect(childEnv.DATABASE_PATH).toBe(copy);
      expect(childEnv.ANTHROPIC_API_KEY).toBe("sk-ant-test-dummy-not-real");
      // .env.local.example is documentation, not a dotenv source: not pinned,
      // not passed through.
      expect(childEnv).not.toHaveProperty("EXAMPLE_ONLY");
      for (const [key, value] of Object.entries(childEnv)) {
        if (key.includes("ANTHROPIC") && key !== "ANTHROPIC_API_KEY") {
          expect(value, `${key} leaked into the sandbox`).toBe("");
        }
      }

      // --- one sandbox per worktree ---
      const second = run(
        SANDBOX_SH,
        ["up", "--task", "t2", "--worktree", worktree, "--db-source", sourceDb],
        sandboxEnv(),
      );
      expect(second.status).toBe(75);
      expect(second.stderr).toContain("sandbox:");
      expect(fs.existsSync(path.join(coordDir, "sandboxes", "t2", "manifest.json"))).toBe(false);

      // --- down: server gone, lock released, evidence kept ---
      const down = run(SANDBOX_SH, ["down", "--task", "t1"]);
      expect(down.status, down.stderr).toBe(0);
      expect(listenerOn(port)).toBe("");
      expect(fs.existsSync(path.join(coordDir, "locks", `sandbox:${path.basename(worktree)}`))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(coordDir, "sandboxes", "t1", "manifest.json"))).toBe(true);

      // --- down --purge: evidence removed ---
      const purge = run(SANDBOX_SH, ["down", "--task", "t1", "--purge"]);
      expect(purge.status, purge.stderr).toBe(0);
      expect(fs.existsSync(path.join(coordDir, "sandboxes", "t1"))).toBe(false);
      startedTasks.splice(0);
    },
    30000,
  );

  it("refuses reserved ports and malformed task ids", () => {
    for (const port of ["3000", "3097", "3099"]) {
      const result = run(
        SANDBOX_SH,
        ["up", "--task", "tp", "--worktree", worktree, "--db-source", sourceDb, "--port", port],
        sandboxEnv(),
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("reserved");
    }

    const bad = run(
      SANDBOX_SH,
      ["up", "--task", "bad id!", "--worktree", worktree, "--db-source", sourceDb],
      sandboxEnv(),
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("invalid --task id");
  });

  it(
    "refuses a --db-source that aliases the sandbox copy but accepts a symlink to the real source",
    () => {
      const dest = path.join(coordDir, "sandboxes", "t3", "vanguard.db");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      write(dest, "");
      const aliased = run(
        SANDBOX_SH,
        ["up", "--task", "t3", "--worktree", worktree, "--db-source", dest],
        sandboxEnv(),
      );
      expect(aliased.status).toBe(1);
      expect(aliased.stderr).toContain("refused");

      // A symlink to the real source resolves (realpath) and is accepted.
      const link = path.join(root, "link.db");
      fs.symlinkSync(sourceDb, link);
      const viaLink = run(
        SANDBOX_SH,
        ["up", "--task", "t5", "--worktree", worktree, "--db-source", link],
        sandboxEnv(),
      );
      expect(viaLink.status, `${viaLink.stdout}\n${viaLink.stderr}`).toBe(0);
      startedTasks.push("t5");
      const pid = Number(field(viaLink.stdout, "PID"));
      if (Number.isFinite(pid) && pid > 0) startedPids.push(pid);

      const down = run(SANDBOX_SH, ["down", "--task", "t5", "--purge"]);
      expect(down.status, down.stderr).toBe(0);
      expect(fs.existsSync(path.join(coordDir, "sandboxes", "t5"))).toBe(false);
      startedTasks.splice(0);
    },
    30000,
  );
});

describe("scripts/coord/smoke.sh", () => {
  it("refuses to run without a sandbox manifest unless --live is given", () => {
    const result = run(SMOKE_SH, ["--task", "nosandbox"], {
      PD_SMOKE_TEST_MODE: "1",
      PD_SMOKE_SCRIPT: fakeSmoke,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("manifest");
    expect(fs.existsSync(path.join(coordDir, "locks", "browser"))).toBe(false);
  });

  it("refuses a non-loopback --base-url", () => {
    const result = run(SMOKE_SH, ["--task", "t1", "--base-url", "http://example.com"], {
      PD_SMOKE_TEST_MODE: "1",
      PD_SMOKE_SCRIPT: fakeSmoke,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("loopback");
  });

  it(
    "runs the smoke script against the sandbox, preserves its exit code, releases the browser lock and checkpoints",
    () => {
      const register = run(COORD_SH, [
        "task",
        "register",
        "--id",
        "t1",
        "--owner",
        "claude",
        "--branch",
        "test-branch",
        "--worktree",
        worktree,
      ]);
      expect(register.status, register.stderr).toBe(0);

      const booted = up("t1");
      expect(booted.status, `${booted.stdout}\n${booted.stderr}`).toBe(0);
      const manifest = readManifest("t1");

      const smokeDump = path.join(root, "smoke-env.dump");
      const result = run(SMOKE_SH, ["--task", "t1"], {
        PD_SMOKE_TEST_MODE: "1",
        PD_SMOKE_SCRIPT: fakeSmoke,
        FAKE_SMOKE_DUMP: smokeDump,
      });
      expect(result.status).toBe(3);
      expect(result.stdout).toContain("SMOKE exit=3");

      const smokeEnv = parseEnvDump(smokeDump);
      expect(smokeEnv.VERIFY_SMOKE_BASE_URL).toBe(manifest.base_url);
      expect(smokeEnv.VERIFY_SMOKE_SESSION).toBe("smoke-t1");
      expect(smokeEnv.VERIFY_SMOKE_NO_GLOBAL_CLEANUP).toBe("1");
      expect(smokeEnv.VERIFY_SMOKE_SESSION_ENV).toBe(manifest.session_env);
      expect(smokeEnv.DATABASE_PATH).toBe(manifest.db);
      expect(fs.existsSync(smokeEnv.VERIFY_SMOKE_EVIDENCE_DIR)).toBe(true);

      expect(fs.existsSync(path.join(coordDir, "locks", "browser"))).toBe(false);

      const shown = run(COORD_SH, ["task", "show", "t1", "--json"]);
      expect(shown.status, shown.stderr).toBe(0);
      const record = JSON.parse(shown.stdout) as {
        last_checkpoint: { note: string } | null;
        evidence: string | null;
      };
      expect(record.last_checkpoint?.note).toContain("smoke exit 3");
      expect(record.evidence).toBe(smokeEnv.VERIFY_SMOKE_EVIDENCE_DIR);
    },
    30000,
  );

  it(
    "serializes two concurrent runs behind the browser lock",
    async () => {
      const sessionEnv = sessionEnvFile();
      const timeline = path.join(root, "timeline.log");
      const slowPy = path.join(root, "slow-smoke.py");
      write(
        slowPy,
        [
          "import os, time",
          'handle = open(os.environ["SLOW_LOG"], "a")',
          'handle.write("start %d\\n" % int(time.time() * 1000))',
          "handle.flush()",
          "time.sleep(1.5)",
          'handle.write("end %d\\n" % int(time.time() * 1000))',
          "handle.close()",
          "",
        ].join("\n"),
      );
      const slow = path.join(root, "slow-smoke.sh");
      write(slow, ["#!/bin/bash", `exec ${PYTHON} ${slowPy}`, ""].join("\n"), 0o755);

      for (const task of ["c1", "c2"]) {
        writeManifest(task, {
          task,
          worktree,
          port: 3090,
          base_url: "http://localhost:3090",
          db: sourceDb,
          session_env: sessionEnv,
          server_log: path.join(root, "server.log"),
          npm_pid: 1,
          listener_pid: 1,
          lock: "sandbox:wt",
          started_at: "2026-09-08T00:00:00Z",
        });
      }

      const spawnSmoke = (task: string): Promise<number> =>
        new Promise((resolve) => {
          const child = spawn("bash", [SMOKE_SH, "--task", task], {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              PD_COORD_DIR: coordDir,
              PD_SMOKE_TEST_MODE: "1",
              PD_SMOKE_SCRIPT: slow,
              SLOW_LOG: timeline,
            },
            stdio: "ignore",
          });
          child.on("close", (code) => resolve(code ?? -1));
        });

      const [a, b] = await Promise.all([spawnSmoke("c1"), spawnSmoke("c2")]);
      expect(a).toBe(0);
      expect(b).toBe(0);

      const lines = fs
        .readFileSync(timeline, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(4);
      expect(lines[0].startsWith("start")).toBe(true);
      expect(lines[1].startsWith("end")).toBe(true);
      expect(lines[2].startsWith("start")).toBe(true);
      const firstEnd = Number(lines[1].split(" ")[1]);
      const secondStart = Number(lines[2].split(" ")[1]);
      expect(secondStart).toBeGreaterThanOrEqual(firstEnd);
      expect(fs.existsSync(path.join(coordDir, "locks", "browser"))).toBe(false);
    },
    30000,
  );
});

describe("scripts/verify-smoke.sh additive hooks", () => {
  it("keeps its defaults and gains the four wrapper hooks", () => {
    const source = fs.readFileSync(VERIFY_SMOKE_SH, "utf8");
    expect(source).toContain("VERIFY_SMOKE_BASE_URL");
    expect(source).toContain("VERIFY_SMOKE_SESSION_ENV");
    expect(source).toContain("VERIFY_SMOKE_NO_GLOBAL_CLEANUP");
    expect(source).toContain("VERIFY_SMOKE_EVIDENCE_DIR");
    // Default server detection is untouched.
    expect(source).toContain("for port in 3000 3099");
    expect(source).toContain('SESSION="${VERIFY_SMOKE_SESSION:-verify-smoke-$$}"');
    // The password path is still the default when no session env is supplied.
    expect(source).toContain("VERIFY_SMOKE_PASSWORD is not set.");
    // Cookies are set from a JSON literal through stdin eval, never argv.
    expect(source).toContain('document.cookie = "vgs_session="');
    expect(source).toContain('document.cookie = "vgs_csrf="');
  });

  it("parses under bash for all three scripts", () => {
    for (const script of [SANDBOX_SH, SMOKE_SH, VERIFY_SMOKE_SH]) {
      const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
      expect(result.status, `${script}: ${result.stderr}`).toBe(0);
    }
  });
});
