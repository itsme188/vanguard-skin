// tests/compute/classify-securities-fallback.test.ts
//
// NOTE: Uses the vi.fn()-direct mock pattern (same as synthesize.test.ts).
// The wrapper pattern `vi.mock("ai", () => ({ generateText: (...a) => outerMock(...a) }))`
// has a Vitest 4 quirk: `mockRejectedValue` on the inner vi.fn() triggers a spurious
// "unhandled rejection" failure even when the try/catch in the implementation properly
// catches the error. Using vi.fn() directly avoids this.
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/ai/provider", () => ({ getModelForFeature: vi.fn(() => "mock-model") }));
vi.mock("ai", () => ({ generateText: vi.fn() }));

import { generateText } from "ai";
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
    (generateText as ReturnType<typeof vi.fn>).mockResolvedValue({ text: JSON.stringify([
      { symbol: "XLE", fund_category: "Sector Equity", geography: "US", market_cap_category: "Large", style: "Value" },
    ]) });
    const db = makeDb();
    const res = await classifyUnresolvedWithClaude(db, [{ id: 1, symbol: "XLE", security_type: "ETF" }]);
    expect(res.classified).toBe(1);
    const row = db.prepare("SELECT * FROM securities WHERE symbol='XLE'").get() as any;
    expect(row.fund_category).toBe("Sector Equity");
    expect(row.classification_source).toBe("auto_ai");
  });
  it("returns an error and classifies nothing when Claude fails", async () => {
    (generateText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("402 credits"));
    const db = makeDb();
    const res = await classifyUnresolvedWithClaude(db, [{ id: 1, symbol: "XLE", security_type: "ETF" }]);
    expect(res.classified).toBe(0);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
