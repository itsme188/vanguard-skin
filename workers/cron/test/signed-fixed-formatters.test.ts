/**
 * Regression: the cloud earnings formatters took the sign before rounding, so
 * -0.04 printed "-0.0%" and a -0.004 EPS consensus printed "-$0.00". Each now
 * goes through src/signed-fixed.ts (hand-mirrored from the Mac's
 * lib/format/signed-fixed.ts; parity in tests/format/signed-fixed-parity.test.ts).
 * Synthetic issuers and prices only.
 */
import { describe, it, expect } from "vitest";
import { renderPastPrintsBlock, renderScoreboard } from "../src/fallback-earnings";
import { buildTodaysReportersBlock } from "../src/todays-reporters";
import type { CalendarEventRow, Snapshot } from "../src/state";

describe("Worker earnings formatters: round first, sign the rounded figure", () => {
  it("renderPastPrintsBlock: -0.04 prints 0.0%, a real move keeps its sign", () => {
    const md = renderPastPrintsBlock([
      { reportedDate: "2026-04-29", epsActual: 1, epsEstimate: 1, surprisePct: -0.04, postPrintMovePct: 2.5 },
    ]);
    expect(md).toContain("| 2026-04-29 | 1.00 / 1.00 | 0.0% | +2.5% |");
    expect(md).not.toContain("-0.0%");
  });

  it("renderScoreboard: a -0.001 leg prints 0.00%, a -0.04 realized move prints 0.0% on the expected-move row", () => {
    const event = {
      id: 1, source: "finnhub", event_type: "earnings", event_date: "2026-06-15",
      event_time: "AMC", title: "ZZA earnings", description: null, security_id: null,
      symbol: "ZZA", expected_impact: "high",
      consensus_estimate: "EPS 1.50 · Rev 90,000,000,000",
      previous_value: null, raw_json: null,
      consensus_value: null, actual_value: "EPS 1.60 · Rev 91,000,000,000",
      reaction_snapshot: JSON.stringify({
        t0_utc: "2026-06-15T20:00:00.000Z",
        window_min: 120,
        captured_at: "2026-06-15T22:05:00.000Z",
        symbol: { symbol: "ZZA", t_pre: 100, t_post: 99.96, delta_pct: -0.04 },
        spy: { t_pre: 500, t_post: 499.995, delta_pct: -0.001 },
        qqq: { t_pre: 400, t_post: 398, delta_pct: -0.5 },
      }),
      enriched_at: null,
    } as unknown as CalendarEventRow;
    const intelCtx = {
      intel: {
        eventId: 1, sourceKey: "x", impliedMovePct: 4.8, impliedMethod: "straddle",
        expiryUsed: "2026-07-18", computedAt: "2026-06-14 06:00:00",
      },
      history: null,
    } as unknown as Parameters<typeof renderScoreboard>[4];
    const md = renderScoreboard(event, "recap", null, false, intelCtx);
    const row = (needle: string) => md.split("\n").find((l) => l.includes(needle));
    expect(row("**SPY @ T+2h**")).toBe("| **SPY @ T+2h** | — | 0.00% | — |");
    expect(row("**ZZA @ T+2h**")).toBe("| **ZZA @ T+2h** | — | -0.04% | — |");
    expect(row("**QQQ @ T+2h**")).toBe("| **QQQ @ T+2h** | — | -0.50% | — |");
    expect(row("**Expected move**")).toContain("| 0.0% | inside |");
    expect(md).not.toContain("-0.0%");
    expect(md).not.toContain("-0.00%");
  });

  it("todays-reporters consensus: EPS -0.004 prints $0.00, EPS -0.05 prints -$0.05", () => {
    const event = (symbol: string, consensus: string) => ({
      id: symbol === "ZZA" ? 1 : 2, source: "finnhub", event_type: "earnings",
      event_date: "2026-07-16", event_time: null, title: `${symbol} earnings`,
      description: null, security_id: null, symbol, expected_impact: null,
      consensus_estimate: consensus, previous_value: null, raw_json: null,
      release_time: "08:00", superseded: 0,
    });
    const snapshot = {
      schemaVersion: 9,
      calendarEvents: [event("ZZA", "EPS -0.004"), event("ZZB", "EPS -0.05")],
      heldSymbols: [],
    } as unknown as Snapshot;
    const block = buildTodaysReportersBlock(snapshot, "2026-07-16")!;
    expect(block).toContain("| BMO 08:00 | ZZA | — | $0.00 | — |");
    expect(block).toContain("| BMO 08:00 | ZZB | — | -$0.05 | — |");
    expect(block).not.toContain("-$0.00");
  });
});
