/**
 * The SQL side of the UTC sweep: a calendar-day comparison inside a query uses
 * the EASTERN day, supplied from JavaScript, never SQLite's `date('now')`.
 *
 * The clock is frozen (Date only) at 2026-03-10T01:30:00Z, which is 21:30
 * Eastern on 2026-03-09: the UTC day has rolled over, the Eastern one has not.
 *
 * SQLite's own clock cannot be faked, and that is what makes these tests bite:
 * a reader still on `date('now')` compares against the REAL day the suite runs
 * on (long after the frozen one), so a bond maturing on the frozen Eastern day
 * reads as long matured and the "still a position today" assertions fail.
 * The "matured yesterday" assertions hold the other direction: binding the day
 * must not simply stop filtering.
 *
 * Synthetic symbols and round amounts only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { easternDaySql, unmaturedSecuritySql } from "@/lib/db/eastern-day-sql";
import {
  getAllHoldings,
  getHoldingsByAccount,
  getValuedHoldingsByAccount,
} from "@/lib/queries/holdings";
import { getAllocationBreakdown, getHoldingsForChat } from "@/lib/queries/chat-tools";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import {
  getAllocationByDimension,
  getAnalysisDataCoverage,
  getFactorCoverage,
  getFactorHeatmap,
} from "@/lib/queries/analysis";
import { getHoldingsInBucket } from "@/lib/queries/drill-down";
import { getAnalysisTrustState } from "@/lib/queries/analysis-trust-state";
import { getIbkrTodayHoldings } from "@/lib/queries/today-holdings";
import { getAccountSummaries, getPortfolioCurrentValues } from "@/lib/queries/dashboard";
import {
  getHeldOptionUnderlyingSymbols,
  getSymbolStatusDetailed,
} from "@/lib/queries/briefing-symbols";
import { searchResearchDocuments } from "@/lib/queries/research-documents";
import { getNotesForFamily } from "@/lib/queries/notes";
import { purgeMaturedBondHoldings } from "@/lib/mutations/matured-bonds";
import { purgeExpiredOptionHoldings } from "@/lib/mutations/expired-options";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { upsertLevel } from "@/lib/mutations/security-levels";
import { addToWatchlist } from "@/lib/mutations/watchlist";
import { buildSnapshot } from "@/scripts/snapshot-state-to-r2";

const aiCalls = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => aiCalls.generate(...a),
}));
const pushover = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/alerts/notify-pushover", () => ({
  sendPushover: (...a: unknown[]) => pushover(...(a as [])),
}));

import { classifyFactors } from "@/lib/compute/classify-factors";
import { alertBlockedRecaps } from "@/lib/calendar/email-sweep";

const EVENING_ET = new Date("2026-03-10T01:30:00Z");
const ET_TODAY = "2026-03-09";
const ET_YESTERDAY = "2026-03-08";
// Migration 002 seeds: Vanguard Taxable (1), Vanguard Roth IRA (2), IBKR (3).
const ACCT = 1;
const IBKR = 3;

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(EVENING_ET);
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  aiCalls.generate.mockReset();
  aiCalls.generate.mockRejectedValue(new Error("no AI in this test"));
  pushover.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

interface SecOpts {
  type?: string;
  maturity?: string | null;
  expiration?: string | null;
  underlying?: string | null;
  optionType?: string | null;
  strike?: number | null;
  multiplier?: number;
}

function seedSec(symbol: string, o: SecOpts = {}): number {
  return db
    .prepare(
      `INSERT INTO securities
         (symbol, name, security_type, asset_class, multiplier, maturity_date,
          expiration_date, underlying_symbol, option_type, strike_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      symbol,
      `${symbol} name`,
      o.type ?? "Stock",
      o.type === "Bond" ? "fixed_income" : "equity",
      o.multiplier ?? 1,
      o.maturity ?? null,
      o.expiration ?? null,
      o.underlying ?? null,
      o.optionType ?? null,
      o.strike ?? null,
    ).lastInsertRowid as number;
}

function seedHolding(secId: number, qty: number, accountId = ACCT, asOf = ET_YESTERDAY): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, secId, qty, 1000, asOf);
}

function seedPrice(secId: number, date: string, price: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'manual')",
  ).run(secId, date, price);
}

/** A stock, a bond maturing on the Eastern day, and a bond that matured the day before. */
function seedBondBook(accountId = ACCT) {
  const stock = seedSec("ZZA");
  const bondToday = seedSec("ZZBT", { type: "Bond", maturity: ET_TODAY });
  const bondGone = seedSec("ZZBG", { type: "Bond", maturity: ET_YESTERDAY });
  for (const id of [stock, bondToday, bondGone]) {
    seedHolding(id, 100, accountId);
    seedPrice(id, ET_YESTERDAY, 100);
  }
  return { stock, bondToday, bondGone };
}

