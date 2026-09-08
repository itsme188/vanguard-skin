import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Exercises scripts/coord/deploy.sh — the coordinated wrapper around the
 * Electron deploy chain (docs/superpowers/specs/2026-09-08-agent-coordination-design.md
 * sections 4 and 11).
 *
 * Every test builds a throwaway git repo + fake .app bundles + a fake three
 * step chain in a mkdtemp dir, and drives the wrapper entirely through its
 * PD_DEPLOY_TEST_MODE=1 seams. The real chain (npm run electron:*), the real
 * /Applications bundle and the real coord dir are never touched.
 *
 * The "installed app" is faked by a `python3 -m http.server` listener started
 * by the fake install.sh, so the post-verify listener + health probes run for
 * real against a real socket.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEPLOY_SH = path.join(REPO_ROOT, "scripts", "coord", "deploy.sh");
const COORD_SH = path.join(REPO_ROOT, "scripts", "coord", "coord.sh");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

interface Fixture {
  root: string;
  checkout: string;
  coordDir: string;
  chainDir: string;
  builtApp: string;
  installedApp: string;
  markersDir: string;
  pidFiles: string[];
  port: number;
  env: Record<string, string>;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const fx = fixtures.pop()!;
    for (const pidFile of fx.pidFiles) {
      try {
        const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
        if (Number.isFinite(pid) && pid > 0) process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Coord Test",
  GIT_AUTHOR_EMAIL: "coord@test.invalid",
  GIT_COMMITTER_NAME: "Coord Test",
  GIT_COMMITTER_EMAIL: "coord@test.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return (result.stdout ?? "").trim();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function writeExecutable(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  fs.chmodSync(file, 0o755);
}

function buildIdFile(appPath: string): string {
  return path.join(appPath, "Contents", "Resources", "standalone", ".next", "BUILD_ID");
}

async function makeFixture(): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pd-deploy-test-"));
  const origin = path.join(root, "origin.git");
  const checkout = path.join(root, "checkout");
  const coordDir = path.join(root, "coord");
  const chainDir = path.join(root, "chain");
  const markersDir = path.join(root, "markers");
  const wwwDir = path.join(root, "www");
  const builtApp = path.join(root, "built.app");
  const installedApp = path.join(root, "installed.app");
  const listenerPidFile = path.join(root, "listener.pid");
  const oldPidFile = path.join(root, "old-listener.pid");
  const quitScript = path.join(root, "quit.sh");

  for (const dir of [coordDir, chainDir, markersDir, wwwDir, checkout]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // --- git repo: origin + a clone whose LAST commit touches TODO.md only ---
  fs.mkdirSync(origin, { recursive: true });
  git(origin, ["init", "--bare", "--quiet"]);
  git(checkout, ["init", "--quiet"]);
  git(checkout, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  fs.writeFileSync(path.join(checkout, ".gitignore"), "node_modules/\n", "utf8");
  fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "src", "app.txt"), "source\n", "utf8");
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "--quiet", "-m", "base"]);

  // gitignored, so the tree stays clean
  writeExecutable(path.join(checkout, "node_modules", ".bin", "next"), "#!/bin/sh\nexit 0\n");

  // TODO.md is committed LAST so the reconciliation rule passes
  fs.mkdirSync(path.join(checkout, "docs", "plans"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "docs", "plans", "TODO.md"), "# TODO\n", "utf8");
  git(checkout, ["add", "docs/plans/TODO.md"]);
  git(checkout, ["commit", "--quiet", "-m", "todo"]);

  git(checkout, ["remote", "add", "origin", origin]);
  git(checkout, ["push", "--quiet", "-u", "origin", "main"]);

  // --- fake .app bundles ---
  fs.mkdirSync(path.dirname(buildIdFile(builtApp)), { recursive: true });
  fs.writeFileSync(buildIdFile(builtApp), "build-id-alpha", "utf8");
  fs.mkdirSync(path.dirname(buildIdFile(installedApp)), { recursive: true });
  fs.writeFileSync(buildIdFile(installedApp), "build-id-previous", "utf8");

  // --- health document served by the fake listener ---
  fs.writeFileSync(path.join(wwwDir, "login"), "<html>Portfolio Desk login</html>\n", "utf8");

  // --- fake chain ---
  writeExecutable(
    path.join(chainDir, "pack.sh"),
    `#!/bin/bash\nset -u\necho pack > "${markersDir}/pack"\necho "fake pack"\nexit 0\n`,
  );
  writeExecutable(
    path.join(chainDir, "gate.sh"),
    `#!/bin/bash\nset -u\necho gate > "${markersDir}/gate"\necho "fake bundle gate"\nexit 0\n`,
  );
  const port = await freePort();
  writeExecutable(
    path.join(chainDir, "install.sh"),
    [
      "#!/bin/bash",
      "set -u",
      `echo install > "${markersDir}/install"`,
      `mkdir -p "${path.dirname(buildIdFile(installedApp))}"`,
      `cat "${buildIdFile(builtApp)}" > "${buildIdFile(installedApp)}"`,
      `nohup python3 -m http.server ${port} --bind 127.0.0.1 --directory "${wwwDir}" > "${root}/listener.log" 2>&1 < /dev/null &`,
      `echo $! > "${listenerPidFile}"`,
      'echo "fake install"',
      "exit 0",
      "",
    ].join("\n"),
  );

  // --- quit command: kills whatever pid the listener pidfiles hold ---
  writeExecutable(
    path.join(root, "quit.sh"),
    [
      "#!/bin/bash",
      `for f in "${listenerPidFile}" "${oldPidFile}"; do`,
      '  if [ -f "$f" ]; then',
      '    p=$(cat "$f" 2>/dev/null)',
      '    if [ -n "$p" ]; then kill "$p" 2>/dev/null || true; fi',
      "  fi",
      "done",
      "exit 0",
      "",
    ].join("\n"),
  );

  const fixture: Fixture = {
    root,
    checkout,
    coordDir,
    chainDir,
    builtApp,
    installedApp,
    markersDir,
    pidFiles: [listenerPidFile, oldPidFile],
    port,
    env: {
      PD_DEPLOY_TEST_MODE: "1",
      PD_COORD_DIR: coordDir,
      PD_MAIN_CHECKOUT: checkout,
      PD_DEPLOY_CHAIN_DIR: chainDir,
      PD_BUILT_APP: builtApp,
      PD_INSTALLED_APP: installedApp,
      PD_DEPLOY_PORT: String(port),
      PD_DEPLOY_HEALTH_URL: `http://127.0.0.1:${port}/login`,
      PD_DEPLOY_HEALTH_MARKER: "Portfolio Desk",
      PD_DEPLOY_QUIT_CMD: `bash ${quitScript}`,
      PD_DEPLOY_EXPECT_CMD_SUBSTR: "http.server",
      PD_DEPLOY_SKIP_CODESIGN: "1",
      PD_SKIP_FETCH: "1",
      PD_DEPLOY_QUIT_WAIT_SECONDS: "3",
      PD_DEPLOY_LISTENER_WAIT_SECONDS: "20",
      PD_DEPLOY_HEALTH_WAIT_SECONDS: "20",
    },
  };
  fixtures.push(fixture);
  return fixture;
}

