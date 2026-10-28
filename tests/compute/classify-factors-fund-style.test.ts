// tests/compute/classify-factors-fund-style.test.ts
//
// A fund's growth_vs_value comes from its stored classification style, not
// the AI's forced Growth/Value guess (2026-10-28: SPY was stored Value and VTI
// Growth, both Blend funds). Same vi.fn()-direct mock pattern as
// classify-factors.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "test-model" })),
}));

import { generateTextForFeature } from "@/lib/ai/generate";
import { classifyFactors, fundStyleGrowthValue } from "@/lib/compute/classify-factors";
import { FACTOR_SORT_RANK, getFactorColor } from "@/lib/factors";

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function held(db: Database.Database, symbol: string, type: string, style: string | null): number {
  const id = Number(
    db.prepare(`INSERT INTO securities (symbol, security_type, style) VALUES (?, ?, ?)`)
      .run(symbol, type, style).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
     VALUES (3, ?, '2026-06-01', 1, 'test-' || ?)`,
  ).run(id, id);
  return id;
}

function reply(symbol: string, growthValue: string) {
  return {
    symbol, sector: "Diversified", industry: "Index", interest_rate_sensitive: "Moderate",
    growth_vs_value: growthValue, cyclical: "Moderate", international_exposure: "Low",
    geopolitical_onshoring: "Low", tariff_exposure: "Moderate", ai_exposure: "Moderate",
    crypto_adjacent: "No", regulatory_risk: "Low",
  };
}

function stored(db: Database.Database, id: number): string | null {
  return (db.prepare(`SELECT growth_vs_value FROM security_factors WHERE security_id = ?`)
    .get(id) as { growth_vs_value: string | null }).growth_vs_value;
}

beforeEach(() => vi.clearAllMocks());

describe("fundStyleGrowthValue", () => {
  it("returns the style of an ETF or mutual fund, case-insensitively", () => {
    expect(fundStyleGrowthValue({ security_type: "ETF", style: "Blend" })).toBe("Blend");
    expect(fundStyleGrowthValue({ security_type: "etf", style: "growth" })).toBe("Growth");
    expect(fundStyleGrowthValue({ security_type: "Mutual Fund", style: " Value " })).toBe("Value");
  });

  it("returns null for a stock, a missing style, or an unknown style word", () => {
    expect(fundStyleGrowthValue({ security_type: "Stock", style: "Blend" })).toBeNull();
    expect(fundStyleGrowthValue({ security_type: "ETF", style: null })).toBeNull();
    expect(fundStyleGrowthValue({ security_type: "ETF", style: "null" })).toBeNull();
    expect(fundStyleGrowthValue({ security_type: null, style: "Blend" })).toBeNull();
  });
});

describe("classifyFactors — fund style answers growth_vs_value", () => {
  it("stores Blend for two Blend index funds whatever side the AI picked", async () => {
    const db = makeDb();
    const spy = held(db, "SPY", "ETF", "Blend");
    const vti = held(db, "VTI", "ETF", "Blend");
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify([reply("SPY", "Value"), reply("VTI", "Growth")]),
    });

    const r = await classifyFactors(db);

    expect(r.classified).toBe(2);
    expect(stored(db, spy)).toBe("Blend");
    expect(stored(db, vti)).toBe("Blend");
  });

  it("keeps the AI answer for a stock, and for a fund with no usable style", async () => {
    const db = makeDb();
    const stock = held(db, "SHOP", "Stock", "Blend");
    const fund = held(db, "XYZF", "ETF", null);
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify([reply("SHOP", "Growth"), reply("XYZF", "Value")]),
    });

    await classifyFactors(db);

    expect(stored(db, stock)).toBe("Growth");
    expect(stored(db, fund)).toBe("Value");
  });
});

describe("Blend in the shared factor maps", () => {
  it("has its own colour and sorts between Value and Growth", () => {
    expect(getFactorColor("Blend")).toBe("#64748B");
    expect(FACTOR_SORT_RANK.Blend).toBeGreaterThan(FACTOR_SORT_RANK.Value);
    expect(FACTOR_SORT_RANK.Blend).toBeLessThan(FACTOR_SORT_RANK.Growth);
  });
});
