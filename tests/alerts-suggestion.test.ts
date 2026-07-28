import { describe, it, expect } from "vitest";
import {
  buildSuggestionPrompt,
  normalizePositionContext,
  type SuggestionContext,
} from "@/lib/alerts/generate-suggestion";

function baseCtx(over: Partial<SuggestionContext> = {}): SuggestionContext {
  return {
    symbol: "AAPL",
    securityName: "Apple Inc",
    securityType: "stock",
    levelType: "entry",
    levelPrice: 180,
    triggeredPrice: 179.5,
    direction: null,
    sourceAuthor: null,
    thesis: null,
    timeframe: null,
    actionHint: null,
    held: [],
    onWatchlist: false,
    watchlistGroup: null,
    ...over,
  };
}

describe("buildSuggestionPrompt", () => {
  it("includes symbol, level type, prices, and held status", () => {
    const prompt = buildSuggestionPrompt(baseCtx());
    expect(prompt).toContain("AAPL");
    expect(prompt).toContain("Apple Inc");
    expect(prompt).toContain("entry");
    expect(prompt).toContain("$180.00");
    expect(prompt).toContain("$179.50");
    expect(prompt).toContain("Not currently held");
  });

  it("formats held positions across accounts", () => {
    const prompt = buildSuggestionPrompt(
      baseCtx({
        held: [
          { account: "IBKR", quantity: 100 },
          { account: "Roth IRA", quantity: 50 },
        ],
      })
    );
    expect(prompt).toContain("100 shares in IBKR");
    expect(prompt).toContain("50 shares in Roth IRA");
    expect(prompt).not.toContain("Not currently held");
  });

  it("surfaces source author + thesis when provided", () => {
    const prompt = buildSuggestionPrompt(
      baseCtx({
        sourceAuthor: "Purple Drink",
        thesis: "50-day SMA held in March",
      })
    );
    expect(prompt).toContain("Purple Drink");
    expect(prompt).toContain("50-day SMA held in March");
  });

  it("notes watchlist grouping with friendly formatting", () => {
    const prompt = buildSuggestionPrompt(
      baseCtx({ onWatchlist: true, watchlistGroup: "ibkr_buy_next" })
    );
    expect(prompt).toContain("watchlist");
    expect(prompt).toContain("ibkr buy next");
  });

  it("omits the group parenthetical when group is 'default'", () => {
    const prompt = buildSuggestionPrompt(
      baseCtx({ onWatchlist: true, watchlistGroup: "default" })
    );
    expect(prompt).toContain("On watchlist.");
    expect(prompt).not.toContain("(default");
  });

  it("includes direction, timeframe, and action_hint when provided", () => {
    const prompt = buildSuggestionPrompt(
      baseCtx({ direction: "bearish", timeframe: "week", actionHint: "trim" })
    );
    expect(prompt).toContain("Direction: bearish");
    expect(prompt).toContain("Timeframe: week");
    expect(prompt).toContain("Originally flagged as: trim");
  });

  it("requests one sentence, analytical tone, no preamble", () => {
    const prompt = buildSuggestionPrompt(baseCtx());
    // These guardrails prevent verbose, cheerleadery output
    expect(prompt).toContain("ONE-SENTENCE");
    expect(prompt).toContain("analytical like a colleague");
    expect(prompt).toContain("No hype language");
    expect(prompt).toContain("No preamble");
    expect(prompt).toContain("EXACTLY one sentence");
  });

  it("respects watchlist friction — advises patience over action", () => {
    const prompt = buildSuggestionPrompt(baseCtx());
    expect(prompt).toContain("patience");
    expect(prompt.toLowerCase()).toContain("holding pen");
  });

  it("handles underscored level types cleanly", () => {
    const prompt = buildSuggestionPrompt(
      baseCtx({ levelType: "scale_in", actionHint: "new_position" })
    );
    expect(prompt).toContain("scale in");
    expect(prompt).toContain("new position");
  });
});

describe("normalizePositionContext", () => {
  it("passes a well-formed Mac-fired context through", () => {
    const ctx = normalizePositionContext(
      JSON.stringify({
        held: [{ account: "Roth IRA", quantity: 40 }],
        onWatchlist: true,
        watchlistGroup: "vanguard_buy",
      })
    );
    expect(ctx.held).toEqual([{ account: "Roth IRA", quantity: 40 }]);
    expect(ctx.onWatchlist).toBe(true);
    expect(ctx.watchlistGroup).toBe("vanguard_buy");
  });

  it("degrades a cloud_scan-shaped context to empty defaults instead of crashing", () => {
    // reconcileCloudFiredLevels stores the Worker payload verbatim — a
    // DIFFERENT schema. Pre-fix this replaced the defaults wholesale, ctx.held
    // came out undefined, and buildSuggestionPrompt threw "Cannot read
    // properties of undefined (reading 'length')" — every cloud-fired alert
    // permanently failed suggestion generation
    // (qa: alerts-inbox--suggest-all-reports-noop-when-all-failed).
    const ctx = normalizePositionContext(
      JSON.stringify({
        source: "cloud_scan",
        fired_at: "2026-07-23T13:30:14.000Z",
        symbol: "SPY",
        level_type: "support",
        level_price: 740,
      })
    );
    expect(ctx).toEqual({ held: [], onWatchlist: false, watchlistGroup: null });
    // And the prompt builder must accept the normalized shape.
    const prompt = buildSuggestionPrompt({ ...baseCtx(), ...ctx });
    expect(prompt).toContain("Not currently held.");
  });

  it("handles null, malformed JSON, and non-array held", () => {
    expect(normalizePositionContext(null)).toEqual({ held: [], onWatchlist: false, watchlistGroup: null });
    expect(normalizePositionContext("not json{")).toEqual({ held: [], onWatchlist: false, watchlistGroup: null });
    expect(normalizePositionContext("null")).toEqual({ held: [], onWatchlist: false, watchlistGroup: null });
    expect(normalizePositionContext(JSON.stringify({ held: "yes" }))).toEqual({
      held: [], onWatchlist: false, watchlistGroup: null,
    });
  });
});
