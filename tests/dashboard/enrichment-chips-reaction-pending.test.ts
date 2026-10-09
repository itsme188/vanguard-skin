import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EnrichmentRowSummary,
  EnrichmentDetail,
  reactionSummaryPairs,
  reactionDetailRows,
} from "@/app/dashboard/components/calendar/EnrichmentChips";
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot-core";

// Owner ruling 2026-10-08: a reaction leg that was read before its own
// window elapsed (or whose pre and post are the same quote) is a missing
// measurement. Every surface shows "pending" for it, never "0.00%".
// No DOM harness in this repo — renderToStaticMarkup + source pins.
// All prices are invented round figures.

const T0 = "2026-01-05T15:00:00.000Z";
const MIN = 60 * 1000;
const at = (min: number) => new Date(Date.parse(T0) + min * MIN).toISOString();

function snap(extra: Partial<ReactionSnapshot> = {}): ReactionSnapshot {
  return {
    t0_utc: T0,
    window_min: 120,
    source: "yahoo",
    spy: { t_pre: 500, t_post: 505, delta_pct: 1 },
    qqq: { t_pre: 400, t_post: 398, delta_pct: -0.5 },
    tlt: { t_pre: 90, t_post: 90.45, delta_pct: 0.5 },
    ...extra,
  };
}

// The reported shape: prices a fraction of a cent apart on a row enriched
// seven minutes into a 120-minute window.
const REPORTED = snap({ symbol: { symbol: "ZZA", t_pre: 100.006, t_post: 100.01, delta_pct: 0 } });
const ENRICHED_EARLY = "2026-01-05 15:07:00";

describe("reactionSummaryPairs — pending legs", () => {
  it("marks the stock's own leg pending instead of handing back 0", () => {
    const pairs = reactionSummaryPairs(REPORTED, {
      preferEventSymbol: true,
      eventSymbol: "ZZA",
      enrichedAt: ENRICHED_EARLY,
    });
    expect(pairs).toEqual([
      { label: "ZZA", pct: null, pending: true },
      { label: "SPY", pct: 1 },
    ]);
  });

  it("marks every leg pending when the snapshot was captured before its window ended", () => {
    const pairs = reactionSummaryPairs(snap({ captured_at: at(7) }));
    expect(pairs).toEqual([
      { label: "SPY", pct: null, pending: true },
      { label: "QQQ", pct: null, pending: true },
    ]);
  });

  it("leaves a properly captured snapshot alone, flat legs included", () => {
    const pairs = reactionSummaryPairs(
      snap({ captured_at: at(121), qqq: { t_pre: 400, t_post: 400, delta_pct: 0 } }),
    );
    expect(pairs).toEqual([
      { label: "SPY", pct: 1 },
      { label: "QQQ", pct: 0 },
    ]);
  });

  it("an identical pre/post pair with no capture stamp is pending", () => {
    const pairs = reactionSummaryPairs(snap({ qqq: { t_pre: 400, t_post: 400, delta_pct: 0 } }));
    expect(pairs[1]).toEqual({ label: "QQQ", pct: null, pending: true });
  });
});

describe("EnrichmentRowSummary — renders 'pending', never 0.00%", () => {
  it("the reported row", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentRowSummary, {
        actual: null,
        snapshot: REPORTED,
        preferEventSymbol: true,
        eventSymbol: "ZZA",
        enrichedAt: ENRICHED_EARLY,
      }),
    );
    expect(html).toContain("ZZA pending");
    expect(html).not.toContain("0.00%");
    expect(html).toContain("SPY +1.00%");
    // Says why, in plain words, without relying on hover alone for the state.
    expect(html).toContain("not measured yet");
  });

  it("the same snapshot via snapshotRaw (the server-caller road)", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentRowSummary, {
        actual: null,
        snapshotRaw: JSON.stringify(snap({ captured_at: at(7) })),
      }),
    );
    expect(html).toContain("SPY pending");
    expect(html).toContain("QQQ pending");
    expect(html).not.toContain("%");
  });

  it("without the enrichment stamp the legacy 0.00% leg is still shown as measured (no evidence it was early)", () => {
    const html = renderToStaticMarkup(
      createElement(EnrichmentRowSummary, {
        actual: null,
        snapshot: REPORTED,
        preferEventSymbol: true,
        eventSymbol: "ZZA",
      }),
    );
    expect(html).toContain("ZZA 0.00%");
  });
});

describe("EnrichmentDetail — pending legs", () => {
  it("keeps the leg's row but replaces prices and percent with 'pending'", () => {
    const rows = reactionDetailRows(REPORTED, { enrichedAt: ENRICHED_EARLY });
    expect(rows.map((r) => [r.label, r.pending === true])).toEqual([
      ["ZZA", true],
      ["SPY", false],
      ["QQQ", false],
      ["TLT", false],
    ]);

    const html = renderToStaticMarkup(
      createElement(EnrichmentDetail, { actual: null, snapshot: REPORTED, enrichedAt: ENRICHED_EARLY }),
    );
    expect(html).toContain("pending");
    expect(html).not.toContain("0.00%");
    expect(html).not.toContain("100.01");
    expect(html).toContain("500.00 → 505.00");
  });

  it("a dead-quote placeholder leg is still left out entirely (unchanged)", () => {
    const rows = reactionDetailRows(snap({ qqq: { t_pre: 0, t_post: 0, delta_pct: 0 } }));
    expect(rows.map((r) => r.label)).toEqual(["SPY", "TLT"]);
  });
});

describe("callers pass the enrichment stamp to the summary line", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("WeekAheadView", () => {
    const src = read("app/dashboard/today/WeekAheadView.tsx");
    const i = src.indexOf("<EnrichmentRowSummary");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, src.indexOf("/>", i))).toContain("enrichedAt={event.enriched_at}");
  });

  it("TodayReleases", () => {
    const src = read("app/dashboard/components/TodayReleases.tsx");
    const i = src.indexOf("<EnrichmentRowSummary");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, src.indexOf("/>", i))).toContain("enrichedAt={event.enriched_at}");
  });

  it("the validity rule is the shared one, not a local copy", () => {
    const src = read("app/dashboard/components/calendar/EnrichmentChips.tsx");
    expect(src).toContain('from "@/lib/calendar/reaction-validity"');
  });
});