const symbolsOf = (rows: Array<{ symbol: string }>) => rows.map((r) => r.symbol).sort();

describe("the frozen clock really straddles the two days", () => {
  it("reads 2026-03-09 in Eastern time and 2026-03-10 in UTC", () => {
    expect(todayET()).toBe(ET_TODAY);
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-03-10");
  });
});

describe("the shared fragments", () => {
  it("easternDaySql is the quoted Eastern day, and refuses anything else", () => {
    expect(easternDaySql()).toBe(`'${ET_TODAY}'`);
    expect(easternDaySql("2026-01-02")).toBe("'2026-01-02'");
    expect(() => easternDaySql("2026-1-2")).toThrow(/YYYY-MM-DD/);
    expect(() => easternDaySql("x' OR 1=1 --")).toThrow(/YYYY-MM-DD/);
  });

  it("unmaturedSecuritySql keeps a security through its maturity day", () => {
    expect(unmaturedSecuritySql()).toBe(
      `(s.maturity_date IS NULL OR s.maturity_date >= '${ET_TODAY}')`,
    );
    expect(unmaturedSecuritySql("x", "2026-01-02")).toBe(
      "(x.maturity_date IS NULL OR x.maturity_date >= '2026-01-02')",
    );
  });
});

describe("a bond is a position through the end of its Eastern maturity day", () => {
  it("holdings tables: all accounts, one account, and the valued one-account read", () => {
    seedBondBook();
    const want = ["ZZA", "ZZBT"];
    expect(symbolsOf(getAllHoldings(db))).toEqual(want);
    expect(symbolsOf(getHoldingsByAccount(db, ACCT))).toEqual(want);
    expect(symbolsOf(getValuedHoldingsByAccount(db, ACCT))).toEqual(want);
  });

  it("chat holdings, chat allocation and the chat summary", () => {
    seedBondBook();
    expect(symbolsOf(getHoldingsForChat(db, { limit: 50 }))).toEqual(["ZZA", "ZZBT"]);
    // 100 shares at 100 = 10,000; 100 face at 100 = 100 (bonds are per 100).
    const weights = getHoldingsForChat(db, { limit: 50 });
    const total = weights.reduce((s, r) => s + ((r as { market_value: number }).market_value ?? 0), 0);
    expect(total).toBe(10100);
    const bySymbol = getAllocationBreakdown(db, "symbol");
    expect(bySymbol.map((r) => r.group_name).sort()).toEqual(["ZZA", "ZZBT"]);

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("- ZZBT (");
    expect(summary).not.toContain("- ZZBG (");
  });

  it("the chat maturity note counts whole calendar days from the Eastern day", () => {
    const today = seedSec("ZZBT", { type: "Bond", maturity: ET_TODAY });
    const tomorrow = seedSec("ZZB1", { type: "Bond", maturity: addDays(ET_TODAY, 1) });
    const in90 = seedSec("ZZB90", { type: "Bond", maturity: addDays(ET_TODAY, 90) });
    const in91 = seedSec("ZZB91", { type: "Bond", maturity: addDays(ET_TODAY, 91) });
    for (const id of [today, tomorrow, in90, in91]) {
      seedHolding(id, 100);
      seedPrice(id, ET_YESTERDAY, 100);
    }
    const notes = new Map(
      getHoldingsForChat(db, { limit: 50 }).map((r) => [
        r.symbol,
        (r as { maturity_note: string | null }).maturity_note,
      ]),
    );
    expect(notes.get("ZZBT")).toBe("Matures today");
    expect(notes.get("ZZB1")).toBe("Matures in 1 day");
    expect(notes.get("ZZB90")).toBe("Matures in 90 days");
    expect(notes.get("ZZB91")).toBeNull();
  });

  it("Analysis: allocation rows, drill-down, data coverage, factor heatmap and coverage", () => {
    seedBondBook();
    const byType = getAllocationByDimension(db, "security_type");
    const bondRow = byType.find((r) => r.group_name.toLowerCase() === "bond");
    expect(bondRow?.position_count).toBe(1);
    expect(bondRow?.total_market_value).toBe(100);

    const sectorTotal = getAllocationByDimension(db, "sector").reduce(
      (s, r) => s + r.total_market_value,
      0,
    );
    expect(sectorTotal).toBe(10100);

    const drill = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "security_type",
      bucket: bondRow!.group_name,
    });
    expect(symbolsOf(drill)).toEqual(["ZZBT"]);

    const coverage = getAnalysisDataCoverage(db);
    expect(coverage.holdingsTotal).toBe(10100);

    expect(symbolsOf(getFactorHeatmap(db))).toEqual(["ZZA", "ZZBT"]);
    expect(getFactorCoverage(db).totalHoldings).toBe(2);
  });

  it("the Today IBKR snapshot keeps a non-bond that matures today and drops one that matured", () => {
    const today = seedSec("ZZCT", { type: "Other", maturity: ET_TODAY });
    const gone = seedSec("ZZCG", { type: "Other", maturity: ET_YESTERDAY });
    for (const id of [today, gone]) {
      seedHolding(id, 100, IBKR);
      seedPrice(id, ET_YESTERDAY, 100);
    }
    expect(symbolsOf(getIbkrTodayHoldings(db, IBKR, null))).toEqual(["ZZCT"]);
  });

  it("the hedge book counts a fund-typed holding through its maturity day", () => {
    const today = seedSec("ZZFT", { type: "ETF", maturity: ET_TODAY });
    const gone = seedSec("ZZFG", { type: "ETF", maturity: ET_YESTERDAY });
    for (const id of [today, gone]) {
      seedHolding(id, 100);
      seedPrice(id, ET_YESTERDAY, 100);
    }
    const analysis = JSON.stringify(computeDefenseAnalysis(db));
    expect(analysis).toContain("ZZFT");
    expect(analysis).not.toContain("ZZFG");
  });

  it("factor classification gives default factors to a bond maturing today, none to a matured one", async () => {
    const { bondToday, bondGone, stock } = seedBondBook();
    // The stock would go to the AI; give it a factor row so only bonds are left.
    db.prepare(
      `INSERT INTO security_factors (security_id, factor_source) VALUES (?, 'manual')`,
    ).run(stock);
    await classifyFactors(db);
    const has = (id: number) =>
      !!db.prepare("SELECT 1 FROM security_factors WHERE security_id = ?").get(id);
    expect(has(bondToday)).toBe(true);
    expect(has(bondGone)).toBe(false);
  });

  it("the purge keeps a bond one Eastern day past maturity, then deletes it", () => {
    const grace = seedSec("ZZBY", { type: "Bond", maturity: ET_YESTERDAY });
    const old = seedSec("ZZBO", { type: "Bond", maturity: addDays(ET_TODAY, -2) });
    seedHolding(grace, 100);
    seedHolding(old, 100);
    expect(purgeMaturedBondHoldings(db)).toBe(1);
    const left = db
      .prepare("SELECT security_id FROM holdings ORDER BY security_id")
      .all() as Array<{ security_id: number }>;
    expect(left.map((r) => r.security_id)).toEqual([grace]);
    // The scoped form with no `today` supplied uses the same Eastern day.
    seedHolding(old, 100, ACCT, ET_TODAY);
    expect(purgeMaturedBondHoldings(db, 1, { accountId: ACCT })).toBe(1);
    expect(purgeMaturedBondHoldings(db, 1, { accountId: ACCT })).toBe(0);
  });
});

