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
import { executeTool, CHAT_TOOLS, compactToolOutput, compactRoundingFor } from "@/lib/chat/tools";
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

/** Rebuild the full shape from a compact result (columns back to records). */
function expand(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(expand);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o._cols) && Array.isArray(o._rows)) {
    const same = (o._same_in_rows_shown as Record<string, unknown>) ?? {};
    return (o._rows as unknown[][]).map((r) => {
      const rec: Record<string, unknown> = {};
      (o._cols as string[]).forEach((c, i) => (rec[c] = expand(r[i])));
      for (const [k, x] of Object.entries(same)) rec[k] = expand(x);
      return rec;
    });
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) if (k !== "_format" && k !== "_rounded") out[k] = expand(x);
  return out;
}

/**
 * Every numeric leaf of the full result against the compact one. Mapped
 * fields may move by at most half a unit of their declared precision;
 * unmapped fields must be identical; a non-zero value keeps its sign and never
 * becomes 0; arrays are compared position by position, so a ranked list must
 * keep its order. Returns "tool.path: problem" lines.
 */
function numericDrift(tool: string, full: unknown, compact: unknown, path = "", key = ""): string[] {
  if (typeof full === "number") {
    if (typeof compact !== "number") return [`${tool}${path}: number became ${JSON.stringify(compact)}`];
    const rule = compactRoundingFor(tool, key);
    const tol = rule ? 0.5 * 10 ** -rule.dp + 1e-9 : 0;
    const out: string[] = [];
    if (Math.abs(compact - full) > tol) out.push(`${tool}${path}: ${full} -> ${compact}`);
    if (full !== 0 && (compact === 0 || Math.sign(compact) !== Math.sign(full)) && rule === null) {
      out.push(`${tool}${path}: sign or zero lost (${full} -> ${compact})`);
    }
    return out;
  }
  if (Array.isArray(full)) {
    if (!Array.isArray(compact) || compact.length !== full.length) {
      return full.some((x) => typeof x === "number" || (x && typeof x === "object"))
        ? [`${tool}${path}: list of ${full.length} became ${Array.isArray(compact) ? compact.length : typeof compact}`]
        : [];
    }
    return full.flatMap((x, i) => numericDrift(tool, x, compact[i], `${path}[${i}]`, key));
  }
  if (full && typeof full === "object") {
    const c = (compact ?? {}) as Record<string, unknown>;
    return Object.entries(full as Record<string, unknown>).flatMap(([k, x]) =>
      x === null || x === undefined || x === "" ? [] : numericDrift(tool, x, c[k], `${path}.${k}`, k),
    );
  }
  return [];
}

describe("compact output keeps every number (review RF-1/RF-2 guard)", () => {
  it("every numeric leaf of all 33 tools: within its declared precision, exact if unmapped, sign and order kept", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedSizeBook(db);
    const problems: string[] = [];
    for (const [tool, input] of WORST_CASE_CALLS) {
      const full = await executeTool(db, tool, input);
      problems.push(...numericDrift(tool, full, expand(compactToolOutput(tool, full))));
    }
    expect(problems.slice(0, 20)).toEqual([]);
  }, 120000);
});

describe("every '…[cut' pointer the compaction emits works (review RF-3)", () => {
  it("following each pointer returns the full, uncut text", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedSizeBook(db);
    const MARK = /^([\s\S]*)…\[cut: (\d+) more chars; call (query_\w+) with (\{.*\}) to read it in full\]$/;
    const strings = (v: unknown, out: string[] = []): string[] => {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
      else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
      return out;
    };
    const followedTools = new Set<string>();
    const failures: string[] = [];
    for (const [tool, input] of WORST_CASE_CALLS) {
      const full = await executeTool(db, tool, input);
      const fullStrings = strings(full);
      const cuts = strings(compactToolOutput(tool, full)).filter((x) => MARK.test(x)).slice(0, 3);
      for (const cut of cuts) {
        const [, prefix, more, target, argsJson] = cut.match(MARK)!;
        const original = fullStrings.find((x) => x.startsWith(prefix) && x.length === prefix.length + Number(more));
        if (!original) {
          failures.push(`${tool}: no original text for a cut`);
          continue;
        }
        const followed = await executeTool(db, target, JSON.parse(argsJson));
        followedTools.add(`${tool}->${target}`);
        if (!strings(followed).includes(original)) failures.push(`${tool} -> ${target} ${argsJson}: full text not returned`);
        if (strings(compactToolOutput(target, followed)).some((x) => MARK.test(x))) {
          failures.push(`${tool} -> ${target} ${argsJson}: still cut`);
        }
      }
    }
    expect(failures).toEqual([]);
    // Every family that cuts text on this book was followed.
    expect([...followedTools].sort()).toEqual(
      [
        "query_alerts->query_alerts",
        "query_calendar_briefings->query_calendar_briefings",
        "query_calendar_events->query_calendar_events",
        "query_levels->query_levels",
        "query_notes->query_notes",
        "query_press_releases->query_press_releases",
        "query_research_documents->query_research_documents",
        "query_research_feeds->query_research_feeds",
      ],
    );
  }, 120000);
});
