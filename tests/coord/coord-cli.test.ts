import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Spawns the coord CLI (scripts/coord/coord.sh, a thin exec wrapper around
 * scripts/coord/coord.py) against a fresh, isolated PD_COORD_DIR per test.
 * Covers docs/superpowers/specs/2026-09-08-agent-coordination-design.md
 * sections 1-3 and the 2026-09-08 design-review addendum (lock tokens,
 * pid/pid_start liveness, incomplete-lock handling, --force-live,
 * SIGINT/SIGTERM forwarding in `lock run`, race-safe stale-lock breaking).
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const COORD_SH = path.join(REPO_ROOT, "scripts", "coord", "coord.sh");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

let coordDir: string;

beforeEach(() => {
  coordDir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-coord-test-"));
});

afterEach(() => {
  let leftover: string[] = [];
  try {
    leftover = findTmpFiles(coordDir);
  } finally {
    fs.rmSync(coordDir, { recursive: true, force: true });
  }
  expect(leftover).toEqual([]);
});

function run(args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync("bash", [COORD_SH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, PD_COORD_DIR: coordDir, ...extraEnv },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runBg(args: string[], extraEnv: Record<string, string> = {}): ChildProcess {
  return spawn("bash", [COORD_SH, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, PD_COORD_DIR: coordDir, ...extraEnv },
  });
}

function waitForClose(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
  });
}

