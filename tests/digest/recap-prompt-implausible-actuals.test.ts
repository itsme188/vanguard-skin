import { describe, it, expect } from "vitest";
import {
  renderRecapPrompt,
  type EarningsRecapContext,
} from "@/lib/digest/send-earnings-email";
import type { CalendarEvent } from "@/lib/types";

/**
 * The deterministic scoreboard (renderHeadlineTable) blanks actuals that
 * isPlausibleEarnings flags as implausible vs consensus (Finnhub drift
 * defense). Pre-fix, renderRecapPrompt still fed those same values into the
 * AI context as "Reported actual (from enrichment runner)", so the model's
 * "Line-by-line metrics" table restated the exact numbers the scoreboard
 * just withheld, directly contradicting the ⚠ flagged-actuals warning
 * (qa: today-earningshub-gen--recap-ai-table-restates-actuals-scoreboard-blanked-as-implausible).
 * The prompt must mirror the scoreboard's gate: withhold flagged values and
 * instruct press-release verification via web_search instead.
 */
function makeEvent(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 1,
    source: "finnhub",
    event_type: "earnings",
    event_date: "2026-05-15",
    title: "GOOGL earnings",
    source_key: "finnhub:GOOGL:2026-05-15",
    fetched_at: "2026-05-10 00:00:00",
    created_at: "2026-05-10 00:00:00",
    description: null,
    expected_impact: null,
    consensus_estimate: null,
    actual_value: null,
    consensus_value: null,
    previous_value: null,
    reaction_snapshot: null,
    enriched_at: null,
    symbol: "GOOGL",
    security_id: null,
    ib_con_id: null,
    week_of: "2026-05-11",
    raw_json: null,
    event_time: null,
    release_time: null,
    ...overrides,
  } as CalendarEvent;
}

function makeRecapCtx(eventOverrides: Partial<CalendarEvent>): EarningsRecapContext {
  return {
    symbol: "GOOGL",
    family: ["GOOGL", "GOOG"],
    event: makeEvent(eventOverrides),
    positions: [],
    longShares: 0,
    shortShares: 0,
    longContracts: 0,
    shortContracts: 0,
    userNotes: [],
    recentArticles: [],
    recommendationTrend: null,
    priceTarget: null,
    ratingChanges: null,
    recentPressReleases: null,
    priorTranscript: null,
    bogeys: [],
    readThroughs: [],
    priorCallNote: null,
    reactionSnapshotMarkdown: null,
    freshPressReleases: null,
    callNote: null,
  };
}

describe("renderRecapPrompt mirrors the scoreboard plausibility gate", () => {
  it("withholds implausible actuals from the AI context (never restates flagged values)", () => {
    // EPS 5.11 vs consensus 2.70 is 1.89x — outside isPlausibleEarnings'
    // [0.5x, 1.7x] band (the real GOOGL Q1 2026 Finnhub scrape error).
    const prompt = renderRecapPrompt(
      makeRecapCtx({
        consensus_estimate: "EPS 2.70 · Rev 90B",
        actual_value: "EPS 5.11 · Rev 91B",
      })
    );
    expect(prompt).not.toContain("5.11");
    expect(prompt.toLowerCase()).toContain("implausible");
    // The model is redirected to primary-source verification.
    expect(prompt).toContain("web_search");
    expect(prompt.toLowerCase()).toContain("press release");
  });

  it("passes plausible actuals through unchanged", () => {
    const prompt = renderRecapPrompt(
      makeRecapCtx({
        consensus_estimate: "EPS 2.70 · Rev 90B",
        actual_value: "EPS 2.85 · Rev 92B",
      })
    );
    expect(prompt).toContain("Reported actual (from enrichment runner)");
    expect(prompt).toContain("EPS 2.85 · Rev 92B");
  });

  it("keeps the enrichment-gap block when no actual exists", () => {
    const prompt = renderRecapPrompt(makeRecapCtx({}));
    expect(prompt).toContain("Enrichment hasn't captured the actual yet");
  });
});

/**
 * ...but a manually-stamped actual is the desk's own override (POST
 * /api/earnings/actuals → manual_actuals_at), not a vendor scrape — the read
 * surfaces already show it, and the scoreboard renders it, so the AI context
 * must carry it too or the model would "verify" a figure the user typed in.
 */
describe("renderRecapPrompt — manual actuals override the plausibility gate", () => {
  it("passes a manually-stamped implausible actual through as a reported actual", () => {
    const prompt = renderRecapPrompt(
      makeRecapCtx({
        consensus_estimate: "EPS 1.74",
        actual_value: "EPS -1.20",
        manual_actuals_at: "2026-08-28 14:02:11",
      })
    );
    expect(prompt).toContain("Reported actual (from enrichment runner)");
    expect(prompt).toContain("EPS -1.20");
    expect(prompt.toLowerCase()).not.toContain("flagged as implausible");
  });

  it("the same tuple without the stamp is still withheld", () => {
    const prompt = renderRecapPrompt(
      makeRecapCtx({ consensus_estimate: "EPS 1.74", actual_value: "EPS -1.20" })
    );
    expect(prompt).not.toContain("-1.20");
    expect(prompt.toLowerCase()).toContain("implausible");
  });
});
