import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOW_FREE_SPACE_BYTES,
  SCRATCH_MAX_AGE_DAYS,
  USB_STALE_DAYS,
  buildStorageReport,
  trimScratch,
} from "@/lib/backup/storage-report";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-11-16T12:00:00Z");

let tmp: string;
let repo: string;
let home: string;

function put(file: string, bytes: number, ageDays = 0): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  const t = new Date(NOW.getTime() - ageDays * DAY_MS);
  fs.utimesSync(file, t, t);
  return file;
}

function report(freeBytes = LOW_FREE_SPACE_BYTES, worktrees?: string[]) {
  return buildStorageReport({ repoRoot: repo, backupHome: home, freeBytes, now: NOW, worktrees });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "storage-report-"));
  repo = path.join(tmp, "repo");
  home = path.join(tmp, "backups");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("storage report", () => {
  it("exposes the constants", () => {
    expect(LOW_FREE_SPACE_BYTES).toBe(25 * 1024 ** 3);
    expect(SCRATCH_MAX_AGE_DAYS).toBe(7);
    expect(USB_STALE_DAYS).toBe(35);
  });

  it("flags low free space under 25 GiB and not at 25 GiB", () => {
    expect(report(LOW_FREE_SPACE_BYTES - 1).lowFreeSpace).toBe(true);
    expect(report(LOW_FREE_SPACE_BYTES).lowFreeSpace).toBe(false);
  });

  it("lists only files older than 7 days as trim candidates, and only in the two scratch folders", () => {
    const oldTmp = put(path.join(repo, "qa/tmp/old.png"), 10, 8);
    const oldPw = put(path.join(repo, ".playwright-mcp/sub/old.yml"), 20, 30);
    put(path.join(repo, "qa/tmp/new.png"), 10, 2);
    put(path.join(repo, "qa/tmp/edge.png"), 10, 7);
    put(path.join(repo, "qa/findings/old.json"), 10, 90);
    put(path.join(repo, "data/old.db"), 10, 90);
    const r = report();
    expect(r.trimCandidates.map((c) => c.path).sort()).toEqual([oldTmp, oldPw].sort());
    const c = r.trimCandidates.find((x) => x.path === oldPw);
    expect(c).toMatchObject({ bytes: 20, ageDays: 30 });
  });

  it("trimScratch removes candidates inside the scratch folders", () => {
    const f = put(path.join(repo, "qa/tmp/old.png"), 10, 8);
    const r = report();
    expect(trimScratch(r.trimCandidates, repo)).toEqual({ removed: 1, bytes: 10 });
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(path.join(repo, "qa/tmp"))).toBe(true);
  });

  it("trimScratch refuses a path outside the two scratch folders", () => {
    const outside = put(path.join(repo, "data/keep.db"), 10, 90);
    const findings = put(path.join(repo, "qa/findings/keep.json"), 10, 90);
    const res = trimScratch(
      [
        { path: outside, bytes: 10, ageDays: 90 },
        { path: findings, bytes: 10, ageDays: 90 },
      ],
      repo,
    );
    expect(res).toEqual({ removed: 0, bytes: 0 });
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(findings)).toBe(true);
  });

  it("trimScratch refuses a symlink inside a scratch folder that points outside", () => {
    const target = put(path.join(tmp, "elsewhere/precious.txt"), 10, 90);
    fs.mkdirSync(path.join(repo, "qa/tmp"), { recursive: true });
    const link = path.join(repo, "qa/tmp/link.txt");
    fs.symlinkSync(target, link);
    const res = trimScratch([{ path: link, bytes: 10, ageDays: 90 }], repo);
    expect(res).toEqual({ removed: 0, bytes: 0 });
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("a symlinked scratch root yields no candidates and trimScratch refuses files behind it", () => {
    const outside = put(path.join(tmp, "outside-dir/old.txt"), 10, 90);
    fs.mkdirSync(path.join(repo, "qa"), { recursive: true });
    fs.symlinkSync(path.join(tmp, "outside-dir"), path.join(repo, "qa/tmp"));
    expect(report().trimCandidates).toEqual([]);
    const viaLink = path.join(repo, "qa/tmp/old.txt");
    expect(trimScratch([{ path: viaLink, bytes: 10, ageDays: 90 }], repo)).toEqual({ removed: 0, bytes: 0 });
    expect(trimScratch([{ path: outside, bytes: 10, ageDays: 90 }], repo)).toEqual({ removed: 0, bytes: 0 });
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("trimScratch refuses a tampered path containing .. and a relative path", () => {
    put(path.join(repo, "qa/tmp/ok.txt"), 1, 90);
    const victim = put(path.join(repo, "outside/x"), 10, 90);
    const tampered = `${repo}/qa/tmp/../../repo/outside/x`;
    expect(trimScratch([{ path: tampered, bytes: 10, ageDays: 90 }], repo)).toEqual({ removed: 0, bytes: 0 });
    expect(fs.existsSync(victim)).toBe(true);
    const rel = path.relative(process.cwd(), path.join(repo, "qa/tmp/ok.txt"));
    expect(trimScratch([{ path: rel, bytes: 1, ageDays: 90 }], repo)).toEqual({ removed: 0, bytes: 0 });
    expect(fs.existsSync(path.join(repo, "qa/tmp/ok.txt"))).toBe(true);
  });

  it("trimScratch refuses a file whose parent folder inside scratch is a symlink", () => {
    const target = put(path.join(tmp, "elsewhere2/old.txt"), 10, 90);
    fs.mkdirSync(path.join(repo, "qa/tmp"), { recursive: true });
    fs.symlinkSync(path.join(tmp, "elsewhere2"), path.join(repo, "qa/tmp/sub"));
    const res = trimScratch([{ path: path.join(repo, "qa/tmp/sub/old.txt"), bytes: 10, ageDays: 90 }], repo);
    expect(res).toEqual({ removed: 0, bytes: 0 });
    expect(fs.existsSync(target)).toBe(true);
  });

  it("trimScratch never removes a directory", () => {
    const dir = path.join(repo, "qa/tmp/subdir");
    fs.mkdirSync(dir, { recursive: true });
    const res = trimScratch([{ path: dir, bytes: 0, ageDays: 90 }], repo);
    expect(res).toEqual({ removed: 0, bytes: 0 });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("reports the usb copy as stale when the marker is missing or older than 35 days", () => {
    const missing = report();
    expect(missing.usbLastSync).toBeNull();
    expect(missing.usbStale).toBe(true);

    const marker = path.join(home, ".usb-last-sync");
    fs.writeFileSync(marker, new Date(NOW.getTime() - 36 * DAY_MS).toISOString());
    expect(report().usbStale).toBe(true);

    fs.writeFileSync(marker, new Date(NOW.getTime() - 35 * DAY_MS).toISOString() + "\n");
    const fresh = report();
    expect(fresh.usbStale).toBe(false);
    expect(fresh.usbLastSync).toBe(new Date(NOW.getTime() - 35 * DAY_MS).toISOString());
  });

  it("treats an unreadable marker as stale", () => {
    fs.writeFileSync(path.join(home, ".usb-last-sync"), "not a date");
    const r = report();
    expect(r.usbLastSync).toBeNull();
    expect(r.usbStale).toBe(true);
  });

  it("sizes a category that does not exist as 0 without throwing", () => {
    const r = report();
    const byName = Object.fromEntries(r.categories.map((c) => [c.name, c.bytes]));
    expect(byName[".next"]).toBe(0);
    expect(byName["qa/tmp"]).toBe(0);
    expect(byName["backup home"]).toBe(0);
  });

  it("sums file sizes recursively without following symlinks, and includes worktrees", () => {
    put(path.join(repo, "data/a.db"), 100);
    put(path.join(repo, "data/deep/b.db"), 50);
    put(path.join(home, "recent/x.db"), 7);
    fs.symlinkSync(path.join(repo, "data"), path.join(repo, "dist"));
    const wt = path.join(tmp, "wt1");
    put(path.join(wt, "node_modules/m/index.js"), 11);
    put(path.join(wt, ".next/c.js"), 13);
    const r = report(LOW_FREE_SPACE_BYTES, [repo, wt]);
    const byName = Object.fromEntries(r.categories.map((c) => [c.name, c.bytes]));
    expect(byName["data"]).toBe(150);
    expect(byName["backup home"]).toBe(7);
    expect(byName["dist"]).toBe(0);
    expect(byName[`${wt} node_modules`]).toBe(11);
    expect(byName[`${wt} .next`]).toBe(13);
    expect(Object.keys(byName).some((n) => n.startsWith(`${repo} `))).toBe(false);
  });
});
