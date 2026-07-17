/**
 * "Today's reporters" — Worker mirror tests (#18).
 *
 * Spec: docs/superpowers/specs/2026-07-16-todays-reporters-digest-block-design.md
 * Parity: the renderer is a byte-parity hand-copy of
 * lib/digest/todays-reporters-render.ts — pinned here behaviorally (the
 * editions.ts pattern: import both sides, feed identical inputs) AND
 * byte-wise below the header.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as workerRender from "../src/todays-reporters-render";
import * as macRender from "../../../lib/digest/todays-reporters-render";
import { buildTodaysReportersBlock } from "../src/todays-reporters";
import type { Snapshot } from "../src/state";

const TODAY = "2026-07-16";

function stripHeader(source: string): string {
  return source.split("*/").slice(1).join("*/");
}

describe("renderer parity (Worker mirror of lib/digest/todays-reporters-render.ts)", () => {
  it("files are byte-identical below the header", () => {
    // Paths anchored to THIS file (import.meta.url), not cwd — the root
    // vitest run executes Worker tests with cwd at the repo root.
    const mac = stripHeader(
      readFileSync(
        new URL("../../../lib/digest/todays-reporters-render.ts", import.meta.url),
        "utf-8",
      ),
    );
    const worker = stripHeader(
      readFileSync(new URL("../src/todays-reporters-render.ts", import.meta.url), "utf-8"),
    );
    expect(worker).toBe(mac);
  });

  it("renders identically for the same rows", () => {
    const rows = [
      { slot: "BMO", time: "08:00", symbol: "TSM", chip: "held", cons: "$3.80", impl: "±4.0%" },
      { slot: "AMC", time: null, symbol: "NFLX", chip: "", cons: null, impl: null },
    ];
    expect(workerRender.renderTodaysReportersBlock(rows)).toBe(
      macRender.renderTodaysReportersBlock(rows),
    );
    expect(workerRender.renderTodaysReportersBlock([])).toBeNull();
    expect(macRender.renderTodaysReportersBlock([])).toBeNull();
  });
});

// ── Snapshot assembly ────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<Snapshot>): Snapshot {
  return {
    schemaVersion: 9,
    calendarEvents: [],
    heldSymbols: [],
    ...overrides,
  } as unknown as Snapshot;
}

function makeEvent(overrides: Record<string, unknown>) {
  return {
    id: 1,
    source: "finnhub",
    event_type: "earnings",
    event_date: TODAY,
    event_time: null,
    title: "X earnings",
    description: null,
    security_id: null,
    symbol: "X",
    expected_impact: null,
    consensus_estimate: null,
    previous_value: null,
    raw_json: null,
    release_time: "08:00",
    superseded: 0,
    ...overrides,
  };
}

describe("buildTodaysReportersBlock", () => {
  it("returns null when nothing reports today", () => {
    const snapshot = makeSnapshot({
      calendarEvents: [makeEvent({ event_date: "2026-07-30" })] as never,
    });
    expect(buildTodaysReportersBlock(snapshot, TODAY)).toBeNull();
  });

  it("renders held chip via issuer family, compact consensus, and snapshot intel", () => {
    const snapshot = makeSnapshot({
      calendarEvents: [
        makeEvent({
          id: 590,
          symbol: "GOOGL", // family match: we "hold" GOOG
          consensus_estimate: "EPS 3.80 · Rev 12,840,078,158",
          release_time: "08:00",
        }),
      ] as never,
      heldSymbols: ["GOOG"],
      earningsIntel: [
        {
          eventId: 590,
          sourceKey: "finnhub:GOOGL:2026-07-16",
          impliedMovePct: 4.02,
          impliedMethod: "straddle",
          expiryUsed: null,
          computedAt: "2026-07-16T10:00:00Z",
        },
      ] as never,
    });

    const block = buildTodaysReportersBlock(snapshot, TODAY)!;
    expect(block).toContain("| BMO 08:00 | GOOGL | held | $3.80 · $12.84B | ±4.0% |");
  });

  it("skips superseded rows and dedupes finnhub-preferred (B12 family)", () => {
    const snapshot = makeSnapshot({
      calendarEvents: [
        makeEvent({ id: 1, symbol: "DUP", source: "nasdaq", consensus_estimate: "EPS 1.90" }),
        makeEvent({ id: 2, symbol: "DUP", source: "finnhub", consensus_estimate: "EPS 2.00" }),
        makeEvent({ id: 3, symbol: "GONE", superseded: 1 }),
      ] as never,
    });

    const block = buildTodaysReportersBlock(snapshot, TODAY)!;
    expect(block.split("DUP").length - 1).toBe(1);
    expect(block).toContain("$2.00"); // finnhub row wins
    expect(block).not.toContain("GONE");
  });

  it("degrades gracefully on pre-v8/v9 snapshots (no chips, no impl — block still renders)", () => {
    const snapshot = makeSnapshot({
      calendarEvents: [makeEvent({ symbol: "TSM", consensus_estimate: "EPS 3.80" })] as never,
    });
    delete (snapshot as Record<string, unknown>).heldSymbols;

    const block = buildTodaysReportersBlock(snapshot, TODAY)!;
    expect(block).toContain("| BMO 08:00 | TSM | — | $3.80 | — |");
  });

  it("watchlist chip from v8 watchlistSymbols", () => {
    const snapshot = makeSnapshot({
      calendarEvents: [makeEvent({ symbol: "WLNAME" })] as never,
      watchlistSymbols: ["WLNAME"],
    });
    const block = buildTodaysReportersBlock(snapshot, TODAY)!;
    expect(block).toContain("| WLNAME | wl |");
  });

  it("ticker 'BMO' with an After-Market title classifies AMC (phrase-only matching)", () => {
    const snapshot = makeSnapshot({
      calendarEvents: [
        makeEvent({
          symbol: "BMO",
          title: "BMO earnings (After Market Close)",
          release_time: null,
        }),
      ] as never,
    });
    const block = buildTodaysReportersBlock(snapshot, TODAY)!;
    expect(block).toContain("| AMC | BMO |");
  });

  it("sorts BMO before AMC, then by release time", () => {
    const snapshot = makeSnapshot({
      calendarEvents: [
        makeEvent({ id: 1, symbol: "LATE", release_time: "16:15" }),
        makeEvent({ id: 2, symbol: "EARLY", release_time: "08:00" }),
      ] as never,
    });
    const block = buildTodaysReportersBlock(snapshot, TODAY)!;
    expect(block.indexOf("EARLY")).toBeLessThan(block.indexOf("LATE"));
  });
});
