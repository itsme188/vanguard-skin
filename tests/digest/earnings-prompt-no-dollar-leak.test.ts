import { describe, it, expect } from "vitest";
import {
  renderPreviewPrompt,
  renderRecapPrompt,
  type EarningsPreviewContext,
  type EarningsRecapContext,
} from "@/lib/digest/send-earnings-email";
import type { CalendarEvent } from "@/lib/types";

/**
 * Regression for the 2026-05-12 outbound-email $-amount stripping.
 *
 * The earnings preview + recap prompts used to interpolate exact cost basis
 * + per-share cost + last price into the Positions block, which Sonnet/Opus
 * echoed verbatim into prose ("you hold 500 sh AAPL at $100 cost basis,
 * last $175, $87,500 mkt val"). With the cc-recipient delivery model,
 * exact $ position amounts are a privacy leak.
 *
 * These tests assert the position-block output:
 *   - Contains ownership disclosure (qty + symbol + account)
 *   - Contains relative-return % when cost basis + price are present
 *   - Does NOT contain "cost basis" / "mkt val" / "market value"
 *   - Does NOT contain comma-grouped $ amounts ($X,XXX or $XX,XXX)
 *   - Does NOT contain a "$" followed by a decimal cost-basis figure
 *
 * Strike + expiry on options STAY visible ("$145 call expiring 2026-06-19")
 * — those are public market metadata, not user position size.
 */

function makeEvent(symbol: string): CalendarEvent {
  return {
    id: 1,
    source: "finnhub",
    event_type: "earnings",
    event_date: "2026-05-15",
    title: `${symbol} earnings`,
    source_key: `finnhub:${symbol}:2026-05-15`,
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
    symbol,
    security_id: null,
    ib_con_id: null,
    week_of: "2026-05-11",
    raw_json: null,
    event_time: null,
    release_time: null,
  } as CalendarEvent;
}

function makeStockPositionCtx(): EarningsPreviewContext {
  return {
    symbol: "AAPL",
    family: ["AAPL"],
    event: makeEvent("AAPL"),
    positions: [
      {
        account_name: "vanguard taxable",
        symbol: "AAPL",
        quantity: 500,
        cost_basis: 50000, // $100/sh × 500 sh
        as_of_date: "2026-05-12",
        latest_price: 175,
        security_type: "stock",
        underlying_symbol: null,
        option_type: null,
        strike_price: null,
        expiration_date: null,
        multiplier: null,
      },
    ],
    longShares: 500,
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
  };
}

function makeOptionPositionCtx(): EarningsPreviewContext {
  return {
    ...makeStockPositionCtx(),
    positions: [
      {
        account_name: "ibkr",
        symbol: "AAPL  260619C00145000",
        quantity: 3,
        cost_basis: 1500,
        as_of_date: "2026-05-12",
        latest_price: 6,
        security_type: "option",
        underlying_symbol: "AAPL",
        option_type: "CALL",
        strike_price: 145,
        expiration_date: "2026-06-19",
        multiplier: 100,
      },
    ],
    longShares: 0,
    shortShares: 0,
    longContracts: 3,
    shortContracts: 0,
  };
}

function makeShortStockPositionCtx(): EarningsPreviewContext {
  return {
    ...makeStockPositionCtx(),
    positions: [
      {
        account_name: "ibkr",
        symbol: "AAPL",
        quantity: -300,
        cost_basis: 45000,
        as_of_date: "2026-05-12",
        latest_price: 175,
        security_type: "stock",
        underlying_symbol: null,
        option_type: null,
        strike_price: null,
        expiration_date: null,
        multiplier: null,
      },
    ],
    longShares: 0,
    shortShares: 300,
    longContracts: 0,
    shortContracts: 0,
  };
}

