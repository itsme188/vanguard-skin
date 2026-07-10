import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  LIVE_SNAPSHOT_SOURCES,
  excludeLiveSnapshotsSql,
  onlyLiveSnapshotsSql,
} from "@/lib/db/live-sources";

describe("live-sources SQL fragments", () => {
  it("exposes tws and plaid as the live snapshot sources", () => {
    expect([...LIVE_SNAPSHOT_SOURCES]).toEqual(["tws", "plaid"]);
  });

  it("builds an exclusion predicate with default and aliased columns", () => {
    expect(excludeLiveSnapshotsSql()).toBe("source NOT IN ('tws','plaid')");
    expect(excludeLiveSnapshotsSql("ms.source")).toBe(
      "ms.source NOT IN ('tws','plaid')",
    );
  });

  it("builds an inclusion predicate", () => {
    expect(onlyLiveSnapshotsSql("ms.source")).toBe(
      "ms.source IN ('tws','plaid')",
    );
  });
});

describe("no raw != 'tws' predicates survive outside live-sources.ts", () => {
  // The invariant this pins: every monthly_snapshots historical read must
  // exclude ALL live sources, not just 'tws'. A raw `!= 'tws'` comparison
  // means someone bypassed the shared predicate and plaid rows would leak
  // into TWR/XIRR/chart/summary history.
  const ROOTS = ["lib", "app"];
  const ALLOWED = new Set([path.join("lib", "db", "live-sources.ts")]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(p, out);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(p);
      }
    }
    return out;
  }

  it("finds zero raw exclusion predicates", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (ALLOWED.has(file)) continue;
        const src = fs.readFileSync(file, "utf-8");
        if (/(!=|<>)\s*'tws'/.test(src)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
