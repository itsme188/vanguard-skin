/**
 * ETF sector-weight fetch (Analysis AI plumbing, 2026-11-15): a reply that
 * stopped at max_tokens fails that ETF cleanly and keeps its last good rows;
 * web_search text blocks are joined with "" (the house rule: a block boundary
 * can fall inside a token); the reply goes through the shared lenient JSON
 * parse with the control-character retry. The raw client is mocked at the
 * provider factory, as tests/ai/raw-search-failover.test.ts does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@/lib/ai/provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/provider")>()),
  getRawAnthropicClient: () => ({ messages: { create: createMock } }),
}));
vi.mock("@/lib/ai/models", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/models")>()),
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "test-model" })),
}));

import { runMigrations } from "@/lib/db/migrate";
import { fetchEtfSectorWeights, refreshEtfWeights } from "@/lib/etf/sector-weights";

function reply(blocks: string[], stop_reason = "end_turn") {
  return { stop_reason, content: blocks.map((text) => ({ type: "text", text })) };
}

beforeEach(() => {
  createMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("fetchEtfSectorWeights", () => {
  it("joins text blocks with no separator (a boundary inside a number stays one number)", async () => {
    createMock.mockResolvedValueOnce(
      reply(['[{"sector":"Technology","weight_pct":5', '0},{"sector":"Financials","weight_pct":50}]']),
    );
    const rows = await fetchEtfSectorWeights("ZZE");
    expect(rows).toEqual([
      { sector: "Technology", weight_pct: 50 },
      { sector: "Financials", weight_pct: 50 },
    ]);
  });

  it("parses through the lenient path: prose around the array and a raw control character in a string", async () => {
    createMock.mockResolvedValueOnce(
      reply(['Here is the breakdown:\n[{"sector":"Tech\u0001nology","weight_pct":100}]\nDone.']),
    );
    const rows = await fetchEtfSectorWeights("ZZE");
    expect(rows).toHaveLength(1);
    expect(rows[0].weight_pct).toBe(100);
  });

  it("a reply that stopped at max_tokens fails cleanly, even when its text parses", async () => {
    createMock.mockResolvedValueOnce(
      reply(['[{"sector":"Technology","weight_pct":100}]'], "max_tokens"),
    );
    await expect(fetchEtfSectorWeights("ZZE")).rejects.toThrow(/cut off at the output cap/);
  });
});

describe("refreshEtfWeights and a cut-off reply", () => {
  it("keeps the ETF's last good rows", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare(
      "INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES ('ZZE', 'Energy', 100, '2026-08-01', 'claude_web_search')",
    ).run();
    createMock.mockResolvedValueOnce(reply(['[{"sector":"Technology","weight_pct":100}]'], "max_tokens"));
    await refreshEtfWeights(db, ["ZZE"]);
    expect(db.prepare("SELECT sector, weight_pct FROM etf_sector_weights WHERE etf_symbol = 'ZZE'").all()).toEqual([
      { sector: "Energy", weight_pct: 100 },
    ]);
  });
});
