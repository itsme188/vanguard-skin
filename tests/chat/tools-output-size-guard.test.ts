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
  // Text and flags must survive as they are (a hoisted column that was not
  // uniform, or a lost row, shows up here); a cut text must be a prefix of
  // the full one followed by the marker.
  if (typeof full === "string") {
    if (compact === full) return [];
    if (typeof compact === "string" && compact.includes("…[cut: ") && full.startsWith(compact.split("…[cut: ")[0])) return [];
    return [`${tool}${path}: text changed (${JSON.stringify(full).slice(0, 40)} -> ${JSON.stringify(compact).slice(0, 40)})`];
  }
  if (typeof full === "boolean") return compact === full ? [] : [`${tool}${path}: ${full} -> ${JSON.stringify(compact)}`];
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

/**
 * The fields the compact form may round, pinned HERE independently of the
 * map in lib/chat/tools.ts: a new rounded field must be added to both, on
 * purpose. Money to cents, percents to 2, prices to 4. Never a return,
 * contribution, share, fraction, rate, Greek or macro value.
 */
const ALLOWED_ROUNDING: Record<string, Record<string, number>> = {
  query_holdings: {
    cost_basis: 2, market_value: 2, unrealized_gain: 2, latest_price: 4, unrealized_gain_pct: 2, position_weight_pct: 2,
    total_cost_basis_usd: 2, // by_symbol; cost_basis_per_share_usd is a ratio and stays exact
    account_value_weight_pct: 2, account_value_usd: 2, // owner ruling B: share of account value incl. cash, and its base
  },
  query_tax_lots: {
    cost_basis: 2, original_lot_cost_basis: 2, current_value: 2, unrealized_gain: 2, proceeds: 2, realized_gain_loss: 2,
    proceeds_native: 2, cost_basis_native: 2, realized_gain_native: 2, proceeds_usd_at_current_fx: 2,
    cost_basis_usd_at_current_fx: 2, realized_gain_usd_at_current_fx: 2, acquisition_price: 4, current_price: 4, sale_price: 4,
    cost_basis_usd: 2, unrealized_gain_usd: 2, short_sale_proceeds_usd: 2, // totals block
  },
  query_transactions: { amount: 2, fees: 2, price_per_share: 4 },
  query_allocation: { total_market_value: 2, percentage: 2 },
  query_price_history: { close_price: 4 },
  query_market_snapshot: { market_value: 2, day_effect: 2, day_effect_total: 2, pct: 2 },
  query_income_summary: { total_dividends: 2, total_interest: 2, interest_paid: 2, total_fees: 2, net_income: 2 },
  query_levels: { price: 4, effective_price: 4, last_fired_price: 4 },
  query_alerts: { level_price: 4, triggered_price: 4 },
};

/** Field names that must never be rounded, probed on every tool whether or not the book produces them. */
const NEVER_ROUNDED_PROBES = [
  "contribution", "value", "share_of_option_value", "share_of_bond_value", "share_of_book", "net_market_value_usd",
  "estimated_change_fraction", "change_fraction", "delta", "gamma", "theta", "vega", "iv", "twr", "beta", "alpha",
  "weight", "gross_weight", "volatility", "sharpe", "herfindahl", "top5_share", "risk_free_rate", "quantity", "id",
  "cost_basis_per_share_usd", "total_quantity", "count", "unpriced_count", "left_out_no_fx_rate",
];

function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), allKeys(x, out));
  return out;
}

describe("compact output keeps every number (review RF-1/RF-2 guard)", () => {
  it("rounds only the fields pinned in this test, at the pinned precision", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedSizeBook(db);
    const problems: string[] = [];
    for (const [tool, input] of WORST_CASE_CALLS) {
      const keys = allKeys(await executeTool(db, tool, input));
      for (const k of NEVER_ROUNDED_PROBES) keys.add(k);
      for (const k of keys) {
        const rule = compactRoundingFor(tool, k);
        const allowed = ALLOWED_ROUNDING[tool]?.[k];
        if (rule && rule.dp !== allowed) problems.push(`${tool}.${k}: rounded to ${rule.dp} places, not allowed by this test`);
        if (!rule && allowed !== undefined) problems.push(`${tool}.${k}: pinned as rounded but the map leaves it exact`);
      }
    }
    expect(problems).toEqual([]);
  }, 120000);

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