describe("an option is held through the end of its Eastern expiration day", () => {
  function seedOptionBook() {
    const live = seedSec("ZZU   260309C00100000", {
      type: "Option",
      expiration: ET_TODAY,
      underlying: "ZZU",
      optionType: "call",
      strike: 100,
      multiplier: 100,
    });
    const dead = seedSec("ZZV   260308C00100000", {
      type: "Option",
      expiration: ET_YESTERDAY,
      underlying: "ZZV",
      optionType: "call",
      strike: 100,
      multiplier: 100,
    });
    seedHolding(live, 1);
    seedHolding(dead, 1);
    return { live, dead };
  }

  it("earnings coverage: the underlying of an option expiring today is still held", () => {
    seedOptionBook();
    const status = getSymbolStatusDetailed(db, ["ZZU", "ZZV"]);
    expect(status.ZZU.reasons.held).toBe(true);
    expect(status.ZZV.reasons.held).toBe(false);
    expect(getHeldOptionUnderlyingSymbols(db)).toEqual(["ZZU"]);
  });

  it("factor classification still creates the underlying of an option expiring today", async () => {
    seedOptionBook();
    await classifyFactors(db).catch(() => undefined);
    const underlyings = db
      .prepare("SELECT symbol FROM securities WHERE source_key LIKE 'underlying:%' ORDER BY symbol")
      .all() as Array<{ symbol: string }>;
    expect(underlyings.map((r) => r.symbol)).toEqual(["ZZU"]);
  });

  it("the purge keeps an option one Eastern day past expiry, then deletes it", () => {
    const { dead } = seedOptionBook();
    const old = seedSec("ZZW   260307C00100000", {
      type: "Option",
      expiration: addDays(ET_TODAY, -2),
      underlying: "ZZW",
    });
    seedHolding(old, 1);
    expect(purgeExpiredOptionHoldings(db)).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM holdings WHERE security_id = ?").get(dead),
    ).toEqual({ n: 1 });
    seedHolding(old, 1, ACCT, ET_TODAY);
    expect(purgeExpiredOptionHoldings(db, 1, { accountId: ACCT })).toBe(1);
    expect(purgeExpiredOptionHoldings(db, 1, { accountId: ACCT })).toBe(0);
  });
});

