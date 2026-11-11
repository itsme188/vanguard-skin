import { describe, it, expect } from "vitest";
import { buildSystemPromptBlocks, buildSystemPrompt } from "@/lib/chat/system-prompt";
import type { IbkrTradingContext } from "@/lib/chat/ibkr-context";
import type { ChatScope } from "@/lib/types";

// Portfolio Assistant plan, Contract D: the static system block carries the
// cache mark, so it must be byte-identical for a scope whatever the date, the
// portfolio, the IBKR dashboard or the page. Anything that changes per request
// lives in the volatile block, which follows the static one.

const SCOPES: ChatScope[] = ["all", "ibkr", "vanguard-taxable", "vanguard-roth-ira", "macro"];

function ctx(overrides: Partial<IbkrTradingContext> = {}): IbkrTradingContext {
  return {
    cashPct: 12.5,
    estimatedCash: 250,
    accountTotal: 2000,
    portfolioBeta: 1.1,
    bullishnessScore: 5,
    activePositionCount: 3,
    sectorTilts: [{ sector: "Technology", weight: 40 }],
    repeatNames: [{ symbol: "AAA", tradeCount: 4, lastTraded: "2026-11-02" }],
    avgHoldingDays: 9,
    recentTrades: [{ date: "2026-11-03", symbol: "AAA", type: "BUY", amount: 100 }],
    longShortSummary: "Long: 3 positions",
    cashAsOf: "2026-11-10",
    cashSource: "daily_valuation",
    cashCarried: false,
    cashTimingResidual: false,
    cashPriceDateMismatch: false,
    accountTotalAsOf: "2026-11-10",
    stanceWithheld: false,
    ...overrides,
  };
}

describe("buildSystemPromptBlocks (Contract D)", () => {
  it("static block is byte-identical across dates, portfolio contexts, dashboards and pages, per scope", () => {
    for (const scope of SCOPES) {
      const a = buildSystemPromptBlocks({
        scope,
        currentDate: "2026-11-10",
        portfolioContext: "## Portfolio Summary\n- AAA 10 shares",
        ibkrContext: ctx(),
        pageNote: "User is on the Today page.",
      });
      const b = buildSystemPromptBlocks({
        scope,
        currentDate: "2027-02-01",
        portfolioContext: "## Portfolio Summary\n- BBB 5 shares",
        ibkrContext: ctx({ estimatedCash: -40, cashPct: -2, activePositionCount: 9 }),
        pageNote: "User is viewing the Security Detail page for BBB.",
      });
      const c = buildSystemPromptBlocks({
        scope,
        currentDate: "2026-12-31",
        portfolioContext: "",
        ibkrNote: "The IBKR scope covers 2 accounts; the trading dashboard covers one account and is left out.",
      });
      expect(a.staticBlock, scope).toBe(b.staticBlock);
      expect(a.staticBlock, scope).toBe(c.staticBlock);
      for (const dynamic of ["2026-11-10", "2027-02-01", "AAA", "BBB", "Today page", "Current IBKR Trading Dashboard"]) {
        expect(a.staticBlock.includes(dynamic), `${scope}: ${dynamic}`).toBe(false);
        expect(b.staticBlock.includes(dynamic), `${scope}: ${dynamic}`).toBe(false);
      }
      expect(a.staticBlock).not.toContain("Today's date is");
    }
  });

  it("static blocks differ between scopes", () => {
    const blocks = SCOPES.map(
      (scope) => buildSystemPromptBlocks({ scope, currentDate: "2026-11-10", portfolioContext: "" }).staticBlock,
    );
    expect(new Set(blocks).size).toBe(SCOPES.length);
  });

  it("volatile block order is date, dashboard, portfolio, page", () => {
    const { volatileBlock } = buildSystemPromptBlocks({
      scope: "ibkr",
      currentDate: "2026-11-10",
      portfolioContext: "## Portfolio Summary\n- marker-portfolio",
      ibkrContext: ctx(),
      pageNote: "marker-page",
    });
    const date = volatileBlock.indexOf("## Today");
    const dateLine = volatileBlock.indexOf("Today's date is 2026-11-10 (Eastern).");
    const dash = volatileBlock.indexOf("## Current IBKR Trading Dashboard");
    const portfolio = volatileBlock.indexOf("## Portfolio Context");
    const page = volatileBlock.indexOf("[Current Page]");
    expect(date).toBe(0);
    expect(dateLine).toBeGreaterThan(date);
    expect(dash).toBeGreaterThan(dateLine);
    expect(portfolio).toBeGreaterThan(dash);
    expect(volatileBlock.indexOf("marker-portfolio")).toBeGreaterThan(portfolio);
    expect(page).toBeGreaterThan(portfolio);
    expect(volatileBlock.indexOf("marker-page")).toBeGreaterThan(page);
  });

  it("the IBKR note replaces the dashboard when it is left out", () => {
    const note = "The IBKR scope covers 2 accounts; the trading dashboard covers one account and is left out.";
    const { volatileBlock } = buildSystemPromptBlocks({
      scope: "ibkr",
      currentDate: "2026-11-10",
      portfolioContext: "x",
      ibkrNote: note,
    });
    expect(volatileBlock).toContain(note);
    expect(volatileBlock).not.toContain("Current IBKR Trading Dashboard\n\n- **Cash**");
    expect(volatileBlock.indexOf(note)).toBeLessThan(volatileBlock.indexOf("## Portfolio Context"));
  });

  it("non-IBKR scopes carry no dashboard and no note", () => {
    const { volatileBlock } = buildSystemPromptBlocks({
      scope: "vanguard-taxable",
      currentDate: "2026-11-10",
      portfolioContext: "x",
      ibkrContext: ctx(),
      ibkrNote: "note-marker",
    });
    expect(volatileBlock).not.toContain("Current IBKR Trading Dashboard");
    expect(volatileBlock).not.toContain("note-marker");
  });

  it("macro has a date and a page note but no portfolio context", () => {
    const { volatileBlock } = buildSystemPromptBlocks({
      scope: "macro",
      currentDate: "2026-11-10",
      portfolioContext: "should-not-appear",
      pageNote: "page-marker",
    });
    expect(volatileBlock).toContain("Today's date is 2026-11-10 (Eastern).");
    expect(volatileBlock).not.toContain("## Portfolio Context");
    expect(volatileBlock).not.toContain("should-not-appear");
    expect(volatileBlock).toContain("[Current Page]\npage-marker");
  });

  it("no page note means no [Current Page] section", () => {
    const { volatileBlock } = buildSystemPromptBlocks({ scope: "all", currentDate: "2026-11-10", portfolioContext: "x" });
    expect(volatileBlock).not.toContain("[Current Page]");
  });

  it("buildSystemPrompt is the static block, a blank line, then the volatile block", () => {
    for (const scope of SCOPES) {
      const blocks = buildSystemPromptBlocks({ scope, currentDate: "2026-11-10", portfolioContext: "pc" });
      expect(buildSystemPrompt("pc", "2026-11-10", scope)).toBe(`${blocks.staticBlock}\n\n${blocks.volatileBlock}`);
    }
  });
});
