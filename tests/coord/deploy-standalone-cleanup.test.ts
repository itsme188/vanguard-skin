import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Exercises cleanup_standalone_copies() in scripts/coord/deploy.sh.
 *
 * `next build` copies the project root (including data/ and qa/) into
 * .next/standalone. After a fully successful deploy the wrapper deletes
 * those two copies; a failed deploy leaves .next/standalone whole.
 *
 * Same harness as deploy-wrapper.test.ts: a throwaway git repo, fake .app
 * bundles and a fake three-step chain in a mkdtemp dir, driven entirely
 * through the PD_DEPLOY_TEST_MODE=1 seams. The fake pack.sh plays the part
 * of `next build` by creating .next/standalone/{data,qa} in the temp
 * checkout. The real .next/, the real chain and /Applications are never
 * touched.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEPLOY_SH = path.join(REPO_ROOT, "scripts", "coord", "deploy.sh");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

interface Fixture {
  root: string;
  checkout: string;
  chainDir: string;
  builtApp: string;
  installedApp: string;
  markersDir: string;
  pidFiles: string[];
  lockedDirs: string[];
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
    for (const dir of fx.lockedDirs) {
      try {
        fs.chmodSync(dir, 0o755);
      } catch {
        /* already removed */
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

function standalone(fx: Fixture, ...parts: string[]): string {
  return path.join(fx.checkout, ".next", "standalone", ...parts);
}

/**
 * The fake pack step stands in for `next build`: it writes a standalone tree
 * with copies of data/ and qa/ plus a server.js that must survive cleanup.
 * `extra` lines run after that, so a test can reshape the tree.
 */
function packScript(fx: Fixture, extra: string[] = []): string {
  const sa = standalone(fx);
  return [
    "#!/bin/bash",
    "set -u",
    `echo pack > "${fx.markersDir}/pack"`,
    `mkdir -p "${sa}/data/backups" "${sa}/qa/runs"`,
    `echo synthetic > "${sa}/data/backups/copy.txt"`,
    `echo synthetic > "${sa}/qa/runs/copy.txt"`,
    `echo server > "${sa}/server.js"`,
    ...extra,
    'echo "fake pack"',
    "exit 0",
    "",
  ].join("\n");
}

async function makeFixture(): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pd-deploy-cleanup-test-"));
  const origin = path.join(root, "origin.git");
  const checkout = path.join(root, "checkout");
  const coordDir = path.join(root, "coord");
  const chainDir = path.join(root, "chain");
  const markersDir = path.join(root, "markers");
  const wwwDir = path.join(root, "www");
  const builtApp = path.join(root, "built.app");
  const installedApp = path.join(root, "installed.app");
  const listenerPidFile = path.join(root, "listener.pid");
  const quitScript = path.join(root, "quit.sh");

  for (const dir of [coordDir, chainDir, markersDir, wwwDir, checkout]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // --- git repo whose LAST commit touches TODO.md only ---
  fs.mkdirSync(origin, { recursive: true });
  git(origin, ["init", "--bare", "--quiet"]);
  git(checkout, ["init", "--quiet"]);
  git(checkout, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  fs.writeFileSync(path.join(checkout, ".gitignore"), "node_modules/\n.next/\ndata/\nqa/\n", "utf8");
  fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "src", "app.txt"), "source\n", "utf8");
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "--quiet", "-m", "base"]);

  writeExecutable(path.join(checkout, "node_modules", ".bin", "next"), "#!/bin/sh\nexit 0\n");

  // the project's own data/ and qa/ (gitignored, like the real repo)
  fs.mkdirSync(path.join(checkout, "data"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "data", "own.txt"), "synthetic\n", "utf8");
  fs.mkdirSync(path.join(checkout, "qa"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "qa", "own.txt"), "synthetic\n", "utf8");

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

  fs.writeFileSync(path.join(wwwDir, "login"), "<html>Portfolio Desk login</html>\n", "utf8");

  const port = await freePort();

  const fixture: Fixture = {
    root,
    checkout,
    chainDir,
    builtApp,
    installedApp,
    markersDir,
    pidFiles: [listenerPidFile],
    lockedDirs: [],
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
      PD_DEPLOY_OPEN_CMD: `echo open >> "${root}/order.log"`,
      PD_DEPLOY_EXPECT_CMD_SUBSTR: "http.server",
      PD_DEPLOY_SKIP_CODESIGN: "1",
      PD_SKIP_FETCH: "1",
      PD_DEPLOY_QUIT_WAIT_SECONDS: "3",
      PD_DEPLOY_LISTENER_WAIT_SECONDS: "20",
      PD_DEPLOY_HEALTH_WAIT_SECONDS: "20",
    },
  };

  // --- fake chain ---
  writeExecutable(path.join(chainDir, "pack.sh"), packScript(fixture));
  writeExecutable(
    path.join(chainDir, "gate.sh"),
    `#!/bin/bash\nset -u\necho gate > "${markersDir}/gate"\necho "fake bundle gate"\nexit 0\n`,
  );
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
  writeExecutable(
    quitScript,
    [
      "#!/bin/bash",
      `f="${listenerPidFile}"`,
      'if [ -f "$f" ]; then',
      '  p=$(cat "$f" 2>/dev/null)',
      '  if [ -n "$p" ]; then kill "$p" 2>/dev/null || true; fi',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );

  fixtures.push(fixture);
  return fixture;
}