describe("a live broker value counts as current through the end of the next Eastern day", () => {
  function seedSnapshot(accountId: number, date: string, value: number, source: string): void {
    db.prepare(
      `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (?, ?, ?, ?)`,
    ).run(accountId, date, value, source);
  }

  it("yesterday's live row is used; a live row two days old is not", () => {
    seedSnapshot(IBKR, "2026-01-31", 200000, "manual");
    seedSnapshot(IBKR, ET_YESTERDAY, 230000, "tws");
    seedSnapshot(ACCT, "2026-01-31", 100000, "manual");
    seedSnapshot(ACCT, addDays(ET_TODAY, -2), 130000, "plaid");

    const values = getPortfolioCurrentValues(db, [ACCT, IBKR]);
    const byId = new Map(values.accounts.map((a) => [a.accountId, a]));
    expect(byId.get(IBKR)?.currentValue).toBe(230000);
    expect(byId.get(IBKR)?.sourceKind).toBe("live");
    expect(byId.get(ACCT)?.currentValue).toBe(100000);
    expect(byId.get(ACCT)?.sourceKind).toBe("statement");

    const summaries = new Map(getAccountSummaries(db).map((a) => [a.id, a]));
    expect(summaries.get(IBKR)?.latestValue).toBe(230000);
    expect(summaries.get(IBKR)?.dataSource).toBe("tws_live");
    expect(summaries.get(ACCT)?.latestValue).toBe(100000);
  });
});

describe("stale prices are counted in whole Eastern days", () => {
  it("a price four days old is stale, three days old is not", () => {
    const four = seedSec("ZZS4");
    const three = seedSec("ZZS3");
    seedHolding(four, 10);
    seedHolding(three, 10);
    seedPrice(four, addDays(ET_TODAY, -4), 50);
    seedPrice(three, addDays(ET_TODAY, -3), 50);
    expect(getAnalysisTrustState(db).stalePrices.symbols).toEqual(["ZZS4"]);
  });

  it("a price date that carries a time of day counts as its calendar day", () => {
    // No stored price date carries a time today; if one ever does, the
    // afternoon stamp must not make a four-day-old price read as 3.4 days.
    const four = seedSec("ZZS4");
    const three = seedSec("ZZS3");
    const fourT = seedSec("ZZT4");
    seedHolding(four, 10);
    seedHolding(three, 10);
    seedHolding(fourT, 10);
    seedPrice(four, `${addDays(ET_TODAY, -4)} 15:00:00`, 50);
    seedPrice(three, `${addDays(ET_TODAY, -3)} 00:00:00`, 50);
    seedPrice(fourT, `${addDays(ET_TODAY, -4)}T23:59:59`, 50);
    expect(getAnalysisTrustState(db).stalePrices.symbols).toEqual(["ZZS4", "ZZT4"]);
  });
});

