/**
 * Regression: the earnings-email and briefing formatters took the sign before
 * rounding, so -0.04 printed "-0.0%" and a -0.004 EPS delta printed "$-0.00".
 * Every one now goes through lib/format/signed-fixed.ts (Worker:
 * workers/cron/src/signed-fixed.ts). Exercised through the exported callers.
 * Invented issuers and round figures only: the repo is public.
 */
import { describe, it, expect } from "vitest";
import {
  formatReactionSnapshot,
  renderPastPrintsBlock,
  renderReadThroughsBlock,
  type ReadThroughEntry,
} from "@/lib/digest/send-earnings-email";
import { formatReleasedEventForPrompt } from "@/lib/calendar/briefing";
import type { CalendarEvent } from "@/lib/types";

function readThrough(overrides: Partial<ReadThroughEntry>): ReadThroughEntry {
  return {
    reporter: "ZZA",
    reporterEventDate: "2026-04-29",
    hypothesis: null,
    weight: 1,
    consensusEps: null,
    consensusRev: null,
    actualEps: null,
    actualRev: null,
    reactionStockPct: null,
    reactionSpyPct: null,
    reactionQqqPct: null,
    ...overrides,
  };
}

describe("Mac earnings-email formatters: round first, sign the rounded figure", () => {
  it("renderPastPrintsBlock: -0.04 surprise prints 0.0%, a real move keeps its sign", () => {
    const md = renderPastPrintsBlock([
      {
        reportedDate: "2026-04-29",
        fiscalDateEnding: null,
        epsActual: 1,
        epsEstimate: 1,
        surprisePct: -0.04,
        reportTime: null,
        postPrintMovePct: -2.5,
      },
    ]);
    expect(md).toContain("| 2026-04-29 | 1.00 / 1.00 | 0.0% | -2.5% |");
    expect(md).not.toContain("-0.0%");
  });

  it("renderReadThroughsBlock: a -0.004 EPS delta is $0.00, a -0.05 delta is -$0.05", () => {
    const flat = renderReadThroughsBlock({
      symbol: "ZZB",
      readThroughs: [
        readThrough({
          consensusEps: 1,
          actualEps: 0.996,
          consensusRev: 1_000_000_000,
          actualRev: 999_600_000,
          reactionStockPct: -0.04,
          reactionSpyPct: 0.04,
        }),
      ],
    });
    expect(flat).toContain("EPS $0.00");
    expect(flat).toContain("Rev 0.0%");
    expect(flat).toContain("ZZA 0.0%");
    expect(flat).toContain("SPY 0.0%");
    expect(flat).not.toContain("$-");
    expect(flat).not.toContain("-0.0%");
    expect(flat).not.toContain("+0.0%");

    const miss = renderReadThroughsBlock({
      symbol: "ZZB",
      readThroughs: [readThrough({ consensusEps: 1, actualEps: 0.95, reactionStockPct: -3 })],
    });
    expect(miss).toContain("EPS -$0.05");
    expect(miss).toContain("ZZA -3.0%");
  });

  it("formatReactionSnapshot: a -0.001 leg prints 0.00%", () => {
    const out = formatReactionSnapshot(
      JSON.stringify({
        symbol: { t_pre: 100, t_post: 99.999, delta_pct: -0.001 },
        spy: { t_pre: 500, t_post: 502, delta_pct: 0.4 },
        pre_anchor: "prior_close",
        source: "yahoo",
      }),
    );
    expect(out).toContain("- stock: 0.00%");
    expect(out).toContain("- SPY: +0.40%");
  });
});

describe("Mac weekly briefing: fmtSignedPct", () => {
  it("formatReleasedEventForPrompt: a -0.001 reaction leg prints 0.00%", () => {
    const event = {
      id: 1,
      source: "finnhub",
      event_type: "earnings",
      event_date: "2026-05-12",
      event_time: "AMC",
      title: "ZZA earnings",
      description: null,
      security_id: null,
      symbol: "ZZA",
      ib_con_id: null,
      expected_impact: null,
      consensus_estimate: "EPS 1.00",
      previous_value: null,
      raw_json: null,
      source_key: "finnhub:ZZA:2026-05-12",
      week_of: "2026-05-11",
      fetched_at: "2026-05-04 00:00:00",
      created_at: "2026-05-04 00:00:00",
      release_time: "16:01",
      actual_value: "EPS 1.10",
      consensus_value: null,
      reaction_snapshot: JSON.stringify({
        spy: { t_pre: 500, t_post: 499.995, delta_pct: -0.001 },
        qqq: { t_pre: 400, t_post: 404, delta_pct: 1 },
      }),
      enriched_at: "2026-05-12 20:15:00",
    } as CalendarEvent;
    const out = formatReleasedEventForPrompt(event, 1);
    expect(out).toContain("SPY 0.00%");
    expect(out).toContain("QQQ +1.00%");
    expect(out).not.toContain("-0.00%");
  });
});
