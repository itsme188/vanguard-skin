import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";
import type { IbkrTradingContext } from "@/lib/chat/ibkr-context";

const fakeContext = "## Portfolio Summary\n- Test data";
const today = "2026-03-17";

describe("buildSystemPrompt", () => {
  it("includes scope preamble for 'all'", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "all");
    expect(prompt).toContain("All Accounts");
    expect(prompt).toContain("filtered to this scope");
  });

  it("includes scope preamble for single account", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr");
    expect(prompt).toContain("IBKR");
    expect(prompt).toContain("filtered to this scope");
  });

  it("uses macro persona when scope is macro", () => {
    const prompt = buildSystemPrompt("", today, "macro");
    expect(prompt).toContain("Macro mode");
    expect(prompt).toContain("market and economic analyst");
    expect(prompt).not.toContain("trading desk analyst");
    expect(prompt).not.toContain("portfolio analyst for a personal investment dashboard");
  });

  it("includes first-response instruction", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "all");
    expect(prompt).toContain("first response");
    expect(prompt).toContain("scope");
  });

  it("includes portfolio context for non-macro scopes", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr");
    expect(prompt).toContain(fakeContext);
  });

  it("has no portfolio context section for macro", () => {
    const prompt = buildSystemPrompt("", today, "macro");
    expect(prompt).toContain("market");
  });

  it("includes ground truth rules section", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "all");
    expect(prompt).toContain("Ground Truth Rules");
    expect(prompt).toContain("NEVER claim a security is currently held");
  });

  it("ground truth rules not present in macro mode", () => {
    const prompt = buildSystemPrompt("", today, "macro");
    expect(prompt).not.toContain("Ground Truth Rules");
  });

  it("defaults to 'all' when scope is undefined", () => {
    const prompt = buildSystemPrompt(fakeContext, today, undefined as any);
    expect(prompt).toContain("All Accounts");
  });
});

// ─── Persona Differentiation ────────────────────────────────────

describe("account-specific personas", () => {
  it("IBKR scope uses trading desk persona", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr");
    expect(prompt).toContain("trading desk analyst");
    expect(prompt).toContain("Market Stance Dashboard");
    expect(prompt).toContain("Repeat-Name Trading");
    expect(prompt).toContain("Trend Following & Relative Strength");
    expect(prompt).toContain("Sector/Factor Positioning");
  });

  it("IBKR scope mentions key research sources", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr");
    expect(prompt).toContain("Alliant Capital");
    expect(prompt).toContain("Purple Drink");
  });

  it("IBKR scope does not contain Roth-specific content", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr");
    expect(prompt).not.toContain("tax-free compounding");
    expect(prompt).not.toContain("Roth IRA Optimization");
    expect(prompt).not.toContain("DRIP is powerful");
  });

  it("Roth scope uses long-term strategist persona", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "vanguard-roth-ira");
    expect(prompt).toContain("long-term portfolio strategist");
    expect(prompt).toContain("TAX-FREE");
    expect(prompt).toContain("Roth IRA Optimization");
    expect(prompt).toContain("Compounding & Income");
    expect(prompt).toContain("Thesis Tracking");
  });

  it("Roth scope does not contain IBKR-specific content", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "vanguard-roth-ira");
    expect(prompt).not.toContain("trading desk analyst");
    expect(prompt).not.toContain("Market Stance Dashboard");
    expect(prompt).not.toContain("repeat names");
  });

  it("Taxable scope uses tax-aware persona", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "vanguard-taxable");
    expect(prompt).toContain("tax-aware portfolio manager");
    expect(prompt).toContain("Tax-Loss Harvesting");
    expect(prompt).toContain("Holding Period Management");
    expect(prompt).toContain("Asset Location Optimization");
  });

  it("Taxable scope does not contain IBKR-specific content", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "vanguard-taxable");
    expect(prompt).not.toContain("trading desk analyst");
    expect(prompt).not.toContain("Repeat-Name Trading");
  });

  it("All scope uses cross-account persona", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "all");
    expect(prompt).toContain("Active trading account");
    expect(prompt).toContain("Long-term retirement");
    expect(prompt).toContain("Cross-Account Analysis");
  });

  it("all scopes include shared core sections", () => {
    const scopes = ["all", "ibkr", "vanguard-taxable", "vanguard-roth-ira"] as const;
    for (const scope of scopes) {
      const prompt = buildSystemPrompt(fakeContext, today, scope);
      expect(prompt).toContain("## Communication Style");
      expect(prompt).toContain("## Tools");
      expect(prompt).toContain("## Financial Conventions");
      expect(prompt).toContain("## Ground Truth Rules");
      expect(prompt).toContain("## Data Quality Awareness");
      expect(prompt).toContain("## Constraints");
      expect(prompt).toContain("## Portfolio Context");
    }
  });
});

// ─── IBKR Dynamic Dashboard ────────────────────────────────────

describe("IBKR dynamic dashboard", () => {
  const mockCtx: IbkrTradingContext = {
    cashPct: 42.5,
    estimatedCash: 85000,
    accountTotal: 200000,
    portfolioBeta: 1.15,
    bullishnessScore: 2,
    activePositionCount: 8,
    sectorTilts: [
      { sector: "Technology", weight: 45.2 },
      { sector: "Healthcare", weight: 22.1 },
    ],
    repeatNames: [
      { symbol: "AAPL", tradeCount: 7, lastTraded: "2026-04-14" },
      { symbol: "NVDA", tradeCount: 5, lastTraded: "2026-04-12" },
    ],
    avgHoldingDays: 12,
    recentTrades: [
      { date: "2026-04-15", symbol: "AAPL", type: "SELL", amount: 15000 },
      { date: "2026-04-14", symbol: "CRWD", type: "BUY", amount: 8000 },
    ],
    longShortSummary: "Long: 6 positions (Technology, Healthcare). Short: 2 positions (SOXS, CRWD put)",
  };

  it("includes dynamic dashboard when ibkrContext provided", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr", mockCtx);
    expect(prompt).toContain("Current IBKR Trading Dashboard");
    expect(prompt).toContain("42.5%");
    expect(prompt).toContain("$85,000");
    expect(prompt).toContain("Stance: 2/5");
    expect(prompt).toContain("cautious");
    expect(prompt).toContain("Beta");
    expect(prompt).toContain("1.15");
  });

  it("includes repeat names in dashboard", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr", mockCtx);
    expect(prompt).toContain("AAPL (7x");
    expect(prompt).toContain("NVDA (5x");
  });

  it("includes sector tilts in dashboard", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr", mockCtx);
    expect(prompt).toContain("Technology 45%");
    expect(prompt).toContain("Healthcare 22%");
  });

  it("includes recent trades in dashboard", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr", mockCtx);
    expect(prompt).toContain("SELL AAPL");
    expect(prompt).toContain("BUY CRWD");
  });

  it("includes long/short summary", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr", mockCtx);
    expect(prompt).toContain("Long: 6 positions");
    expect(prompt).toContain("Short: 2 positions");
  });

  it("works without ibkrContext (graceful fallback)", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr");
    expect(prompt).toContain("trading desk analyst");
    expect(prompt).not.toContain("Current IBKR Trading Dashboard");
    // Should still have the persona frameworks
    expect(prompt).toContain("Market Stance Dashboard");
  });

  it("ibkrContext is ignored for non-IBKR scopes", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "vanguard-roth-ira", mockCtx);
    expect(prompt).not.toContain("Current IBKR Trading Dashboard");
    expect(prompt).toContain("long-term portfolio strategist");
  });
});
