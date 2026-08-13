// tests/compute/classify-securities-fallback.test.ts
//
// NOTE: Uses the vi.fn()-direct mock pattern (same as synthesize.test.ts).
// The wrapper pattern `vi.mock("@/lib/ai/generate", () => ({ generateTextForFeature: (...a) => outerMock(...a) }))`
// has a Vitest 4 quirk: `mockRejectedValue` on the inner vi.fn() triggers a spurious
// "unhandled rejection" failure even when the try/catch in the implementation properly
// catches the error. Using vi.fn() directly avoids this.
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {
    constructor(feature: string, modelId: string) {
      super(`AI refused request for feature "${feature}" (model ${modelId})`);
      this.name = "AIRefusalError";
    }
  },
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-sonnet-4-6-20250219" })),
}));

import { generateTextForFeature } from "@/lib/ai/generate";
import { classifyUnresolvedWithClaude } from "@/lib/compute/classify-securities";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE securities (
    id INTEGER PRIMARY KEY, symbol TEXT, name TEXT, security_type TEXT,
    asset_class TEXT, fund_category TEXT, geography TEXT,
    market_cap_category TEXT, style TEXT, classification_source TEXT
  );`);
  db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('XLE','Energy Select SPDR','ETF')").run();
  return db;
}
beforeEach(() => vi.clearAllMocks());

describe("classifyUnresolvedWithClaude", () => {
  it("fills the four classification fields from Claude output", async () => {
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({ text: JSON.stringify([
      { symbol: "XLE", fund_category: "Sector Equity", geography: "US", market_cap_category: "Large", style: "Value" },
    ]) });
    const db = makeDb();
    const res = await classifyUnresolvedWithClaude(db, [{ id: 1, symbol: "XLE", security_type: "ETF" }]);
    expect(res.classified).toBe(1);
    const row = db.prepare("SELECT * FROM securities WHERE symbol='XLE'").get() as any;
    expect(row.fund_category).toBe("Sector Equity");
    expect(row.classification_source).toBe("auto_ai");
  });
  it("normalizes fragmented fund_category vocabulary at write time", async () => {
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({ text: JSON.stringify([
      { symbol: "XLE", fund_category: "Technology", geography: "US", market_cap_category: "Large", style: "Growth" },
    ]) });
    const db = makeDb();
    const res = await classifyUnresolvedWithClaude(db, [{ id: 1, symbol: "XLE", security_type: "ETF" }]);
    expect(res.classified).toBe(1);
    const row = db.prepare("SELECT * FROM securities WHERE symbol='XLE'").get() as any;
    expect(row.fund_category).toBe("US Sector Equity (Technology)");
  });

  // Regression (2026-08-12, qa:analysis-classification--auto-classify-writes-
  // noncanonical-fund-category-duplicates-regression-1): auto_ai wrote
  // market_cap_category completely unnormalized ("Large"/"Mid"/"Small" instead
  // of "Large Cap"/"Mid Cap"/"Small Cap") and fund_category was already-wrapped
  // in the "US Sector Equity (X)" scheme but with a synonym sector name inside
  // ("Information Technology" instead of "Technology", "Financials" instead of
  // "Financial") — each Auto-Classify click widened the Allocation donut split.
  it("normalizes market_cap_category and wrapped sector-parenthetical fund_category at write time", async () => {
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({ text: JSON.stringify([
      {
        symbol: "XLE",
        fund_category: "US Sector Equity (Information Technology)",
        geography: "US",
        market_cap_category: "Large",
        style: "Growth",
      },
    ]) });
    const db = makeDb();
    const res = await classifyUnresolvedWithClaude(db, [{ id: 1, symbol: "XLE", security_type: "ETF" }]);
    expect(res.classified).toBe(1);
    const row = db.prepare("SELECT * FROM securities WHERE symbol='XLE'").get() as any;
    expect(row.fund_category).toBe("US Sector Equity (Technology)");
    expect(row.market_cap_category).toBe("Large Cap");
  });

  it("normalizes the 'Financials' sector-parenthetical synonym to the canonical singular 'Financial'", async () => {
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({ text: JSON.stringify([
      {
        symbol: "XLE",
        fund_category: "US Sector Equity (Financials)",
        geography: "US",
        market_cap_category: "Mid",
        style: "Value",
      },
    ]) });
    const db = makeDb();
    const res = await classifyUnresolvedWithClaude(db, [{ id: 1, symbol: "XLE", security_type: "ETF" }]);
    expect(res.classified).toBe(1);
    const row = db.prepare("SELECT * FROM securities WHERE symbol='XLE'").get() as any;
    expect(row.fund_category).toBe("US Sector Equity (Financial)");
    expect(row.market_cap_category).toBe("Mid Cap");
  });
  it("returns an error and classifies nothing when Claude fails", async () => {
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("402 credits"));
    const db = makeDb();
    const res = await classifyUnresolvedWithClaude(db, [{ id: 1, symbol: "XLE", security_type: "ETF" }]);
    expect(res.classified).toBe(0);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  // Regression (2026-08-13, qa:analysis-classification--auto-classify-swallows-ai-json-error):
  // the model intermittently emits a raw, unescaped control character (e.g. a
  // literal newline) inside a JSON string value. JSON.parse rejects this
  // ("Bad control character in string literal in JSON") even though
  // extractJsonArray already isolated a well-formed-looking `[...]` slice.
  // Same defense as verify-sector-tags.ts / verify-earnings-dates.ts: retry
  // with C0 control chars collapsed to spaces.
  it("recovers from a raw control character embedded inside a JSON string value", async () => {
    const rawNewline = String.fromCharCode(10);
    const malformedText = [
      "[{",
      '"symbol":"XLE",',
      `"fund_category":"US Sector${rawNewline}Equity (Energy)",`,
      '"geography":"US",',
      '"market_cap_category":"Large",',
      '"style":"Value"',
      "}]",
    ].join("");
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({ text: malformedText });
    const db = makeDb();
    const res = await classifyUnresolvedWithClaude(db, [{ id: 1, symbol: "XLE", security_type: "ETF" }]);
    expect(res.errors).toEqual([]);
    expect(res.classified).toBe(1);
    const row = db.prepare("SELECT * FROM securities WHERE symbol='XLE'").get() as any;
    // The raw newline collapses to a space, same as the sibling call sites.
    expect(row.fund_category).toBe("US Sector Equity (Energy)");
  });

  // A genuinely truncated response (e.g. a batch cut off by maxOutputTokens
  // mid-object) is NOT recoverable by the control-char retry — there's no
  // closing bracket/quote to reconstruct. This must surface as a clean
  // per-batch domain error rather than throwing out of the whole sweep or
  // silently dropping the batch.
  it("records a clean domain error (not a crash) when the response is truncated mid-object", async () => {
    const truncatedText = '[{"symbol":"XLE","fund_category":"US Sector Equity (Ener';
    (generateTextForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({ text: truncatedText });
    const db = makeDb();
    const res = await classifyUnresolvedWithClaude(db, [{ id: 1, symbol: "XLE", security_type: "ETF" }]);
    expect(res.classified).toBe(0);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toMatch(/Unterminated string|Bad control character|Unexpected end/i);
    const row = db.prepare("SELECT * FROM securities WHERE symbol='XLE'").get() as any;
    expect(row.classification_source).toBeNull();
  });
});