function assertNoDollarLeak(prompt: string): void {
  const lines = prompt.split("\n");
  const posIdx = lines.findIndex((l) => l.startsWith("## Positions"));
  expect(posIdx).toBeGreaterThanOrEqual(0);
  // Take the positions block up to the next ## section header
  const nextSection = lines.slice(posIdx + 1).findIndex((l) => l.startsWith("## "));
  const positionsBlock = lines
    .slice(posIdx, nextSection === -1 ? undefined : posIdx + 1 + nextSection)
    .join("\n");

  // No "cost basis", "mkt val", "market value", "notional"
  expect(positionsBlock.toLowerCase()).not.toContain("cost basis");
  expect(positionsBlock.toLowerCase()).not.toContain("mkt val");
  expect(positionsBlock.toLowerCase()).not.toContain("market value");
  expect(positionsBlock.toLowerCase()).not.toContain("notional");

  // No comma-grouped $ amounts (e.g., $1,500 / $50,000 / $87,500)
  expect(positionsBlock).not.toMatch(/\$\d{1,3}(,\d{3})+/);

  // No "$N.NN" with 2+ digit dollars except strike prices.
  // Strike prices appear as "$145" / "$590" — integer-only after $ is OK.
  // Cost basis / prices appear as "$175.00" / "$50000.00" — reject decimal-bearing.
  expect(positionsBlock).not.toMatch(/\$\d+\.\d{2}\b/);
}

describe("earnings prompt position-block — no $ amount leaks", () => {
  it("preview prompt for stock position carries ownership + % but no $ amounts", () => {
    const prompt = renderPreviewPrompt(makeStockPositionCtx());
    assertNoDollarLeak(prompt);
    // Sanity: ownership and return % ARE present.
    expect(prompt).toContain("500 sh AAPL");
    expect(prompt).toContain("vanguard taxable");
    expect(prompt).toMatch(/up ~\d+\.\d%/);
  });

  it("preview prompt for option position carries strike + expiry but no $ cost basis", () => {
    const prompt = renderPreviewPrompt(makeOptionPositionCtx());
    assertNoDollarLeak(prompt);
    // Strike + expiry + contract count ARE present.
    expect(prompt).toContain("3 long AAPL $145 call");
    expect(prompt).toContain("expiring 2026-06-19");
    expect(prompt).toContain("ibkr");
  });

  it("recap prompt for stock position respects the same boundary", () => {
    const ctx: EarningsRecapContext = {
      ...makeStockPositionCtx(),
      reactionSnapshotMarkdown: null,
      freshPressReleases: null,
      callNote: null,
    };
    const prompt = renderRecapPrompt(ctx);
    assertNoDollarLeak(prompt);
    expect(prompt).toContain("500 sh AAPL");
  });

  it("recap prompt §5 says 'percentage P&L impact' not '$ P&L impact'", () => {
    const ctx: EarningsRecapContext = {
      ...makeStockPositionCtx(),
      reactionSnapshotMarkdown: null,
      freshPressReleases: null,
      callNote: null,
    };
    const prompt = renderRecapPrompt(ctx);
    expect(prompt).toMatch(/\*\*percentage\*\* P&L impact/);
    expect(prompt).toContain(
      "do NOT multiply position counts by underlying prices",
    );
  });

  it("combined-exposure summary omits 'notional shares' language", () => {
    const prompt = renderPreviewPrompt(makeOptionPositionCtx());
    expect(prompt).toContain("3 long option contract(s)");
    expect(prompt.toLowerCase()).not.toContain("shares notional");
    expect(prompt.toLowerCase()).not.toContain("notional shares");
  });

  it("a short stock position surfaces in the preview context (not 'does not hold')", () => {
    const prompt = renderPreviewPrompt(makeShortStockPositionCtx());
    assertNoDollarLeak(prompt);
    // Ownership + direction disclosed via formatPositionPresence.
    expect(prompt).toContain("300 sh short AAPL");
    expect(prompt).toContain("ibkr");
    // Combined-exposure summary must bucket it as a short share count.
    expect(prompt).toContain("300 short shares");
    // Must NOT claim the user holds no position.
    expect(prompt).not.toContain("does NOT currently hold");
  });
});