// ---------------------------------------------------------------------------
// Drivers + assertions
// ---------------------------------------------------------------------------

function runDeploy(fx: Fixture, args: string[] = [], extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync("bash", [DEPLOY_SH, ...args], {
    cwd: fx.checkout,
    env: { ...process.env, ...fx.env, ...extraEnv },
    encoding: "utf8",
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

function runCoord(fx: Fixture, args: string[]): RunResult {
  const result = spawnSync("bash", [COORD_SH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, PD_COORD_DIR: fx.coordDir },
    encoding: "utf8",
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

function marker(fx: Fixture, name: string): boolean {
  return fs.existsSync(path.join(fx.markersDir, name));
}

function heldLocks(fx: Fixture): string[] {
  const locksDir = path.join(fx.coordDir, "locks");
  if (!fs.existsSync(locksDir)) return [];
  return fs.readdirSync(locksDir).sort();
}

function deploysLog(fx: Fixture): string {
  const file = path.join(fx.coordDir, "deploys.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startOldListener(fx: Fixture): Promise<void> {
  const oldPidFile = path.join(fx.root, "old-listener.pid");
  spawnSync(
    "bash",
    [
      "-c",
      `nohup python3 -m http.server ${fx.port} --bind 127.0.0.1 --directory "${path.join(fx.root, "www")}" > "${fx.root}/old.log" 2>&1 < /dev/null & echo $! > "${oldPidFile}"`,
    ],
    { encoding: "utf8" },
  );
  for (let i = 0; i < 50; i++) {
    const probe = spawnSync("lsof", ["-nP", `-iTCP:${fx.port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    if ((probe.stdout ?? "").trim().length > 0) return;
    await sleep(100);
  }
  throw new Error(`old listener never bound port ${fx.port}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scripts/coord/deploy.sh", () => {
  it("refuses a dirty working tree (65) without running any chain step", async () => {
    const fx = await makeFixture();
    fs.writeFileSync(path.join(fx.checkout, "uncommitted.txt"), "dirty\n", "utf8");

    const result = runDeploy(fx);

    expect(result.status).toBe(65);
    expect(result.output).toMatch(/working tree is dirty/);
    expect(marker(fx, "pack")).toBe(false);
    expect(marker(fx, "gate")).toBe(false);
    expect(marker(fx, "install")).toBe(false);
    expect(heldLocks(fx)).toEqual([]);
  }, 30_000);

  it("refuses an unpushed HEAD (65), and warns instead with --allow-unpushed --dry-run", async () => {
    const fx = await makeFixture();
    fs.appendFileSync(path.join(fx.checkout, "docs", "plans", "TODO.md"), "- later\n", "utf8");
    git(fx.checkout, ["commit", "--quiet", "-am", "todo update"]);

    const refused = runDeploy(fx);
    expect(refused.status).toBe(65);
    expect(refused.output).toMatch(/HEAD not pushed/);
    expect(marker(fx, "pack")).toBe(false);
    expect(heldLocks(fx)).toEqual([]);

    const allowed = runDeploy(fx, ["--allow-unpushed", "--dry-run"]);
    expect(allowed.status).toBe(0);
    expect(allowed.output).toMatch(/WARN/);
    expect(allowed.output).toMatch(/HEAD not pushed/);
    expect(allowed.output).toMatch(/DRY-RUN complete/);
    expect(marker(fx, "pack")).toBe(false);
    expect(heldLocks(fx)).toEqual([]);
  }, 30_000);

  it("refuses when --commit does not equal HEAD (65)", async () => {
    const fx = await makeFixture();
    const parent = git(fx.checkout, ["rev-parse", "HEAD~1"]);

    const result = runDeploy(fx, ["--commit", parent]);

    expect(result.status).toBe(65);
    expect(result.output).toMatch(/--commit mismatch/);
    expect(marker(fx, "pack")).toBe(false);
    expect(heldLocks(fx)).toEqual([]);

    // short prefixes resolve, and a matching --commit passes the check
    const shortHead = git(fx.checkout, ["rev-parse", "--short", "HEAD"]);
    const accepted = runDeploy(fx, ["--commit", shortHead, "--dry-run"]);
    expect(accepted.status).toBe(0);
    expect(accepted.output).toMatch(/PRE-FLIGHT ok: --commit/);
  }, 30_000);

  it("propagates lock contention (75) when another task holds `integration`", async () => {
    const fx = await makeFixture();
    const held = runCoord(fx, [
      "lock",
      "acquire",
      "integration",
      "--task",
      "other",
      "--owner",
      "codex",
      "--ttl",
      "90m",
    ]);
    expect(held.status).toBe(0);

    const result = runDeploy(fx);

    expect(result.status).toBe(75);
    expect(result.stderr).toMatch(/task=other/);
    expect(marker(fx, "pack")).toBe(false);
    // the contended lock is still the other task's; nothing of ours is left
    expect(heldLocks(fx)).toEqual(["integration"]);
  }, 30_000);

  it("exits with the failing chain step's own code and records the failure", async () => {
    const fx = await makeFixture();
    writeExecutable(
      path.join(fx.chainDir, "pack.sh"),
      `#!/bin/bash\necho pack > "${fx.markersDir}/pack"\necho "pack blew up" >&2\nexit 7\n`,
    );

    const result = runDeploy(fx);

    expect(result.status).toBe(7);
    expect(result.output).toMatch(/FAILED step 1 \(exit 7\)/);
    expect(marker(fx, "pack")).toBe(true);
    expect(marker(fx, "gate")).toBe(false);
    expect(marker(fx, "install")).toBe(false);
    expect(deploysLog(fx)).toMatch(/result=failed step=1 exit=7/);
    expect(heldLocks(fx)).toEqual([]);
  }, 30_000);

  it("fails post-verify (70) when the installed BUILD_ID differs from the built one", async () => {
    const fx = await makeFixture();
    writeExecutable(
      path.join(fx.chainDir, "install.sh"),
      [
        "#!/bin/bash",
        "set -u",
        `echo install > "${fx.markersDir}/install"`,
        `mkdir -p "${path.dirname(buildIdFile(fx.installedApp))}"`,
        `printf '%s' "build-id-somethingelse" > "${buildIdFile(fx.installedApp)}"`,
        "exit 0",
        "",
      ].join("\n"),
    );

    const result = runDeploy(fx);

    expect(result.status).toBe(70);
    expect(result.output).toMatch(/BUILD_ID mismatch/);
    expect(marker(fx, "install")).toBe(true);
    expect(heldLocks(fx)).toEqual([]);
  }, 30_000);

  it("fails (70) before building when the old app is still listening after the quit", async () => {
    const fx = await makeFixture();
    await startOldListener(fx);

    const result = runDeploy(fx, [], { PD_DEPLOY_QUIT_CMD: "true" });

    expect(result.status).toBe(70);
    expect(result.output).toMatch(/still listening/);
    expect(marker(fx, "pack")).toBe(false);
    expect(marker(fx, "gate")).toBe(false);
    expect(marker(fx, "install")).toBe(false);
    expect(heldLocks(fx)).toEqual([]);
  }, 30_000);

  it("runs the whole chain, post-verifies, records the deploy and checkpoints the task", async () => {
    const fx = await makeFixture();
    const registered = runCoord(fx, [
      "task",
      "register",
      "--id",
      "t1",
      "--owner",
      "test",
      "--branch",
      "b",
      "--worktree",
      fx.checkout,
    ]);
    expect(registered.status).toBe(0);

    const result = runDeploy(fx, ["--task", "t1"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/DEPLOY ok/);
    expect(marker(fx, "pack")).toBe(true);
    expect(marker(fx, "gate")).toBe(true);
    expect(marker(fx, "install")).toBe(true);
    expect(deploysLog(fx)).toMatch(/result=ok/);
    expect(deploysLog(fx)).toMatch(/build=build-id-alpha/);
    expect(heldLocks(fx)).toEqual([]);

    const record = JSON.parse(fs.readFileSync(path.join(fx.coordDir, "tasks", "t1.json"), "utf8"));
    expect(record.last_checkpoint).not.toBeNull();
    expect(record.last_checkpoint.note).toMatch(/deployed/);
    // F12: deploy evidence is never test evidence
    expect(record.tested_commit).toBeNull();
  }, 30_000);

  it("--dry-run stops after preflight and runs no chain step", async () => {
    const fx = await makeFixture();

    const result = runDeploy(fx, ["--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/DRY-RUN complete/);
    expect(marker(fx, "pack")).toBe(false);
    expect(marker(fx, "gate")).toBe(false);
    expect(marker(fx, "install")).toBe(false);
    expect(heldLocks(fx)).toEqual([]);
  }, 30_000);
});
