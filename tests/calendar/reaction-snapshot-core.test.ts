/**
 * Unit tests for lib/calendar/reaction-snapshot-core.ts — the type +
 * pure parseReactionSnapshot/snapshotCoversEventDate helpers.
 *
 * Two rounds of the same underlying bug (2026-08-14, qa fix):
 *
 * Round 1: WeekAheadView.tsx is a Server Component (no "use client")
 * calling parseReactionSnapshot()/snapshotCoversEventDate() directly.
 * Those lived in EnrichmentChips.tsx ('use client'). React Server
 * Components forbid calling a plain (non-component) export of a 'use
 * client' module from server code — only JSX rendering of client
 * COMPONENTS may cross that boundary. Crash: "Attempted to call
 * parseReactionSnapshot() from the server but parseReactionSnapshot is on
 * the client." Fix moved the two helpers into lib/calendar/reaction-snapshot.ts.
 *
 * Round 2: that "fix" broke the CLIENT bundle instead. reaction-snapshot.ts
 * imports real values from "@stoqey/ib" (BarSizeSetting, SecType) at module
 * scope for the TWS bar-capture pipeline, and @stoqey/ib touches Node's
 * `net` module. EnrichmentChips.tsx and TodayReleases.tsx (both 'use
 * client') importing a value from reaction-snapshot.ts dragged that whole
 * module graph into the browser bundle: webpack failed with "Module not
 * found: Can't resolve 'net'".
 *
 * Fix: this dependency-free leaf module. It must never import anything at
 * runtime (see the "stays dependency-free" guard below) so both server
 * (WeekAheadView.tsx) and client (EnrichmentChips.tsx, TodayReleases.tsx)
 * code can safely import from it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseReactionSnapshot,
  snapshotCoversEventDate,
  type ReactionSnapshot,
} from "@/lib/calendar/reaction-snapshot-core";

describe("parseReactionSnapshot", () => {
  it("parses a realistic stored snapshot", () => {
    const raw = JSON.stringify({
      t0_utc: "2026-08-13T14:55:00.000Z",
      window_min: 120,
      source: "tws",
      spy: { t_pre: 741.4, t_post: 742.23, delta_pct: 0.11 },
      qqq: { t_pre: 683.53, t_post: 687.28, delta_pct: 0.55 },
      tlt: { t_pre: 82.83, t_post: 82.72, delta_pct: -0.13 },
      symbol: { symbol: "AMZN", t_pre: 235.58, t_post: 257, delta_pct: 9.09 },
    });
    const parsed = parseReactionSnapshot(raw);
    expect(parsed?.source).toBe("tws");
    expect(parsed?.spy.delta_pct).toBe(0.11);
    expect(parsed?.symbol?.symbol).toBe("AMZN");
  });

  it("survives malformed JSON", () => {
    expect(parseReactionSnapshot("{not json")).toBeNull();
    expect(parseReactionSnapshot(null)).toBeNull();
  });
});

describe("snapshotCoversEventDate", () => {
  function snap(t0: string | undefined): ReactionSnapshot {
    return { t0_utc: t0 } as unknown as ReactionSnapshot;
  }

  it("accepts a t0 on the event's ET date", () => {
    // 14:55Z on Aug 13 = 10:55 ET Aug 13.
    expect(snapshotCoversEventDate("2026-08-13", snap("2026-08-13T14:55:00.000Z"))).toBe(true);
  });

  it("accepts an evening AMC print whose UTC date rolled over", () => {
    // 00:15Z Aug 14 = 20:15 ET Aug 13 — same ET date as the event.
    expect(snapshotCoversEventDate("2026-08-13", snap("2026-08-14T00:15:00.000Z"))).toBe(true);
  });

  it("rejects a t0 measured the day BEFORE the event (pre-print snapshot)", () => {
    // LAC shape: event 2026-08-13, snapshot measured 10:55 ET on Aug 12.
    expect(snapshotCoversEventDate("2026-08-13", snap("2026-08-12T14:55:00.000Z"))).toBe(false);
  });

  it("rejects a t0 measured the day AFTER the event", () => {
    // OCUL shape: event 2026-08-03, snapshot measured 16:15 ET on Aug 4.
    expect(snapshotCoversEventDate("2026-08-03", snap("2026-08-04T20:15:00.000Z"))).toBe(false);
  });

  it("rejects a snapshot with no t0 and a garbage t0", () => {
    expect(snapshotCoversEventDate("2026-08-13", snap(undefined))).toBe(false);
    expect(snapshotCoversEventDate("2026-08-13", snap("not-a-date"))).toBe(false);
    expect(snapshotCoversEventDate("2026-08-13", null)).toBe(false);
  });
});

// ── Client/RSC boundary regression guards ─────────────────────────────

describe("reaction-snapshot-core.ts stays dependency-free (qa: client-bundle break)", () => {
  it("has no runtime (value) imports — only `import type`, if any", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/calendar/reaction-snapshot-core.ts"),
      "utf8",
    );
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\s/.test(line));
    for (const line of importLines) {
      expect(line.trim()).toMatch(/^import\s+type\s/);
    }
  });
});

/**
 * Reads a file's `import { ... } from "..."` statements and returns the
 * module path(s) any of `helperNames` are imported from.
 */
function helperImportSources(filePath: string, helperNames: string[]): string[] {
  const source = readFileSync(join(process.cwd(), filePath), "utf8");
  const importStatements = [
    ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g),
  ];
  return importStatements
    .filter(([, names]) => helperNames.some((n) => new RegExp(`\\b${n}\\b`).test(names)))
    .map(([, , modulePath]) => modulePath);
}

describe("parseReactionSnapshot/snapshotCoversEventDate importers use the core module", () => {
  const HELPERS = ["parseReactionSnapshot", "snapshotCoversEventDate"];

  // WeekAheadView.tsx is a Server Component — calling a value export of a
  // 'use client' module from here crashes (round 1's bug).
  it("WeekAheadView.tsx (server) imports only from reaction-snapshot-core", () => {
    const sources = helperImportSources("app/dashboard/today/WeekAheadView.tsx", HELPERS);
    expect(sources.length).toBeGreaterThan(0); // guard isn't vacuous
    for (const modulePath of sources) {
      expect(modulePath).toBe("@/lib/calendar/reaction-snapshot-core");
    }
  });

  // EnrichmentChips.tsx / TodayReleases.tsx are 'use client' — importing a
  // value from the heavy reaction-snapshot.ts (which pulls in @stoqey/ib)
  // breaks the browser bundle (round 2's bug).
  it("EnrichmentChips.tsx (client) imports only from reaction-snapshot-core", () => {
    const sources = helperImportSources(
      "app/dashboard/components/calendar/EnrichmentChips.tsx",
      HELPERS,
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const modulePath of sources) {
      expect(modulePath).toBe("@/lib/calendar/reaction-snapshot-core");
    }
  });

  it("TodayReleases.tsx (client) imports only from reaction-snapshot-core", () => {
    const sources = helperImportSources(
      "app/dashboard/components/TodayReleases.tsx",
      HELPERS,
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const modulePath of sources) {
      expect(modulePath).toBe("@/lib/calendar/reaction-snapshot-core");
    }
  });
});
