import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "..", "scripts", "qa", "reconcile-ledger-fix-status.py");

let dir: string;
let ledger: string;
let c1 = "";
let c2 = "";
let unreachable = "";

function git(...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function reconcile(...extra: string[]) {
  return spawnSync("python3", [SCRIPT, "--ledger", ledger, "--repo", dir, "--ref", "main", ...extra], { encoding: "utf8" });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-reconcile-test-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  c1 = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  git("add", "b.txt");
  git("commit", "-q", "-m", "fix thing [qa:cherry-id]");
  c2 = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "side");
  fs.writeFileSync(path.join(dir, "c.txt"), "c\n");
  git("add", "c.txt");
  git("commit", "-q", "-m", "side work");
  unreachable = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  ledger = path.join(dir, "ledger.json");
  const rows = [
    { id: "direct-id", title: "Café — direct", status: "fixed", fix_status: "pr-open", fix_commit: c1 },
    { id: "cherry-id", title: "cherry picked", status: "fixed", fix_status: "branch-unpushed", fix_commit: "0".repeat(40) },
    { id: "side-id", title: "not landed", status: "fixed", fix_status: "pr-open", fix_commit: unreachable },
    { id: "no-commit", title: "no evidence", status: "known", fix_status: "pr-open" },
    { id: "suspect-id", title: "suspect", status: "fixed", fix_status: "fixed" },
  ];
  fs.writeFileSync(ledger, JSON.stringify({ findings: rows }, null, 2) + "\n");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("reconcile-ledger-fix-status", () => {
  it("dry run reports changes and writes nothing", () => {
    const before = fs.readFileSync(ledger, "utf8");
    const res = reconcile();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("direct-id: pr-open -> merged");
    expect(res.stdout).toContain("cherry-id: branch-unpushed -> merged");
    expect(res.stdout).toContain("suspect: no commit: suspect-id");
    expect(fs.readFileSync(ledger, "utf8")).toBe(before);
    expect(fs.readdirSync(dir).filter((f) => f.includes("bak"))).toEqual([]);
  });

  it("--apply flips reachable and tag-matched rows, backs up, leaves the rest alone", () => {
    const before = fs.readFileSync(ledger, "utf8");
    const res = reconcile("--apply");
    expect(res.status).toBe(0);
    const backups = fs.readdirSync(dir).filter((f) => /^ledger\.json\.bak-\d{4}-\d{2}-\d{2}-reconcile$/.test(f));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backups[0]), "utf8")).toBe(before);

    const rows = JSON.parse(fs.readFileSync(ledger, "utf8")).findings;
    const byId = Object.fromEntries(rows.map((r: { id: string }) => [r.id, r]));
    expect(byId["direct-id"].fix_status).toBe("merged");
    expect(byId["direct-id"].landed_commit).toBe(c1.slice(0, 7));
    expect(byId["direct-id"].merged_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // cherry-pick: the recorded SHA does not exist on main, the [qa:] tag does
    expect(byId["cherry-id"].fix_status).toBe("merged");
    expect(byId["cherry-id"].landed_commit).toBe(c2.slice(0, 7));
    expect(byId["side-id"].fix_status).toBe("pr-open");
    expect(byId["side-id"].landed_commit).toBeUndefined();
    expect(byId["no-commit"].fix_status).toBe("pr-open");
    expect(byId["suspect-id"].fix_status).toBe("fixed");
    expect(byId["direct-id"].status).toBe("fixed");
  });

  it("preserves indentation, trailing newline and non-ASCII characters", () => {
    reconcile("--apply");
    const after = fs.readFileSync(ledger, "utf8");
    expect(after.endsWith("\n")).toBe(true);
    expect(after).toContain("Café — direct");
    expect(after).not.toContain("\\u");
    expect(after.split("\n")[1]).toBe('  "findings": [');
    // only the three owned fields changed for the flipped rows
    const changedLines = after.split("\n").length - fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.includes("bak"))!), "utf8").split("\n").length;
    expect(changedLines).toBe(2 * 2); // merged_date + landed_commit for two rows
  });

  it("a Revert commit carrying the tag does not count as landing it", () => {
    fs.writeFileSync(path.join(dir, "d.txt"), "d\n");
    git("add", "d.txt");
    git("commit", "-q", "-m", 'Revert "fix other [qa:reverted-id]"');
    const rows = JSON.parse(fs.readFileSync(ledger, "utf8"));
    rows.findings.push({ id: "reverted-id", title: "r", status: "fixed", fix_status: "pr-open", fix_commit: "0".repeat(40) });
    fs.writeFileSync(ledger, JSON.stringify(rows, null, 2) + "\n");
    const res = reconcile("--apply");
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("reverted-id");
    const out = JSON.parse(fs.readFileSync(ledger, "utf8")).findings;
    expect(out.find((r: { id: string }) => r.id === "reverted-id").fix_status).toBe("pr-open");
  });

  it("a partial-only row that landed is reported as partial and not flipped", () => {
    const rows = JSON.parse(fs.readFileSync(ledger, "utf8"));
    rows.findings.push({ id: "partial-id", title: "p", status: "fixed", fix_status: "pr-open", fix_commit_partial: c1 });
    fs.writeFileSync(ledger, JSON.stringify(rows, null, 2) + "\n");
    const res = reconcile("--apply");
    expect(res.stdout).toContain("partial-id: partial fix landed");
    expect(res.stdout).not.toContain("partial-id: pr-open -> merged");
    const out = JSON.parse(fs.readFileSync(ledger, "utf8")).findings;
    const row = out.find((r: { id: string }) => r.id === "partial-id");
    expect(row.fix_status).toBe("pr-open");
    expect(row.landed_commit).toBeUndefined();
  });

  it("a second --apply the same day keeps the first backup (numeric suffix)", () => {
    const original = fs.readFileSync(ledger, "utf8");
    reconcile("--apply");
    // re-open one row so the second run has something to change
    const rows = JSON.parse(fs.readFileSync(ledger, "utf8"));
    rows.findings.find((r: { id: string }) => r.id === "direct-id").fix_status = "pr-open";
    fs.writeFileSync(ledger, JSON.stringify(rows, null, 2) + "\n");
    const second = reconcile("--apply");
    expect(second.status).toBe(0);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith("ledger.json.bak-")).sort();
    expect(backups).toHaveLength(2);
    expect(backups.some((f) => /-reconcile-2$/.test(f))).toBe(true);
    const first = backups.find((f) => /-reconcile$/.test(f))!;
    expect(fs.readFileSync(path.join(dir, first), "utf8")).toBe(original);
  });

  it("exits non-zero on a missing ledger", () => {
    fs.rmSync(ledger);
    expect(reconcile().status).not.toBe(0);
  });
});