function runDeploy(fx: Fixture): RunResult {
  const result = spawnSync("bash", [DEPLOY_SH], {
    cwd: fx.checkout,
    env: { ...process.env, ...fx.env },
    encoding: "utf8",
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scripts/coord/deploy.sh cleanup_standalone_copies", () => {
  it("removes .next/standalone/data and qa after a successful deploy", async () => {
    const fx = await makeFixture();

    const result = runDeploy(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/DEPLOY ok/);
    expect(fs.existsSync(standalone(fx, "data"))).toBe(false);
    expect(fs.existsSync(standalone(fx, "qa"))).toBe(false);
    // the rest of the standalone tree is left alone
    expect(fs.existsSync(standalone(fx, "server.js"))).toBe(true);
    expect(result.output).toMatch(/CLEANUP removed .*\.next\/standalone\/data/);
    expect(result.output).toMatch(/CLEANUP removed .*\.next\/standalone\/qa/);
  }, 30_000);

  it("leaves both folders when the gate fails", async () => {
    const fx = await makeFixture();
    writeExecutable(path.join(fx.chainDir, "gate.sh"), "#!/bin/bash\nexit 8\n");

    const result = runDeploy(fx);

    expect(result.status).toBe(8);
    expect(fs.existsSync(standalone(fx, "data", "backups", "copy.txt"))).toBe(true);
    expect(fs.existsSync(standalone(fx, "qa", "runs", "copy.txt"))).toBe(true);
    expect(result.output).not.toMatch(/CLEANUP/);
  }, 30_000);

  it("leaves both folders when install fails", async () => {
    const fx = await makeFixture();
    writeExecutable(path.join(fx.chainDir, "install.sh"), "#!/bin/bash\nexit 6\n");

    const result = runDeploy(fx);

    expect(result.status).toBe(6);
    expect(fs.existsSync(standalone(fx, "data", "backups", "copy.txt"))).toBe(true);
    expect(fs.existsSync(standalone(fx, "qa", "runs", "copy.txt"))).toBe(true);
    expect(result.output).not.toMatch(/CLEANUP/);
  }, 30_000);

  it("refuses a data folder that is a symlink to somewhere outside standalone", async () => {
    const fx = await makeFixture();
    const outside = path.join(fx.root, "outside");
    writeExecutable(
      path.join(fx.chainDir, "pack.sh"),
      packScript(fx, [
        `mkdir -p "${outside}"`,
        `echo keep > "${outside}/keep.txt"`,
        `rm -r "${standalone(fx, "data")}"`,
        `ln -s "${outside}" "${standalone(fx, "data")}"`,
      ]),
    );

    const result = runDeploy(fx);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
    expect(fs.lstatSync(standalone(fx, "data")).isSymbolicLink()).toBe(true);
    expect(result.output).toMatch(/CLEANUP WARN: refusing .*\.next\/standalone\/data/);
    // the other folder is still cleaned
    expect(fs.existsSync(standalone(fx, "qa"))).toBe(false);
  }, 30_000);

  it("a removal error is a warning and the deploy still exits 0", async () => {
    const fx = await makeFixture();
    const locked = standalone(fx, "qa", "locked");
    fx.lockedDirs.push(locked);
    writeExecutable(
      path.join(fx.chainDir, "pack.sh"),
      packScript(fx, [`mkdir -p "${locked}"`, `echo stuck > "${locked}/stuck.txt"`, `chmod 555 "${locked}"`]),
    );

    const result = runDeploy(fx);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/DEPLOY ok/);
    expect(result.output).toMatch(/CLEANUP WARN: could not fully remove .*\.next\/standalone\/qa/);
    expect(fs.existsSync(path.join(locked, "stuck.txt"))).toBe(true);
    // data is still removed
    expect(fs.existsSync(standalone(fx, "data"))).toBe(false);
  }, 30_000);

  it("never touches the project's own data folder", async () => {
    const fx = await makeFixture();

    const result = runDeploy(fx);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(fx.checkout, "data", "own.txt"), "utf8")).toBe("synthetic\n");
    expect(fs.readFileSync(path.join(fx.checkout, "qa", "own.txt"), "utf8")).toBe("synthetic\n");
    expect(fs.existsSync(standalone(fx, "data"))).toBe(false);
  }, 30_000);

  it("logs and skips a missing folder", async () => {
    const fx = await makeFixture();
    writeExecutable(
      path.join(fx.chainDir, "pack.sh"),
      packScript(fx, [`rm -r "${standalone(fx, "qa")}"`]),
    );

    const result = runDeploy(fx);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/CLEANUP skip: .*\.next\/standalone\/qa (is )?missing/);
    expect(fs.existsSync(standalone(fx, "data"))).toBe(false);
  }, 30_000);
});