describe("day-count windows start from the Eastern day", () => {
  it("research search: days_back counts from the Eastern day", () => {
    const insert = db.prepare(
      `INSERT INTO research_documents (title, filename, raw_text, publication_date, document_type)
       VALUES (?, ?, 'zebra thesis text', ?, 'article')`,
    );
    insert.run("In window", "in.pdf", addDays(ET_TODAY, -7));
    insert.run("Too old", "old.pdf", addDays(ET_TODAY, -8));
    const hits = searchResearchDocuments(db, { query: "zebra", days_back: 7 });
    expect(hits.map((h) => h.title)).toEqual(["In window"]);
  });

  it("notes for an issuer family: the 90-day window counts from the Eastern day", () => {
    const sec = seedSec("ZZN");
    const insert = db.prepare(
      `INSERT INTO notes (note_type, content, security_id, event_date) VALUES ('journal', ?, ?, ?)`,
    );
    insert.run("newest", sec, ET_TODAY);
    insert.run("edge", sec, addDays(ET_TODAY, -89));
    insert.run("out", sec, addDays(ET_TODAY, -90));
    expect(getNotesForFamily(db, ["ZZN"]).map((n) => n.content)).toEqual(["newest", "edge"]);
  });

  it("notes for an issuer family: an event date that carries a time counts as its day", () => {
    const sec = seedSec("ZZN");
    const insert = db.prepare(
      `INSERT INTO notes (note_type, content, security_id, event_date) VALUES ('journal', ?, ?, ?)`,
    );
    insert.run("newest", sec, `${ET_TODAY} 23:30:00`);
    insert.run("edge", sec, `${addDays(ET_TODAY, -89)}T00:00:01`);
    insert.run("out", sec, `${addDays(ET_TODAY, -90)} 23:59:59`);
    insert.run("out-iso", sec, `${addDays(ET_TODAY, -90)}T23:59:59.000Z`);
    expect(getNotesForFamily(db, ["ZZN"]).map((n) => n.content)).toEqual(["newest", "edge"]);
  });

  it("the Worker snapshot carries the same 90-day note window", () => {
    const sec = seedSec("ZZN");
    const insert = db.prepare(
      `INSERT INTO notes (note_type, content, security_id, event_date) VALUES ('journal', ?, ?, ?)`,
    );
    insert.run("newest", sec, ET_TODAY);
    insert.run("edge", sec, addDays(ET_TODAY, -89));
    insert.run("out", sec, addDays(ET_TODAY, -90));
    const snap = buildSnapshot(db) as unknown as { notes: Array<{ content: string }> };
    expect(snap.notes.map((n) => n.content)).toEqual(["newest", "edge"]);
  });

  it("blocked-recap alert: the age pre-filter follows the injected clock's Eastern day", async () => {
    // Released 16:05 Eastern on the frozen day, 5h25m before `now`.
    const eventId = db
      .prepare(
        `INSERT INTO calendar_events (
           source, event_type, event_date, event_time, release_time, title,
           symbol, source_key, week_of
         ) VALUES ('finnhub','earnings',?,'16:05','16:05','ZZE earnings','ZZE',?,?)`,
      )
      .run(ET_TODAY, `finnhub:ZZE:${ET_TODAY}`, ET_TODAY).lastInsertRowid as number;
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, 'preview', 'test@example.com', 'preview body', NULL)`,
    ).run(eventId);

    expect(await alertBlockedRecaps(db, { now: EVENING_ET })).toBe(1);
    expect(pushover).toHaveBeenCalledTimes(1);
    expect(await alertBlockedRecaps(db, { now: EVENING_ET })).toBe(0);
  });
});

describe("a day written by the app is the Eastern day, not the column's UTC default", () => {
  it("a new level's set_date and a new watchlist row's added_date", () => {
    const sec = seedSec("ZZA");
    const levelId = upsertLevel(db, { security_id: sec, level_type: "support", price: 90 });
    expect(
      db.prepare("SELECT set_date FROM security_levels WHERE id = ?").get(levelId),
    ).toEqual({ set_date: ET_TODAY });

    addToWatchlist(db, { securityId: sec });
    expect(
      db.prepare("SELECT added_date FROM watchlist WHERE security_id = ?").get(sec),
    ).toEqual({ added_date: ET_TODAY });

    // A re-add keeps the day the name was first added.
    vi.setSystemTime(new Date("2026-03-12T15:00:00Z"));
    addToWatchlist(db, { securityId: sec, thesis: "again" });
    expect(
      db.prepare("SELECT added_date FROM watchlist WHERE security_id = ?").get(sec),
    ).toEqual({ added_date: ET_TODAY });
  });
});