function findTmpFiles(dir: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findTmpFiles(full));
    } else if (/\.tmp-\d+$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function taskFilePath(id: string): string {
  return path.join(coordDir, "tasks", `${id}.json`);
}

function historyLog(): string {
  const p = path.join(coordDir, "history.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── task register ──────────────────────────────────────────────

describe("task register lifecycle", () => {
  it("register then show --json round-trips all fields; list hides landed, --all shows it", () => {
    const reg = run([
      "task",
      "register",
      "--id",
      "t1",
      "--owner",
      "claude",
      "--branch",
      "feature/x",
      "--worktree",
      "/tmp/does-not-matter-t1",
      "--paths",
      "lib/a.ts,lib/b.ts",
      "--port",
      "3091",
      "--browser-session",
      "sess-1",
      "--handoff",
      "docs/handoff-t1.md",
      "--pid",
      String(process.pid),
      "--status",
      "active",
    ]);
    expect(reg.status).toBe(0);

    const show = run(["task", "show", "t1", "--json"]);
    expect(show.status).toBe(0);
    const record = JSON.parse(show.stdout);
    expect(record.id).toBe("t1");
    expect(record.owner).toBe("claude");
    expect(record.branch).toBe("feature/x");
    expect(record.worktree).toBe("/tmp/does-not-matter-t1");
    expect(record.owned_paths).toEqual(["lib/a.ts", "lib/b.ts"]);
    expect(record.port).toBe(3091);
    expect(record.browser_session).toBe("sess-1");
    expect(record.handoff).toBe("docs/handoff-t1.md");
    expect(record.pid).toBe(process.pid);
    expect(record.status).toBe("active");
    expect(record.last_checkpoint).toBeNull();
    expect(record.tested_commit).toBeNull();
    expect(record.evidence).toBeNull();
    expect(record.next_action).toBeNull();
    expect(record.created_at).toMatch(/Z$/);
    expect(record.updated_at).toMatch(/Z$/);
    expect(record.heartbeat_at).toMatch(/Z$/);

    const cp = run(["task", "checkpoint", "t1", "--note", "done", "--status", "landed"]);
    expect(cp.status).toBe(0);

    const listDefault = run(["task", "list", "--json"]);
    const defaultIds = JSON.parse(listDefault.stdout).map((r: { id: string }) => r.id);
    expect(defaultIds).not.toContain("t1");

    const listAll = run(["task", "list", "--all", "--json"]);
    const allIds = JSON.parse(listAll.stdout).map((r: { id: string }) => r.id);
    expect(allIds).toContain("t1");
  });

  it("duplicate register is refused; --update merges given fields only", () => {
    const first = run(["task", "register", "--id", "t2", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wt2"]);
    expect(first.status).toBe(0);

    const dup = run(["task", "register", "--id", "t2", "--owner", "codex", "--branch", "b2", "--worktree", "/tmp/wt2b"]);
    expect(dup.status).toBe(1);

    const upd = run(["task", "register", "--id", "t2", "--update", "--port", "3092"]);
    expect(upd.status).toBe(0);

    const show = JSON.parse(run(["task", "show", "t2", "--json"]).stdout);
    expect(show.owner).toBe("claude");
    expect(show.branch).toBe("b");
    expect(show.port).toBe(3092);
  });

  it("checkpoint sets last_checkpoint/tested_commit/evidence/next and bumps heartbeat_at", () => {
    run(["task", "register", "--id", "t3", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wt3"]);
    const before = JSON.parse(run(["task", "show", "t3", "--json"]).stdout);

    const cp = run([
      "task",
      "checkpoint",
      "t3",
      "--note",
      "checkpoint one",
      "--tested-commit",
      "abc1234",
      "--evidence",
      "/tmp/evidence.log",
      "--next",
      "do the next thing",
    ]);
    expect(cp.status).toBe(0);

    const after = JSON.parse(run(["task", "show", "t3", "--json"]).stdout);
    expect(after.last_checkpoint.note).toBe("checkpoint one");
    expect(typeof after.last_checkpoint.at).toBe("string");
    expect(after.tested_commit).toBe("abc1234");
    expect(after.evidence).toBe("/tmp/evidence.log");
    expect(after.next_action).toBe("do the next thing");
    expect(after.heartbeat_at >= before.heartbeat_at).toBe(true);
  });

  it("list flags OWNER-GONE, WORKTREE-MISSING, and (after backdating) STALE", () => {
    const missingWorktree = path.join(coordDir, "no-such-worktree");
    const reg = run([
      "task",
      "register",
      "--id",
      "t4",
      "--owner",
      "claude",
      "--branch",
      "b",
      "--worktree",
      missingWorktree,
      "--pid",
      "999999",
    ]);
    expect(reg.status).toBe(0);

    const list1 = run(["task", "list", "--json"]);
    const rec1 = JSON.parse(list1.stdout).find((r: { id: string }) => r.id === "t4");
    expect(rec1.flags).toContain("OWNER-GONE");
    expect(rec1.flags).toContain("WORKTREE-MISSING");

    // Backdate heartbeat_at directly in the task JSON file (simulating a
    // task that has not checked in recently).
    const record = JSON.parse(fs.readFileSync(taskFilePath("t4"), "utf8"));
    const old = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, ".000000Z");
    record.heartbeat_at = old;
    record.updated_at = old;
    fs.writeFileSync(taskFilePath("t4"), JSON.stringify(record, null, 2));

    const list2 = run(["task", "list", "--stale-after", "1s", "--json"]);
    const rec2 = JSON.parse(list2.stdout).find((r: { id: string }) => r.id === "t4");
    expect(rec2.flags).toContain("STALE");
  });

  it("release keeps the file and logs prior owner; archive refuses while active, succeeds after release", () => {
    run(["task", "register", "--id", "t5", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wt5"]);

    const archiveWhileActive = run(["task", "archive", "t5"]);
    expect(archiveWhileActive.status).toBe(1);

    const rel = run(["task", "release", "t5", "--by", "codex", "--reason", "stepping away"]);
    expect(rel.status).toBe(0);

    const shown = JSON.parse(run(["task", "show", "t5", "--json"]).stdout);
    expect(shown.status).toBe("abandoned");

    const history = historyLog();
    expect(history).toContain("claude");
    expect(history).toContain("t5");

    const archived = run(["task", "archive", "t5"]);
    expect(archived.status).toBe(0);
    expect(fs.existsSync(taskFilePath("t5"))).toBe(false);
    expect(fs.existsSync(path.join(coordDir, "tasks", "archive", "t5.json"))).toBe(true);
  });

  it("checkpoint/heartbeat on an archived task id refuses and never recreates it", () => {
    run(["task", "register", "--id", "t5b", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wt5b"]);
    run(["task", "release", "t5b", "--by", "claude", "--reason", "done"]);
    run(["task", "archive", "t5b"]);

    const cp = run(["task", "checkpoint", "t5b", "--note", "should not work"]);
    expect(cp.status).toBe(1);
    expect(cp.stderr.toLowerCase()).toContain("archived");

    const hb = run(["task", "heartbeat", "t5b"]);
    expect(hb.status).toBe(1);
    expect(hb.stderr.toLowerCase()).toContain("archived");

    expect(fs.existsSync(taskFilePath("t5b"))).toBe(false);
  });
});

// ─── locks: basic contention, release rules ─────────────────────

describe("locks: contention and release", () => {
  it("acquire contention, idempotent re-acquire, wrong-task release refused, --force releases and logs reason", () => {
    run(["task", "register", "--id", "ta", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wta"]);
    run(["task", "register", "--id", "tb", "--owner", "codex", "--branch", "b", "--worktree", "/tmp/wtb"]);

    const acq1 = run(["lock", "acquire", "integration", "--task", "ta"]);
    expect(acq1.status).toBe(0);
    expect(acq1.stdout).toContain("LOCK_TOKEN=");

    const acq2 = run(["lock", "acquire", "integration", "--task", "tb"]);
    expect(acq2.status).toBe(75);
    expect(acq2.stderr).toContain("task=ta");

    const reAcq = run(["lock", "acquire", "integration", "--task", "ta"]);
    expect(reAcq.status).toBe(0);

    const badRelease = run(["lock", "release", "integration", "--task", "tb"]);
    expect(badRelease.status).toBe(1);

    const forced = run(["lock", "release", "integration", "--task", "tb", "--force", "--reason", "taking over"]);
    // ta's own pid defaulted to the invoking shell (this test's own process,
    // still alive), so plain --force must be refused for "alive"...
    expect(forced.status).toBe(1);
    expect(forced.stderr.toLowerCase()).toContain("alive");

    const forcedLive = run(["lock", "release", "integration", "--task", "tb", "--force-live", "--reason", "taking over for real"]);
    expect(forcedLive.status).toBe(0);

    const history = historyLog();
    expect(history).toContain("taking over for real");
  });

  it("releasing a lock that isn't held exits 0 with a note", () => {
    run(["task", "register", "--id", "tnone", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wtnone"]);
    const rel = run(["lock", "release", "never-held", "--task", "tnone"]);
    expect(rel.status).toBe(0);
  });
});

// ─── locks: stale TTL break ──────────────────────────────────────

describe("locks: stale TTL break", () => {
  it("stale TTL lock (dead pid) requires --break-stale to acquire", () => {
    run(["task", "register", "--id", "tc", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wtc"]);
    run(["task", "register", "--id", "td", "--owner", "codex", "--branch", "b", "--worktree", "/tmp/wtd"]);

    const acq = run(["lock", "acquire", "flaky", "--task", "tc", "--pid", "999999", "--ttl", "1s"]);
    expect(acq.status).toBe(0);

    return sleep(1200).then(() => {
      const noBreak = run(["lock", "acquire", "flaky", "--task", "td"]);
      expect(noBreak.status).toBe(75);

      const withBreak = run(["lock", "acquire", "flaky", "--task", "td", "--break-stale"]);
      expect(withBreak.status).toBe(0);

      const history = historyLog();
      expect(history.toLowerCase()).toContain("broke stale lock");
    });
  });
});

// ─── locks: run (exit code propagation, contention, signals) ────

describe("locks: run", () => {
  it("propagates the child's exit code and releases the lock", () => {
    run(["task", "register", "--id", "te", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wte"]);

    const runOk = run(["lock", "run", "runner", "--task", "te", "--", "bash", "-c", "exit 7"]);
    expect(runOk.status).toBe(7);
    expect(fs.existsSync(path.join(coordDir, "locks", "runner"))).toBe(false);
  });

  it("refuses to run the command when the lock is held by another task (marker file never created)", () => {
    run(["task", "register", "--id", "te2", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wte2"]);
    run(["task", "register", "--id", "tf2", "--owner", "codex", "--branch", "b", "--worktree", "/tmp/wtf2"]);

    const acq = run(["lock", "acquire", "runner2", "--task", "te2"]);
    expect(acq.status).toBe(0);

    const marker = path.join(coordDir, "marker.txt");
    const blocked = run(["lock", "run", "runner2", "--task", "tf2", "--", "bash", "-c", `echo hi > ${marker}`]);
    expect(blocked.status).toBe(75);
    expect(fs.existsSync(marker)).toBe(false);

    const rel = run(["lock", "release", "runner2", "--task", "te2"]);
    expect(rel.status).toBe(0);
  });

  it("forwards SIGTERM to the child, exits 128+15, and releases the lock", async () => {
    run(["task", "register", "--id", "tg2", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wtg2"]);

    const child = runBg(["lock", "run", "sigrunner", "--task", "tg2", "--", "sleep", "30"]);
    await sleep(500);
    child.kill("SIGTERM");
    const code = await waitForClose(child);

    expect(code).toBe(143);
    expect(fs.existsSync(path.join(coordDir, "locks", "sigrunner"))).toBe(false);
  }, 10_000);
});

// ─── locks: --wait ────────────────────────────────────────────────

describe("locks: --wait", () => {
  it("a waiting acquire succeeds once the holder releases", async () => {
    run(["task", "register", "--id", "tg", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wtg"]);
    run(["task", "register", "--id", "th", "--owner", "codex", "--branch", "b", "--worktree", "/tmp/wth"]);

    const held = run(["lock", "acquire", "waitlock", "--task", "tg"]);
    expect(held.status).toBe(0);

    const waiter = runBg(["lock", "acquire", "waitlock", "--task", "th", "--wait", "5"]);
    const exitCodePromise = waitForClose(waiter);

    await sleep(300);
    const rel = run(["lock", "release", "waitlock", "--task", "tg"]);
    expect(rel.status).toBe(0);

    const code = await exitCodePromise;
    expect(code).toBe(0);
  }, 10_000);
});

// ─── inbox: who is waiting on whom ────────────────────────────────

describe("inbox", () => {
  function seed() {
    run(["task", "register", "--id", "ib-user", "--owner", "claude", "--branch", "b", "--worktree", "/tmp"]);
    run(["task", "checkpoint", "ib-user", "--note", "PR open", "--status", "review", "--next", "USER: land PR #76"]);
    run(["task", "register", "--id", "ib-codex", "--owner", "codex", "--branch", "b", "--worktree", "/tmp"]);
    run(["task", "checkpoint", "ib-codex", "--note", "runner", "--next", "codex: finish the runner tests"]);
    run(["task", "register", "--id", "ib-claude", "--owner", "claude", "--branch", "b", "--worktree", "/tmp"]);
    run(["task", "checkpoint", "ib-claude", "--note", "coding", "--next", "CLAUDE: write the tests"]);
    run(["task", "register", "--id", "ib-unlabeled", "--owner", "claude", "--branch", "b", "--worktree", "/tmp"]);
    run(["task", "checkpoint", "ib-unlabeled", "--note", "waiting", "--status", "blocked", "--next", "decide the port"]);
    run(["task", "register", "--id", "ib-landed", "--owner", "claude", "--branch", "b", "--worktree", "/tmp"]);
    run(["task", "checkpoint", "ib-landed", "--note", "done", "--status", "landed", "--next", "USER: nothing"]);
    run(["task", "register", "--id", "ib-dead", "--owner", "codex", "--branch", "b", "--worktree", "/nonexistent-ib", "--pid", "999999"]);
  }

  it("routes tasks by their USER:/CODEX:/CLAUDE: label, falls back to status, excludes landed tasks, flags stale ownership", () => {
    seed();
    const res = run(["inbox", "--no-prs", "--json"]);
    expect(res.status).toBe(0);
    const d = JSON.parse(res.stdout);
    const ids = (arr: Array<{ id: string }>) => arr.map((x) => x.id).sort();
    expect(ids(d.user)).toEqual(["ib-unlabeled", "ib-user"]);
    expect(ids(d.codex)).toEqual(["ib-codex", "ib-dead"]);
    expect(ids(d.claude)).toEqual(["ib-claude"]);
    expect(ids(d.attention)).toEqual(["ib-dead"]);
    expect(d.attention[0].flags).toEqual(expect.arrayContaining(["WORKTREE-MISSING", "OWNER-GONE"]));
    expect(d.user.find((x: { id: string }) => x.id === "ib-user").explicit).toBe(true);
    expect(d.user.find((x: { id: string }) => x.id === "ib-unlabeled").explicit).toBe(false);
    expect(d.unlabeled).toBe(2);
    expect(JSON.stringify(d)).not.toContain("ib-landed");
  });

  it("human output has the three sections in order, an attention line, and the labelling hint", () => {
    seed();
    const res = run(["inbox", "--no-prs"]);
    expect(res.status).toBe(0);
    const you = res.stdout.indexOf("WAITING ON YOU");
    const codex = res.stdout.indexOf("WAITING ON CODEX");
    const claude = res.stdout.indexOf("WAITING ON CLAUDE");
    expect(you).toBeGreaterThanOrEqual(0);
    expect(codex).toBeGreaterThan(you);
    expect(claude).toBeGreaterThan(codex);
    expect(res.stdout).toContain("USER: land PR #76");
    expect(res.stdout).toContain("attention: task ib-dead");
    expect(res.stdout).toContain("hint: 2 task(s)");
  });

  it("--for codex prints only that section", () => {
    seed();
    const res = run(["inbox", "--no-prs", "--for", "codex"]);
    expect(res.stdout).toContain("WAITING ON CODEX");
    expect(res.stdout).not.toContain("WAITING ON YOU");
    expect(res.stdout).not.toContain("WAITING ON CLAUDE");
  });

  it("open PRs come from the PR command seam and land under WAITING ON YOU; a failing command is reported, not fatal", () => {
    seed();
    const prJson = JSON.stringify([
      { number: 76, title: "QA auto-fixes 2026-09-11", headRefName: "qa-auto-fixes-2026-09-11", createdAt: "2026-09-11T14:50:17Z" },
    ]);
    const ok = run(["inbox", "--for", "user"], { PD_COORD_PR_CMD: `printf '%s' '${prJson}'` });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("PR #76 QA auto-fixes 2026-09-11 (qa-auto-fixes-2026-09-11, opened 2026-09-11)");
    const okJson = JSON.parse(run(["inbox", "--json"], { PD_COORD_PR_CMD: `printf '%s' '${prJson}'` }).stdout);
    expect(okJson.prs).toHaveLength(1);
    expect(okJson.pr_error).toBeNull();

    const bad = run(["inbox", "--for", "user"], { PD_COORD_PR_CMD: "echo boom >&2; exit 1" });
    expect(bad.status).toBe(0);
    expect(bad.stdout).toContain("PRs: unavailable (gh pr list failed: boom)");
  });

  it("checkpoint --next without a label prints a hint on stderr but still records it", () => {
    run(["task", "register", "--id", "ib-hint", "--owner", "claude", "--branch", "b", "--worktree", "/tmp"]);
    const res = run(["task", "checkpoint", "ib-hint", "--note", "n", "--next", "finish it"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("USER:, CODEX: or CLAUDE:");
    const labelled = run(["task", "checkpoint", "ib-hint", "--note", "n", "--next", "CLAUDE: finish it"]);
    expect(labelled.stderr).toBe("");
    const shown = JSON.parse(run(["task", "show", "ib-hint", "--json"]).stdout);
    expect(shown.next_action).toBe("CLAUDE: finish it");
  });
});

// ─── decision records: questions only the user can answer ─────────

describe("decision records", () => {
  it("a decision is registered with its question, tops the inbox for the user, refuses archive until decided, and closes with task decide", () => {
    const reg = run(["task", "register", "--id", "d-fx", "--owner", "user", "--status", "decision", "--next", "Fix or delete the placeholder FX row?"]);
    expect(reg.status).toBe(0);
    run(["task", "checkpoint", "d-fx", "--note", "Data Health flags a rate of exactly 1.0"]);
    run(["task", "register", "--id", "d-t1", "--owner", "claude", "--branch", "b", "--worktree", "/tmp"]);
    run(["task", "checkpoint", "d-t1", "--note", "n", "--next", "CLAUDE: keep coding"]);

    const json = JSON.parse(run(["inbox", "--no-prs", "--json"]).stdout);
    expect(json.decisions.map((d: { id: string }) => d.id)).toEqual(["d-fx"]);
    expect(json.decisions[0].question).toBe("Fix or delete the placeholder FX row?");
    expect(json.decisions[0].context).toBe("Data Health flags a rate of exactly 1.0");
    expect(typeof json.decisions[0].open_days).toBe("number");
    expect(json.user.map((d: { id: string }) => d.id)).not.toContain("d-fx"); // not double-listed
    expect(json.unlabeled).toBe(0); // a decision needs no USER: label

    const human = run(["inbox", "--no-prs", "--for", "user"]).stdout;
    expect(human).toContain("decision d-fx — Fix or delete the placeholder FX row?");
    expect(human).toContain("context: Data Health flags a rate of exactly 1.0");

    const listed = run(["task", "list", "--json"]).stdout;
    expect(listed).toContain("d-fx"); // decision is a live record, not hidden
    expect(JSON.parse(listed).find((r: { id: string }) => r.id === "d-fx").flags).toEqual([]); // never STALE

    const archive = run(["task", "archive", "d-fx"]);
    expect(archive.status).toBe(1);
    expect(archive.stderr).toContain("decide");

    const notDecision = run(["task", "decide", "d-t1", "--resolution", "x"]);
    expect(notDecision.status).toBe(1);

    const decided = run(["task", "decide", "d-fx", "--resolution", "delete the row", "--by", "user", "--json"]);
    expect(decided.status).toBe(0);
    const rec = JSON.parse(decided.stdout);
    expect(rec.status).toBe("landed");
    expect(rec.next_action).toBe("nobody");
    expect(rec.last_checkpoint.note).toBe("decided: delete the row");
    expect(historyLog()).toContain("task decide d-fx by=user resolution=delete the row");

    const after = JSON.parse(run(["inbox", "--no-prs", "--json"]).stdout);
    expect(after.decisions).toEqual([]);
    expect(run(["task", "archive", "d-fx"]).status).toBe(0);
  });
});

// ─── review fold: --exclusive disables same-task re-entrancy ─────

describe("locks: --exclusive", () => {
  it("a second acquire by the SAME task is idempotent by default but contends under --exclusive", () => {
    run(["task", "register", "--id", "tx1", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wtx1"]);
    const first = run(["lock", "acquire", "browser", "--task", "tx1", "--exclusive"]);
    expect(first.status).toBe(0);
    const firstToken = /LOCK_TOKEN=(\w+)/.exec(first.stdout)?.[1];
    expect(firstToken).toBeTruthy();

    const plain = run(["lock", "acquire", "browser", "--task", "tx1"]);
    expect(plain.status).toBe(0); // default: idempotent, returns the existing record

    const exclusive = run(["lock", "acquire", "browser", "--task", "tx1", "--exclusive"]);
    expect(exclusive.status).toBe(75);
    expect(exclusive.stderr).toContain("task=tx1");

    // lock run --exclusive must not run the command either
    const marker = path.join(coordDir, "exclusive-marker");
    const runExclusive = run(["lock", "run", "browser", "--task", "tx1", "--exclusive", "--", "bash", "-c", `touch ${marker}`]);
    expect(runExclusive.status).toBe(75);
    expect(fs.existsSync(marker)).toBe(false);

    expect(run(["lock", "release", "browser", "--task", "tx1", "--token", firstToken as string]).status).toBe(0);
  });
});

// ─── addendum: incomplete ("initializing") locks ─────────────────

describe("locks: incomplete owner.json (initializing)", () => {
  it("a young lock dir with no owner.json blocks contention; old enough it is stale-eligible only with --break-stale", () => {
    run(["task", "register", "--id", "ti1", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wti1"]);
    run(["task", "register", "--id", "ti2", "--owner", "codex", "--branch", "b", "--worktree", "/tmp/wti2"]);

    const ldir = path.join(coordDir, "locks", "incomplete1");
    fs.mkdirSync(ldir, { recursive: true });

    const youngAcquire = run(["lock", "acquire", "incomplete1", "--task", "ti2"]);
    expect(youngAcquire.status).toBe(75);

    // Backdate the lock dir's mtime past the 60s "initializing" grace period.
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(ldir, old, old);

    const noBreak = run(["lock", "acquire", "incomplete1", "--task", "ti2"]);
    expect(noBreak.status).toBe(75);

    const withBreak = run(["lock", "acquire", "incomplete1", "--task", "ti2", "--break-stale"]);
    expect(withBreak.status).toBe(0);

    const history = historyLog();
    expect(history.toLowerCase()).toContain("missing/malformed owner.json");
  });

  it("an initializing lock (no owner.json) cannot be released by an ordinary release; --force --reason breaks it", () => {
    run(["task", "register", "--id", "ti4", "--owner", "codex", "--branch", "b", "--worktree", "/tmp/wti4"]);
    const ldir = path.join(coordDir, "locks", "incomplete3");
    fs.mkdirSync(ldir, { recursive: true });

    const plain = run(["lock", "release", "incomplete3", "--task", "ti4"]);
    expect(plain.status).toBe(1);
    expect(plain.stderr).toContain("missing/malformed");
    expect(fs.existsSync(ldir)).toBe(true);

    const forcedNoReason = run(["lock", "release", "incomplete3", "--task", "ti4", "--force"]);
    expect(forcedNoReason.status).toBe(1);
    expect(fs.existsSync(ldir)).toBe(true);

    const forced = run(["lock", "release", "incomplete3", "--task", "ti4", "--force", "--reason", "operator break"]);
    expect(forced.status).toBe(0);
    expect(fs.existsSync(ldir)).toBe(false);
  });

  it("lock status shows an incomplete lock with TASK=?", () => {
    run(["task", "register", "--id", "ti3", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wti3"]);
    const ldir = path.join(coordDir, "locks", "incomplete2");
    fs.mkdirSync(ldir, { recursive: true });

    const status = run(["lock", "status", "--json"]);
    const rows = JSON.parse(status.stdout);
    const row = rows.find((r: { name: string }) => r.name === "incomplete2");
    expect(row).toBeTruthy();
    expect(row.task).toBeNull();
  });
});

// ─── addendum: concurrent stale-breakers ─────────────────────────

describe("locks: concurrent stale-break race", () => {
  it("exactly one of two concurrent --break-stale acquirers wins; lock dir ends with exactly one valid owner.json", async () => {
    run(["task", "register", "--id", "tr1", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wtr1"]);
    run(["task", "register", "--id", "tr2", "--owner", "codex", "--branch", "b", "--worktree", "/tmp/wtr2"]);
    run(["task", "register", "--id", "tr3", "--owner", "user", "--branch", "b", "--worktree", "/tmp/wtr3"]);

    const acq = run(["lock", "acquire", "racy", "--task", "tr1", "--pid", "999999", "--ttl", "1s"]);
    expect(acq.status).toBe(0);

    await sleep(1200);

    const p1 = runBg(["lock", "acquire", "racy", "--task", "tr2", "--break-stale"]);
    const p2 = runBg(["lock", "acquire", "racy", "--task", "tr3", "--break-stale"]);

    const [code1, code2] = await Promise.all([waitForClose(p1), waitForClose(p2)]);
    const codes = [code1, code2].sort();
    expect(codes).toEqual([0, 75]);

    const owner = JSON.parse(fs.readFileSync(path.join(coordDir, "locks", "racy", "owner.json"), "utf8"));
    expect(["tr2", "tr3"]).toContain(owner.task);
  }, 10_000);
});

// ─── addendum: --force / --force-live pid-alive gate ─────────────

describe("locks: --force / --force-live pid-alive gate", () => {
  it("--force refuses while the recorded holder pid is alive; --force-live overrides", () => {
    run(["task", "register", "--id", "td1", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wtd1"]);
    run(["task", "register", "--id", "td2", "--owner", "codex", "--branch", "b", "--worktree", "/tmp/wtd2"]);

    const acq = run(["lock", "acquire", "forcelock", "--task", "td1", "--pid", String(process.pid)]);
    expect(acq.status).toBe(0);

    const forceRefused = run(["lock", "release", "forcelock", "--task", "td2", "--force", "--reason", "x"]);
    expect(forceRefused.status).toBe(1);
    expect(forceRefused.stderr.toLowerCase()).toContain("alive");

    const forceLiveOk = run(["lock", "release", "forcelock", "--task", "td2", "--force-live", "--reason", "y"]);
    expect(forceLiveOk.status).toBe(0);
  });
});

// ─── addendum: lock token ─────────────────────────────────────────

describe("locks: acquisition token", () => {
  it("LOCK_TOKEN is printed and included in --json; release --token enforces it", () => {
    run(["task", "register", "--id", "te1", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wte1"]);

    const acqJson = run(["lock", "acquire", "tokenlock", "--task", "te1", "--json"]);
    expect(acqJson.status).toBe(0);
    const record = JSON.parse(acqJson.stdout);
    expect(typeof record.token).toBe("string");
    expect(record.token.length).toBeGreaterThan(0);

    const wrongToken = run(["lock", "release", "tokenlock", "--task", "te1", "--token", "not-the-real-token"]);
    expect(wrongToken.status).toBe(1);
    expect(wrongToken.stderr.toLowerCase()).toContain("token");

    const rightToken = run(["lock", "release", "tokenlock", "--task", "te1", "--token", record.token]);
    expect(rightToken.status).toBe(0);
  });

  it("human-mode acquire prints a LOCK_TOKEN= line", () => {
    run(["task", "register", "--id", "te1b", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wte1b"]);
    const acq = run(["lock", "acquire", "tokenlock2", "--task", "te1b"]);
    expect(acq.status).toBe(0);
    expect(acq.stdout).toMatch(/LOCK_TOKEN=[0-9a-f]+/);
  });
});

// ─── addendum: coord dir permissions ──────────────────────────────

describe("coord dir permissions", () => {
  it("creates the coord dir with mode 0700", () => {
    run(["task", "register", "--id", "tperm", "--owner", "claude", "--branch", "b", "--worktree", "/tmp/wtperm"]);
    const mode = fs.statSync(coordDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

// ─── no leftover temp files across a full mixed sequence ─────────

describe("atomic writes", () => {
  it("leaves no .tmp-* files after a full mixed sequence of operations", () => {
    run([
      "task",
      "register",
      "--id",
      "tz",
      "--owner",
      "claude",
      "--branch",
      "b",
      "--worktree",
      "/tmp/wtz",
      "--paths",
      "a,b",
      "--port",
      "3095",
    ]);
    run(["task", "checkpoint", "tz", "--note", "n1", "--tested-commit", "deadbeef"]);
    run(["task", "heartbeat", "tz"]);
    run(["task", "list", "--all", "--json"]);
    run(["lock", "acquire", "seqlock", "--task", "tz"]);
    run(["lock", "status", "--json"]);
    run(["lock", "release", "seqlock", "--task", "tz"]);
    run(["lock", "run", "seqlock2", "--task", "tz", "--", "bash", "-c", "exit 0"]);
    run(["task", "release", "tz", "--by", "claude", "--reason", "done for now"]);
    run(["task", "archive", "tz"]);

    const leftover = findTmpFiles(coordDir);
    expect(leftover).toEqual([]);
  });
});
