import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, type ScenarioResult } from "@/lib/compute/scenarios";
import {
  classifyBook,
  stockEquivalentVerdict,
  ASSUMED_VOL_NOT_STOCK_NOTE,
  NO_VOL_SOURCE_NOT_STOCK_NOTE,
  type DefenseInstrument,
  type UnderlyingGroup,
} from "@/lib/compute/hedging";
import { todayET } from "@/lib/calendar/date-utils";
import { anchorIndex } from "../helpers/source-anchor";

/**
 * Unit N3 (2026-10-08): small analysis correctness fixes.
 *  - the custom sector shock names an equity-evidence "bond" fund it could
 *    not look through (it takes the market move, so it was skipped);
 *  - a short call with no shares is never labelled a put;
 *  - a deep call with no volatility source at all says why it is not stock.
 * Every ticker and amount here is synthetic.
 */

// ─── Sector-shock disclosure ────────────────────────────────────────

describe("custom sector shock: an equity-evidence fund with no sector weights is named", () => {
  let db: Database.Database;
  let today: string;
  const EVIDENCE_SECTOR = 1; // ZZA: bond category, Financials sector
  const EVIDENCE_NAME = 2; // ZZB: bond category, equity word in the name
  const REAL_BOND = 3; // ZZC
  const STORED = 4; // ZZD: equity sector but a stored duration
  const UNCONFIRMED = 5; // ZZE: Fixed Income sector, unknown category
  const PLAIN = 6; // ZZF: an ordinary equity fund

  function seed(
    id: number,
    symbol: string,
    name: string,
    sector: string | null,
    fundCategory: string | null,
    duration: number | null = null,
  ) {
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category, duration_years)
       VALUES (?, ?, ?, 'Mutual Fund', ?, ?, ?)`,
    ).run(id, symbol, name, sector, fundCategory, duration);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 50, 'test')`).run(id, today);
    // 200 x 50 = 10,000 each
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 200, ?)`,
    ).run(id, today, `h-${id}`);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    today = todayET();
    db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();
    seed(EVIDENCE_SECTOR, "ZZA", "ZZ Managed Fund", "Financials", "Diversified Bond");
    seed(EVIDENCE_NAME, "ZZB", "ZZ Long Short Equity Fund", null, "Diversified Bond");
    seed(REAL_BOND, "ZZC", "ZZ Aggregate Bond Fund", "Fixed Income", "US Aggregate Bond");
    seed(STORED, "ZZD", "ZZ Managed Income Fund", "Financials", "Diversified Bond", 4);
    seed(UNCONFIRMED, "ZZE", "ZZ Income Fund", "Fixed Income", "ZZ Income");
    seed(PLAIN, "ZZF", "ZZ Broad Fund", null, "US Large Cap Equity");
  });

  const run = (sectorMoves: Record<string, number>): ScenarioResult =>
    computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: -0.1, sectorMoves });
  const rowOf = (res: ScenarioResult, id: number) => res.positionImpacts.find((p) => p.securityId === id)!;

  it("names both equity-evidence funds beside the plain equity fund; the bond funds stay unnamed", () => {
    const res = run({ Technology: -0.5 });
    expect(res.fundsWithoutSectorWeights).toEqual(["ZZA", "ZZB", "ZZF"]);

    // The list is honest: each named fund took the market move as one bucket.
    // ZZB and ZZF have no sector: beta 1.0, so -10% of 10,000 = -1,000.
    expect(rowOf(res, EVIDENCE_NAME).estimatedChange).toBeCloseTo(-1000, 6);
    expect(rowOf(res, PLAIN).estimatedChange).toBeCloseTo(-1000, 6);
    // ZZA (Financials, no beta tilt): the same -1,000.
    expect(rowOf(res, EVIDENCE_SECTOR).estimatedChange).toBeCloseTo(-1000, 6);
    // The three unnamed funds took no equity move at all.
    for (const id of [REAL_BOND, STORED, UNCONFIRMED]) {
      expect(rowOf(res, id).estimatedChange, String(id)).toBeCloseTo(0, 12);
    }
  });

  it("does not name the equity-evidence fund when its own sector carries the shock", () => {
    const res = run({ Financials: -0.3 });
    expect(res.fundsWithoutSectorWeights).toEqual(["ZZB", "ZZF"]);
    // ZZA took the Financials move as one bucket: -30% of 10,000.
    expect(rowOf(res, EVIDENCE_SECTOR).estimatedChange).toBeCloseTo(-3000, 6);
  });

  it("the disclosure changes no figure", () => {
    const res = run({ Technology: -0.5 });
    // -1,000 for each of ZZA, ZZB, ZZF; nothing else moves.
    expect(res.estimatedChange).toBeCloseTo(-3000, 6);
  });
});

// ─── Defense: short call label, and the no-volatility-source note ───

function inst(over: Partial<DefenseInstrument>): DefenseInstrument {
  return {
    securityId: 1,
    symbol: "ZZA",
    underlying: "ZZA",
    isOption: false,
    optionType: null,
    quantity: 100,
    exposure: 10000,
    marketValue: 10000,
    underlyingIsEtf: false,
    sector: "Technology",
    geography: "US",
    greeksAvailable: true,
    ...over,
  };
}

function group(underlying: string, instruments: DefenseInstrument[]): [string, UnderlyingGroup] {
  return [underlying, { underlying, underlyingIsEtf: false, instruments }];
}

/** 2 SHORT calls, delta 0.50, underlying $100: -2 x 100 x 0.50 x $100 = -$10,000. */
function shortCall(over: Partial<DefenseInstrument> = {}): DefenseInstrument {
  return inst({
    securityId: 2,
    symbol: "ZZA   270115C00100000",
    isOption: true,
    optionType: "CALL",
    quantity: -2,
    exposure: -10000,
    marketValue: -1500,
    delta: 0.5,
    ivSource: "computed",
    ...over,
  });
}

/** 1 long put, delta -0.40, underlying $100: 1 x 100 x -0.40 x $100 = -$4,000. */
function longPut(over: Partial<DefenseInstrument> = {}): DefenseInstrument {
  return inst({
    securityId: 3,
    symbol: "ZZA   270115P00095000",
    isOption: true,
    optionType: "PUT",
    quantity: 1,
    exposure: -4000,
    marketValue: 600,
    delta: -0.4,
    ivSource: "computed",
    ...over,
  });
}

/** 1 long call, delta 0.30: +$3,000. */
function longCall(over: Partial<DefenseInstrument> = {}): DefenseInstrument {
  return inst({
    securityId: 4,
    symbol: "ZZA   270115C00120000",
    isOption: true,
    optionType: "CALL",
    quantity: 1,
    exposure: 3000,
    marketValue: 400,
    delta: 0.3,
    ivSource: "computed",
    ...over,
  });
}

describe("classifyBook: a standalone bet is named for the legs that make it bearish", () => {
  it("a short call with no shares is a short call, never a put", () => {
    const r = classifyBook(new Map([group("ZZA", [shortCall()])]));
    expect(r.pairs).toHaveLength(0);
    expect(r.standaloneBets).toHaveLength(1);
    expect(r.standaloneBets[0].kind).toBe("single_name_short_call");
    expect(r.standaloneBets[0].exposure).toBe(-10000);
  });

  it("a short call outweighing a long call is still a short call", () => {
    // -10,000 + 3,000 = -7,000
    const r = classifyBook(new Map([group("ZZA", [shortCall(), longCall()])]));
    expect(r.standaloneBets).toHaveLength(1);
    expect(r.standaloneBets[0].kind).toBe("single_name_short_call");
    expect(r.standaloneBets[0].exposure).toBe(-7000);
  });

  it("a long put alone keeps its kind", () => {
    const r = classifyBook(new Map([group("ZZA", [longPut()])]));
    expect(r.standaloneBets[0].kind).toBe("single_name_put");
    expect(r.standaloneBets[0].exposure).toBe(-4000);
  });

  it("a long put outweighing a long call keeps its kind", () => {
    // -4,000 + 3,000 = -1,000
    const r = classifyBook(new Map([group("ZZA", [longPut(), longCall()])]));
    expect(r.standaloneBets[0].kind).toBe("single_name_put");
    expect(r.standaloneBets[0].exposure).toBe(-1000);
  });

  it("a long put with a short call is neither: bearish options", () => {
    // -4,000 - 10,000 = -14,000
    const r = classifyBook(new Map([group("ZZA", [longPut(), shortCall()])]));
    expect(r.standaloneBets).toHaveLength(1);
    expect(r.standaloneBets[0].kind).toBe("single_name_bearish_options");
    expect(r.standaloneBets[0].exposure).toBe(-14000);
  });

  it("the type comparison ignores case", () => {
    const lower = shortCall({ optionType: "call" as unknown as "CALL" });
    const r = classifyBook(new Map([group("ZZA", [lower])]));
    expect(r.standaloneBets[0].kind).toBe("single_name_short_call");
  });

  it("the tables label every kind, and the short call reads 'short call'", () => {
    const src = readFileSync(join(process.cwd(), "app/dashboard/components/DefenseTables.tsx"), "utf8");
    const start = anchorIndex(src, "const BET_KIND_LABEL");
    const block = src.slice(start, src.indexOf("};", start));
    expect(block).toContain('single_name_short_call: "short call"');
    expect(block).toContain("single_name_put:");
    expect(block).toContain("single_name_bearish_options:");
    expect(block).toContain("naked_short:");
    // No label for a call kind may say "put".
    const callLine = block.split("\n").find((l) => l.includes("single_name_short_call"))!;
    expect(callLine.toLowerCase().replace("single_name_short_call", "")).not.toContain("put");
  });
});

describe("stockEquivalentVerdict: a deep call with no volatility source says why it is not stock", () => {
  /** 2 long calls, delta 0.90, underlying $100: 2 x 100 x 0.90 x $100 = $18,000. */
  const deepCall = (over: Partial<DefenseInstrument> = {}) =>
    inst({
      securityId: 5,
      symbol: "ZZA   270115C00060000",
      isOption: true,
      optionType: "CALL",
      quantity: 2,
      exposure: 18000,
      marketValue: 8200,
      delta: 0.9,
      ivSource: "computed",
      ...over,
    });

  it("refuses it with its own note", () => {
    const verdict = stockEquivalentVerdict(deepCall({ ivSource: undefined }));
    expect(verdict.counts).toBe(false);
    expect(verdict.refusedReason).toBe(NO_VOL_SOURCE_NOT_STOCK_NOTE);
    expect(NO_VOL_SOURCE_NOT_STOCK_NOTE).toBe("delta has no volatility source: not counted as stock");
    expect(NO_VOL_SOURCE_NOT_STOCK_NOTE).not.toBe(ASSUMED_VOL_NOT_STOCK_NOTE);
  });

  it("the other verdicts are unchanged", () => {
    expect(stockEquivalentVerdict(deepCall())).toEqual({ counts: true, refusedReason: null });
    expect(stockEquivalentVerdict(deepCall({ ivSource: "default" }))).toEqual({
      counts: false,
      refusedReason: ASSUMED_VOL_NOT_STOCK_NOTE,
    });
    // Below the delta bar there is nothing to explain, source or not.
    expect(stockEquivalentVerdict(deepCall({ delta: 0.5, ivSource: undefined }))).toEqual({
      counts: false,
      refusedReason: null,
    });
    // No delta at all: nothing "would have qualified".
    expect(stockEquivalentVerdict(deepCall({ delta: null, greeksAvailable: false, ivSource: undefined }))).toEqual({
      counts: false,
      refusedReason: null,
    });
  });

  it("the row carries the note", () => {
    // The call is not stock, so the name holds options only:
    // +18,000 (call) - 4,000 (put) = +14,000, one speculative row.
    const r = classifyBook(new Map([group("ZZA", [deepCall({ ivSource: undefined }), longPut()])]));
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0].classification).toBe("speculative");
    expect(r.pairs[0].coreExposure).toBe(0);
    expect(r.pairs[0].netExposure).toBe(14000);
    expect(r.pairs[0].notes).toEqual([NO_VOL_SOURCE_NOT_STOCK_NOTE]);
  });
});
