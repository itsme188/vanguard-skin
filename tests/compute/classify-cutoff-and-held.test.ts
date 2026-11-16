/**
 * Classifier cut-off checks and the securities fallback's input (Analysis AI
 * plumbing, 2026-11-15).
 *
 * - A reply cut off at the output cap (finishReason "length") is a named
 *   truncation, not a parse failure. A multi-item batch still splits (a
 *   smaller batch fits); a one-item batch is never re-sent at the same cap.
 * - The securities fallback sends each security's name, and asks only about
 *   securities held now (latest holdings row non-zero) or the underlying of a
 *   held, live option. A tombstone (quantity 0) is not held.
 *
 * Synthetic symbols (ZZ*) and round quantities only. Migrated schema.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn(),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "test-model" })),
}));

import { runMigrations } from "@/lib/db/migrate";
import { generateTextForFeature } from "@/lib/ai/generate";
import {
  runClassifyBatches,
  TruncatedBatchReplyError,
  UnusableBatchReplyError,
} from "@/lib/compute/classify-batch";
import { classifyUnresolvedWithClaude, classifySecurities } from "@/lib/compute/classify-securities";
import { classifyFactors } from "@/lib/compute/classify-factors";
import { classifyOptionSectors, OPTION_SECTOR_AI_MISSES_KEY } from "@/lib/securities/classify-option-sectors";

const mocked = generateTextForFeature as unknown as ReturnType<typeof vi.fn>;
let db: Database.Database;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocked.mockReset();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function sec(symbol: string, name: string, type = "ETF", extra: { underlying?: string; expiry?: string } = {}): number {
  return Number(
    db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, underlying_symbol, expiration_date, multiplier) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(symbol, name, type, extra.underlying ?? null, extra.expiry ?? null, extra.underlying ? 100 : 1).lastInsertRowid,
  );
}

function hold(id: number, quantity: number, date = "2026-11-02") {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (1, ?, ?, ?, ?)",
  ).run(id, quantity, date, `test:${id}:${date}`);
}

function secReply(symbols: string[]) {
  return JSON.stringify(
    symbols.map((symbol) => ({ symbol, fund_category: "US Large Cap Equity", geography: "US", market_cap_category: "Large", style: "Blend" })),
  );
}

describe("runClassifyBatches and a truncated reply", () => {
  it("splits a truncated multi-item batch into halves and logs it as a truncation", async () => {
    const calls: string[][] = [];
    const errors: string[] = [];
    const n = await runClassifyBatches(
      ["A", "B", "C", "D"],
      25,
      async (batch) => {
        calls.push(batch);
        if (calls.length === 1) throw new TruncatedBatchReplyError("reply cut off at the output cap");
        return batch.length;
      },
      errors,
    );
    expect(n).toBe(4);
    expect(errors).toEqual([]);
    expect(calls).toEqual([["A", "B", "C", "D"], ["A", "B"], ["C", "D"]]);
    expect(warnSpy.mock.calls.flat().join(" ")).toMatch(/truncat|cut off/i);
  });

  it("never re-sends a truncated one-item batch at the same cap", async () => {
    const errors: string[] = [];
    let calls = 0;
    await runClassifyBatches(
      ["A"],
      25,
      async () => {
        calls++;
        throw new TruncatedBatchReplyError("reply cut off at the output cap");
      },
      errors,
    );
    expect(calls).toBe(1);
    expect(errors).toEqual(["Batch 1: reply cut off at the output cap"]);
  });

  it("is still an unusable reply (the split path)", () => {
    expect(new TruncatedBatchReplyError("x")).toBeInstanceOf(UnusableBatchReplyError);
  });
});

describe("securities fallback", () => {
  it("a cut-off reply is a named truncation and splits, even when the cut-off text parses", async () => {
    const a = sec("ZZA", "Zed Alpha Fund");
    const b = sec("ZZB", "Zed Beta Fund");
    hold(a, 10);
    hold(b, 10);
    mocked
      // Parses (a complete first object), but the reply hit the cap.
      .mockResolvedValueOnce({ text: secReply(["ZZA"]), finishReason: "length" })
      .mockResolvedValueOnce({ text: secReply(["ZZA"]), finishReason: "stop" })
      .mockResolvedValueOnce({ text: secReply(["ZZB"]), finishReason: "stop" });
    const res = await classifyUnresolvedWithClaude(db, [
      { id: a, symbol: "ZZA", security_type: "ETF" },
      { id: b, symbol: "ZZB", security_type: "ETF" },
    ]);
    expect(mocked).toHaveBeenCalledTimes(3);
    expect(res.classified).toBe(2);
    expect(res.errors).toEqual([]);
    expect(warnSpy.mock.calls.flat().join(" ")).toMatch(/truncat|cut off/i);
  });

  it("sends each security's name in the prompt line", async () => {
    const a = sec("ZZA", "Zed Alpha Fund");
    hold(a, 10);
    mocked.mockResolvedValueOnce({ text: secReply(["ZZA"]), finishReason: "stop" });
    await classifyUnresolvedWithClaude(db, [{ id: a, symbol: "ZZA", security_type: "ETF" }]);
    const prompt = String((mocked.mock.calls[0][1] as { prompt: string }).prompt);
    expect(prompt).toContain("- ZZA: Zed Alpha Fund (type: ETF)");
  });

  it("asks only about securities held now; a tombstone or a never-held name is left out", async () => {
    const held = sec("ZZA", "Zed Alpha Fund");
    const sold = sec("ZZS", "Zed Sold Fund");
    const never = sec("ZZN", "Zed Never Fund");
    hold(held, 10);
    hold(sold, 10, "2026-10-01");
    hold(sold, 0, "2026-11-02"); // tombstone: latest row is zero
    mocked.mockResolvedValueOnce({ text: secReply(["ZZA"]), finishReason: "stop" });
    const res = await classifyUnresolvedWithClaude(db, [
      { id: held, symbol: "ZZA", security_type: "ETF" },
      { id: sold, symbol: "ZZS", security_type: "ETF" },
      { id: never, symbol: "ZZN", security_type: "ETF" },
    ]);
    expect(mocked).toHaveBeenCalledTimes(1);
    const prompt = String((mocked.mock.calls[0][1] as { prompt: string }).prompt);
    expect(prompt).toContain("ZZA");
    expect(prompt).not.toContain("ZZS");
    expect(prompt).not.toContain("ZZN");
    expect(res.classified).toBe(1);
  });

  it("keeps the underlying of a held, live option (options inherit its style)", async () => {
    const und = sec("ZZU", "Zed Underlying Inc", "Stock");
    const opt = sec("ZZU 990115C00090000", "ZZU CALL", "Option", { underlying: "ZZU", expiry: "2099-01-15" });
    hold(opt, 1);
    mocked.mockResolvedValueOnce({ text: secReply(["ZZU"]), finishReason: "stop" });
    await classifyUnresolvedWithClaude(db, [{ id: und, symbol: "ZZU", security_type: "Stock" }]);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("makes no AI call when nothing unresolved is held", async () => {
    const never = sec("ZZN", "Zed Never Fund");
    const res = await classifyUnresolvedWithClaude(db, [{ id: never, symbol: "ZZN", security_type: "ETF" }]);
    expect(mocked).not.toHaveBeenCalled();
    expect(res).toEqual({ classified: 0, errors: [] });
  });

  it("classifySecurities' unresolved list carries the name", () => {
    sec("ZZQ", "Zed Quirky Thing", "Stock");
    const r = classifySecurities(db);
    expect(r.unresolved.find((u) => u.symbol === "ZZQ")?.name).toBe("Zed Quirky Thing");
  });
});

describe("factor classifier", () => {
  it("a cut-off reply splits as a truncation, not a parse failure", async () => {
    const a = sec("ZZA", "Zed Alpha Inc", "Stock");
    const b = sec("ZZB", "Zed Beta Inc", "Stock");
    hold(a, 10);
    hold(b, 10);
    const factors = (s: string) => ({
      symbol: s,
      interest_rate_sensitive: "Low",
      growth_vs_value: "Growth",
      cyclical: "Low",
      international_exposure: "Low",
      geopolitical_onshoring: "Low",
      tariff_exposure: "Low",
      ai_exposure: "High",
      crypto_adjacent: "No",
      regulatory_risk: "Low",
    });
    mocked
      .mockResolvedValueOnce({ text: JSON.stringify([factors("ZZA")]), finishReason: "length" })
      .mockResolvedValueOnce({ text: JSON.stringify([factors("ZZA")]), finishReason: "stop" })
      .mockResolvedValueOnce({ text: JSON.stringify([factors("ZZB")]), finishReason: "stop" });
    const res = await classifyFactors(db);
    expect(mocked).toHaveBeenCalledTimes(3);
    expect(res.classified).toBe(2);
    expect(warnSpy.mock.calls.flat().join(" ")).toMatch(/truncat|cut off/i);
  });
});

describe("option sector classifier", () => {
  it("a cut-off reply is a named error: nothing is written and no miss is remembered", async () => {
    const opt = sec("ZZX 990115C00090000", "ZZX CALL", "Option", { underlying: "ZZX", expiry: "2099-01-15" });
    db.prepare("UPDATE securities SET fund_category = 'Options' WHERE id = ?").run(opt);
    hold(opt, 1);
    mocked.mockResolvedValueOnce({ text: JSON.stringify([{ symbol: "ZZX", sector: "Technology" }]), finishReason: "length" });
    const res = await classifyOptionSectors(db, "2026-11-02");
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/cut off at the output cap/);
    expect((db.prepare("SELECT sector FROM securities WHERE id = ?").get(opt) as { sector: string | null }).sector).toBeNull();
    const misses = db.prepare("SELECT value FROM settings WHERE key = ?").get(OPTION_SECTOR_AI_MISSES_KEY) as
      | { value: string }
      | undefined;
    expect(misses?.value ?? "").not.toContain("ZZX");
  });
});
