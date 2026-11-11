/**
 * Size guard (Portfolio Assistant plan, Task 8 follow-up): on a large
 * synthetic book (tests/chat/tools-size-book.ts), no tool's COMPACT
 * model-facing output exceeds 30,000 characters at its worst realistic call,
 * except the full transcript, which stays whole on purpose. The failure names
 * the tool. Network-backed engines are mocked at realistic maximum sizes.
 *
 * Set SIZE_REPORT=<path> to write the full and compact sizes of all 33 tools
 * as a tab-separated table.
 */
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";

vi.mock("@/lib/apis/fred", () => ({
  getSeriesData: vi.fn(async (_id: string, o: { limit: number }) =>
    Array.from({ length: o.limit }, (_, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, value: 4 + i / 1000 })),
  ),
  searchSeries: vi.fn(async () => []),
  getLatestValue: vi.fn(),
  FRED_SERIES: {},
}));
vi.mock("@/lib/apis/edgar", () => {
  const period = (i: number) => ({
    period: `2025-Q${(i % 4) + 1}`, form: "10-Q", filed: "2025-11-01", revenue: 1234567, netIncome: 123456, eps: 1.23,
    totalAssets: 9876543, totalLiabilities: 5432109, stockholdersEquity: 4444434, sharesOutstanding: 1000000, operatingIncome: 222222,
  });
  return {
    getCompanyFinancials: vi.fn(async () => ({ ticker: "ZB1", name: "ZB1 Industries", periods: Array.from({ length: 8 }, (_, i) => period(i)) })),
    getCompanyInfo: vi.fn(),
    getRecentFilings: vi.fn(async () => Array.from({ length: 5 }, (_, i) => ({ form: "10-Q", filed: `2025-0${i + 1}-01`, url: `https://example.com/f/${i}` }))),
    getInsiderTransactions: vi.fn(async (_t: string, o: { limit: number }) =>
      Array.from({ length: o.limit * 3 }, (_, i) => ({
        name: `Insider ${i}`, title: "Director", relationship: "Director", type: "sell", shares: 1000 + i, price: 100.5,
        transactionDate: "2026-10-01", filingDate: "2026-10-03", sharesOwnedAfter: 50000 + i,
      })),
    ),
  };
});
vi.mock("@/lib/apis/analyst-estimates", () => ({ syncAnalystCoverage: vi.fn(async () => ({ errors: [] })) }));
vi.mock("@/lib/apis/press-releases", () => ({ fetchAndCachePressReleases: vi.fn(async () => ({ upserted: 0 })) }));
vi.mock("@/lib/apis/filing-extract", () => ({
  getFilingSection: vi.fn(async () => ({
    summary: "x".repeat(3000), key_points: Array.from({ length: 10 }, (_, i) => `point ${i} `.repeat(15)), url: "https://example.com/10k",
  })),
}));
vi.mock("@/lib/transcripts/fetch", () => ({
  getTranscriptForChat: vi.fn(async () => ({ source: "edgar_8k", summary: "s", has_full_transcript: true, content: "t".repeat(60000) })),
}));
vi.mock("@/lib/queries/market-snapshot", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/market-snapshot")>()),
  fetchYahooQuotes: vi.fn(async () => null),
}));

import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS, compactToolOutput } from "@/lib/chat/tools";
import { seedSizeBook, WORST_CASE_CALLS, SIZE_GUARD_EXEMPT } from "./tools-size-book";

const LIMIT = 30000;

describe("tool output size on a large book", () => {
  it("covers every tool", () => {
    expect(WORST_CASE_CALLS.map(([t]) => t).sort()).toEqual(CHAT_TOOLS.map((t) => t.name).sort());
  });

  it(`no compact output exceeds ${LIMIT} characters (transcript excepted)`, async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedSizeBook(db);
    const rows: string[] = ["tool\tfull_chars\tcompact_chars"];
    const over: string[] = [];
    for (const [tool, input] of WORST_CASE_CALLS) {
      const full = await executeTool(db, tool, input);
      const compact = compactToolOutput(tool, full);
      const f = JSON.stringify(full).length;
      const c = JSON.stringify(compact).length;
      const err = (full as { error?: string }).error;
      rows.push(`${tool}\t${f}\t${c}${err ? `\tERROR: ${err.slice(0, 80)}` : ""}`);
      if (c > LIMIT && !SIZE_GUARD_EXEMPT.has(tool)) over.push(`${tool}: ${c}`);
    }
    if (process.env.SIZE_REPORT) writeFileSync(process.env.SIZE_REPORT, rows.join("\n") + "\n");
    expect(over).toEqual([]);
  }, 120000);
});
