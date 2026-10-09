import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import {
  classifyBook,
  computeDefenseAnalysis,
  ASSUMED_VOL_NOT_STOCK_NOTE,
  type DefenseInstrument,
  type UnderlyingGroup,
} from "@/lib/compute/hedging";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";
import { todayET, addDays } from "@/lib/calendar/date-utils";

/**
 * Owner rulings (2026-10-08):
 *  (a) a LONG call with |delta| >= 0.80 counts as a share-equivalent core
 *      holding, delta-weighted, so a put against it is a hedge;
 *  (b) only a delta from a REAL volatility counts (never the assumed default);
 *  (c) an underlying that still holds only options nets into ONE row.
 *
 * Every ticker and amount here is synthetic.
 */

// ─── Pure classifier ────────────────────────────────────────────────

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

function group(underlying: string, isEtf: boolean, instruments: DefenseInstrument[]): [string, UnderlyingGroup] {
  return [underlying, { underlying, underlyingIsEtf: isEtf, instruments }];
}

/**
 * 2 long calls, delta 0.90, underlying at $100, multiplier 100:
 *   share-equivalents = 2 x 100 x 0.90 = 180 shares
 *   exposure          = 180 x $100     = $18,000
 */
function deepCall(over: Partial<DefenseInstrument> = {}): DefenseInstrument {
  return inst({
    securityId: 2,
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
}

/**
 * 1 long put, delta -0.40, underlying at $100, multiplier 100:
 *   exposure = 1 x 100 x -0.40 x $100 = -$4,000
 */
function put(over: Partial<DefenseInstrument> = {}): DefenseInstrument {
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

describe("classifyBook — a deep in-the-money long call counts as stock", () => {
  it("put + deep call (real volatility) is a hedged pair, with no standalone bet", () => {
    const r = classifyBook(new Map([group("ZZA", false, [deepCall(), put()])]));

    expect(r.standaloneBets).toHaveLength(0);
    expect(r.pairs).toHaveLength(1);
    const pair = r.pairs[0];
    expect(pair.classification).toBe("hedged_long");
    // core = the call's 180 share-equivalents x $100 = $18,000
    expect(pair.coreExposure).toBe(18000);
    // the put offsets $4,000 of it: 4,000 / 18,000 = 22.2%
    expect(pair.offsetExposure).toBe(4000);
    expect(pair.offsetCredited).toBe(4000);
    expect(pair.coveragePct).toBeCloseTo(4000 / 18000, 10);
    // net = 18,000 - 4,000
    expect(pair.netExposure).toBe(14000);
    // the call is core, not an amplifier
    expect(pair.amplifierExposure).toBe(0);
    expect(pair.hasAmplifiers).toBe(false);
    expect(pair.stockEquivalentExposure).toBe(18000);
  });

  it("a broker-volatility delta also counts (it is a real market figure)", () => {
    const r = classifyBook(new Map([group("ZZA", false, [deepCall({ ivSource: "ibkr" }), put()])]));
    expect(r.pairs[0].classification).toBe("hedged_long");
    expect(r.pairs[0].coreExposure).toBe(18000);
  });

  it("a put larger than the call's share-equivalents is credited only up to them", () => {
    // 3 puts at delta -0.80: 3 x 100 x -0.80 x $100 = -$24,000 against an
    // $18,000 core: credited 18,000 (100% cover); 6,000 is over-hedge.
    const r = classifyBook(
      new Map([group("ZZA", false, [deepCall(), put({ quantity: 3, exposure: -24000, delta: -0.8 })])]),
    );
    const pair = r.pairs[0];
    expect(pair.offsetExposure).toBe(24000);
    expect(pair.offsetCredited).toBe(18000);
    expect(pair.coveragePct).toBe(1);
    // not an ETF: the excess is not portfolio protection
    expect(r.proxyCandidates).toHaveLength(0);
  });

  it("the same call priced off the ASSUMED volatility does not count: no hedge, one netted row, reason shown", () => {
    const r = classifyBook(new Map([group("ZZA", false, [deepCall({ ivSource: "default" }), put()])]));

    // One row only: net = 18,000 - 4,000 = +14,000, a net bullish options position.
    expect(r.pairs).toHaveLength(1);
    expect(r.standaloneBets).toHaveLength(0);
    const pair = r.pairs[0];
    expect(pair.classification).toBe("speculative");
    expect(pair.coreExposure).toBe(0);
    expect(pair.offsetCredited).toBe(0);
    expect(pair.coveragePct).toBeNull();
    expect(pair.netExposure).toBe(14000);
    expect(pair.notes).toContain(ASSUMED_VOL_NOT_STOCK_NOTE);
    expect(ASSUMED_VOL_NOT_STOCK_NOTE).toMatch(/assumed volatility/);
    expect(ASSUMED_VOL_NOT_STOCK_NOTE).toMatch(/not counted as stock/);
  });

  it("assumed-volatility call smaller than the put stays a standalone bet, reason shown", () => {
    // 1 call at an assumed-vol delta 0.90: +$9,000. 3 puts at -0.50: -$15,000.
    // net = 9,000 - 15,000 = -6,000: one bearish row carrying both legs.
    const r = classifyBook(
      new Map([
        group("ZZA", false, [
          deepCall({ ivSource: "default", quantity: 1, exposure: 9000 }),
          put({ quantity: 3, exposure: -15000, delta: -0.5 }),
        ]),
      ]),
    );
    expect(r.pairs).toHaveLength(0);
    expect(r.standaloneBets).toHaveLength(1);
    const bet = r.standaloneBets[0];
    expect(bet.kind).toBe("single_name_put");
    expect(bet.exposure).toBe(-6000);
    expect(bet.instruments.map((i) => i.securityId).sort()).toEqual([2, 3]);
    expect(bet.notes).toContain(ASSUMED_VOL_NOT_STOCK_NOTE);
  });

  it("a null delta never counts, whatever the volatility source", () => {
    const r = classifyBook(
      new Map([group("ZZA", false, [deepCall({ delta: null, greeksAvailable: false }), put()])]),
    );
    expect(r.pairs[0].classification).toBe("speculative");
    expect(r.pairs[0].coreExposure).toBe(0);
    // no delta, so nothing "would have qualified": no assumed-volatility note
    expect(r.pairs[0].notes ?? []).not.toContain(ASSUMED_VOL_NOT_STOCK_NOTE);
  });

  it("a call with no recorded volatility source never counts", () => {
    const r = classifyBook(new Map([group("ZZA", false, [deepCall({ ivSource: undefined }), put()])]));
    expect(r.pairs[0].classification).toBe("speculative");
    expect(r.pairs[0].coreExposure).toBe(0);
  });

  it("a call just under the threshold (delta 0.79) is not stock", () => {
    // 2 x 100 x 0.79 x $100 = $15,800
    const r = classifyBook(new Map([group("ZZA", false, [deepCall({ delta: 0.79, exposure: 15800 }), put()])]));
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0].classification).toBe("speculative");
    expect(r.pairs[0].netExposure).toBe(11800); // 15,800 - 4,000
    expect(r.standaloneBets).toHaveLength(0);
  });

  it("a call exactly at the threshold (delta 0.80) is stock", () => {
    // 2 x 100 x 0.80 x $100 = $16,000
    const r = classifyBook(new Map([group("ZZA", false, [deepCall({ delta: 0.8, exposure: 16000 }), put()])]));
    expect(r.pairs[0].classification).toBe("hedged_long");
    expect(r.pairs[0].coreExposure).toBe(16000);
  });

  it("shares + deep call + put: core includes both", () => {
    // 100 shares x $100 = $10,000, plus the call's $18,000 = $28,000 core.
    // Put -$4,000: cover = 4,000 / 28,000 = 14.3%. Net = 28,000 - 4,000.
    const r = classifyBook(
      new Map([group("ZZA", false, [inst({ securityId: 1, exposure: 10000 }), deepCall(), put()])]),
    );
    const pair = r.pairs[0];
    expect(pair.classification).toBe("hedged_long");
    expect(pair.coreExposure).toBe(28000);
    expect(pair.stockEquivalentExposure).toBe(18000);
    expect(pair.offsetCredited).toBe(4000);
    expect(pair.coveragePct).toBeCloseTo(4000 / 28000, 10);
    expect(pair.netExposure).toBe(24000);
    expect(pair.hasAmplifiers).toBe(false);
  });

  it("shares + deep call, no put: the call adds to core (unhedged), it is no longer an amplifier", () => {
    const r = classifyBook(new Map([group("ZZA", false, [inst({ securityId: 1, exposure: 10000 }), deepCall()])]));
    const pair = r.pairs[0];
    expect(pair.classification).toBe("unhedged");
    expect(pair.coreExposure).toBe(28000);
    expect(pair.amplifierExposure).toBe(0);
    expect(pair.hasAmplifiers).toBe(false);
  });

  it("shares + a call BELOW the threshold stays amplified", () => {
    // 2 x 100 x 0.50 x $100 = $10,000 of amplifier on a $10,000 share core
    const r = classifyBook(
      new Map([group("ZZA", false, [inst({ securityId: 1, exposure: 10000 }), deepCall({ delta: 0.5, exposure: 10000 })])]),
    );
    const pair = r.pairs[0];
    expect(pair.classification).toBe("amplified");
    expect(pair.coreExposure).toBe(10000);
    expect(pair.amplifierExposure).toBe(10000);
    expect(pair.hasAmplifiers).toBe(true);
  });

  it("shares + one deep call + one shallow call: only the deep one joins core", () => {
    const shallow = deepCall({ securityId: 4, symbol: "ZZA   270115C00110000", delta: 0.3, quantity: 1, exposure: 3000 });
    const r = classifyBook(
      new Map([group("ZZA", false, [inst({ securityId: 1, exposure: 10000 }), deepCall(), shallow])]),
    );
    const pair = r.pairs[0];
    expect(pair.coreExposure).toBe(28000);
    expect(pair.amplifierExposure).toBe(3000);
    expect(pair.classification).toBe("amplified");
  });

  it("a SHORT call never counts as core, however deep", () => {
    // Short 2 calls at delta 0.90: 2 x 100 x 0.90 x $100 = -$18,000 exposure.
    // With a put (-$4,000) and no shares the group is options-only and net
    // bearish (-22,000): one standalone row, never a hedged pair.
    const shortCall = deepCall({ quantity: -2, exposure: -18000 });
    const r = classifyBook(new Map([group("ZZA", false, [shortCall, put()])]));
    expect(r.pairs).toHaveLength(0);
    expect(r.standaloneBets).toHaveLength(1);
    expect(r.standaloneBets[0].exposure).toBe(-22000);
  });

  it("a short deep call written against shares stays a hedge of the shares (covered call)", () => {
    const shortCall = deepCall({ quantity: -1, exposure: -9000 });
    const r = classifyBook(new Map([group("ZZA", false, [inst({ securityId: 1, exposure: 10000 }), shortCall])]));
    const pair = r.pairs[0];
    expect(pair.classification).toBe("hedged_long");
    expect(pair.coreExposure).toBe(10000);
    expect(pair.offsetCredited).toBe(9000);
  });

  it("a deep call held against SHORT shares stays the hedge of the short, not core", () => {
    // Short 200 shares x $100 = -$20,000; the call's +$18,000 offsets 90%.
    const r = classifyBook(
      new Map([group("ZZA", false, [inst({ securityId: 1, quantity: -200, exposure: -20000, marketValue: -20000 }), deepCall()])]),
    );
    const pair = r.pairs[0];
    expect(pair.classification).toBe("hedged_short");
    expect(pair.coreExposure).toBe(-20000);
    expect(pair.offsetCredited).toBe(18000);
    expect(pair.coveragePct).toBeCloseTo(0.9, 10);
  });

  it("a lone deep call is an unhedged stock-equivalent holding, not a speculative option", () => {
    const r = classifyBook(new Map([group("ZZA", false, [deepCall()])]));
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0].classification).toBe("unhedged");
    expect(r.pairs[0].coreExposure).toBe(18000);
  });

  it("on an ETF, the put hedges the deep call first and only the excess is portfolio protection", () => {
    // Core 18,000 (call). 3 puts at -0.80 = -24,000: 18,000 credited to the
    // pair, 6,000 spills to portfolio protection.
    const r = classifyBook(
      new Map([
        group("ZZE", true, [
          deepCall({ underlying: "ZZE", underlyingIsEtf: true }),
          put({ underlying: "ZZE", underlyingIsEtf: true, quantity: 3, exposure: -24000, delta: -0.8 }),
        ]),
      ]),
    );
    expect(r.pairs[0].classification).toBe("hedged_long");
    expect(r.pairs[0].offsetCredited).toBe(18000);
    expect(r.proxyCandidates).toHaveLength(1);
    expect(r.proxyCandidates[0].source).toBe("tier1_spill");
    expect(r.proxyCandidates[0].protectiveNotional).toBe(6000);
  });
});

describe("classifyBook — an options-only name nets into one row", () => {
  it("put + out-of-the-money call, net bullish: one speculative row carrying both legs", () => {
    // 5 calls at delta 0.30: 5 x 100 x 0.30 x $100 = +$15,000.
    // 1 put at -0.40: -$4,000. Net = +$11,000.
    const otmCall = deepCall({ delta: 0.3, quantity: 5, exposure: 15000 });
    const r = classifyBook(new Map([group("ZZA", false, [otmCall, put()])]));

    expect(r.standaloneBets).toHaveLength(0);
    expect(r.pairs).toHaveLength(1);
    const pair = r.pairs[0];
    expect(pair.classification).toBe("speculative");
    expect(pair.netExposure).toBe(11000);
    expect(pair.coreExposure).toBe(0);
    expect(pair.offsetCredited).toBe(0);
    expect(pair.coveragePct).toBeNull();
    expect(pair.instruments.map((i) => i.securityId).sort()).toEqual([2, 3]);
  });

  it("put + out-of-the-money call, net bearish: one standalone row carrying both legs", () => {
    // 1 call at delta 0.20: +$2,000. 1 put at -0.40: -$4,000. Net = -$2,000.
    const otmCall = deepCall({ delta: 0.2, quantity: 1, exposure: 2000 });
    const r = classifyBook(new Map([group("ZZA", false, [otmCall, put()])]));

    expect(r.pairs).toHaveLength(0);
    expect(r.standaloneBets).toHaveLength(1);
    const bet = r.standaloneBets[0];
    expect(bet.kind).toBe("single_name_put");
    expect(bet.exposure).toBe(-2000);
    expect(bet.instruments.map((i) => i.securityId).sort()).toEqual([2, 3]);
  });

  it("a put alone is still a standalone bet for its full exposure", () => {
    const r = classifyBook(new Map([group("ZZA", false, [put()])]));
    expect(r.standaloneBets).toHaveLength(1);
    expect(r.standaloneBets[0].exposure).toBe(-4000);
    expect(r.pairs).toHaveLength(0);
  });

  it("an ETF's puts with no core stay portfolio protection in full (unchanged)", () => {
    const otmCall = deepCall({ underlying: "ZZE", underlyingIsEtf: true, delta: 0.3, quantity: 5, exposure: 15000 });
    const r = classifyBook(
      new Map([group("ZZE", true, [otmCall, put({ underlying: "ZZE", underlyingIsEtf: true })])]),
    );
    expect(r.proxyCandidates).toHaveLength(1);
    expect(r.proxyCandidates[0].source).toBe("no_core_etf");
    expect(r.proxyCandidates[0].protectiveNotional).toBe(4000);
    expect(r.standaloneBets).toHaveLength(0);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0].classification).toBe("speculative");
    expect(r.pairs[0].netExposure).toBe(15000);
  });
});

// ─── Orchestrator, against the rows the app's writers produce ────────

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedStock(symbol: string, price: number | null, type = "Stock"): number {
  const r = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, sector, geography, currency)
       VALUES (?, ?, ?, 'Technology', 'US', 'USD')`,
    )
    .run(symbol, `${symbol} Corp`, type);
  const id = r.lastInsertRowid as number;
  if (price !== null) seedPrice(id, price);
  return id;
}

function seedOption(
  underlying: string,
  optionType: "CALL" | "PUT",
  strike: number,
  expiration: string,
  price: number | null,
): number {
  const tag = expiration.replace(/-/g, "").slice(2);
  const occStrike = String(strike * 1000).padStart(8, "0");
  const symbol = `${underlying.padEnd(6, " ")}${tag}${optionType === "CALL" ? "C" : "P"}${occStrike}`;
  const r = db
    .prepare(
      `INSERT INTO securities
        (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier, currency)
       VALUES (?, ?, 'Option', ?, ?, ?, ?, 100, 'USD')`,
    )
    .run(symbol, symbol, underlying, optionType, strike, expiration);
  const id = r.lastInsertRowid as number;
  if (price !== null) seedPrice(id, price);
  return id;
}

function seedHolding(accountId: number, securityId: number, qty: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, '2026-07-01')",
  ).run(accountId, securityId, qty, qty * 100);
}

function seedPrice(securityId: number, price: number) {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-07-01', 'test')",
  ).run(securityId, price);
}

describe("computeDefenseAnalysis — deep call as core", () => {
  let acctA: number;
  let acctB: number;
  let expiry: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    acctA = seedAccount("Account A");
    acctB = seedAccount("Account B");
    expiry = addDays(todayET(), 180);
  });

  /**
   * ZZA at $100. A $60-strike call priced at $43 (intrinsic $40 + $3 time
   * value) solves to a real implied volatility; its delta is far above 0.80.
   * A $95-strike put priced at $5 also solves; its delta is around -0.3.
   */
  function seedDeepCallAndPut(callAccount: number, putAccount: number, callPrice: number | null = 43) {
    seedStock("ZZA", 100);
    const callId = seedOption("ZZA", "CALL", 60, expiry, callPrice);
    const putId = seedOption("ZZA", "PUT", 95, expiry, 5);
    seedHolding(callAccount, callId, 2);
    seedHolding(putAccount, putId, 1);
    return { callId, putId };
  }

  function greeksOf(securityId: number) {
    const pos = computePortfolioGreeks(db).positions.find((p) => p.securityId === securityId)!;
    return pos.greeks!;
  }

  it("put + deep call (real implied volatility): hedged pair, one row, no standalone bet, put scored as a hedge", () => {
    const { callId, putId } = seedDeepCallAndPut(acctA, acctA);
    const callGreeks = greeksOf(callId);
    const putGreeks = greeksOf(putId);
    expect(callGreeks.ivSource).toBe("computed");
    expect(callGreeks.delta).toBeGreaterThanOrEqual(0.8);

    const result = computeDefenseAnalysis(db, [acctA]);

    expect(result.standaloneBets).toHaveLength(0);
    expect(result.rankedExposures.filter((r) => r.underlying === "ZZA")).toHaveLength(1);
    const pair = result.pairs.find((p) => p.underlying === "ZZA")!;
    expect(pair.classification).toBe("hedged_long");
    // core = 2 contracts x 100 x delta x $100
    const expectedCore = 2 * 100 * callGreeks.delta * 100;
    expect(pair.coreExposure).toBeCloseTo(expectedCore, 6);
    // 2 calls at delta >= 0.80 are at least 160 share-equivalents = $16,000
    expect(pair.coreExposure).toBeGreaterThanOrEqual(16000);
    // the put offsets 1 x 100 x |delta| x $100
    const expectedOffset = Math.abs(1 * 100 * putGreeks.delta * 100);
    expect(pair.offsetCredited).toBeCloseTo(expectedOffset, 6);
    expect(pair.coveragePct).toBeCloseTo(expectedOffset / expectedCore, 6);

    // Summary: the put's credit is now protection.
    expect(result.summary.protectiveNotional).toBeCloseTo(expectedOffset, 6);
    expect(result.summary.protectionRatio).toBeCloseTo(expectedOffset / expectedCore, 6);
    expect(result.summary.hedgeCount).toBe(1);
    expect(result.hedgeScores[0].securityId).toBe(putId);
    expect(result.hedgeScores[0].protectedNotional).toBeCloseTo(expectedOffset, 6);

    const row = result.rankedExposures.find((r) => r.underlying === "ZZA")!;
    expect(row.classification).toBe("hedged_long");
    expect(row.tier1CoveragePct).toBeCloseTo(expectedOffset / expectedCore, 6);
    // the volatility source is carried onto the instrument
    expect(pair.instruments.find((i) => i.securityId === callId)!.ivSource).toBe("computed");
  });

  it("the same call with no option price (assumed volatility) is not stock: one row, nothing protected, reason on the row", () => {
    const { callId } = seedDeepCallAndPut(acctA, acctA, null);
    const callGreeks = greeksOf(callId);
    expect(callGreeks.ivSource).toBe("default");
    // The assumed-volatility delta WOULD have qualified...
    expect(callGreeks.delta).toBeGreaterThanOrEqual(0.8);

    const result = computeDefenseAnalysis(db, [acctA]);

    // ...but it is not counted.
    expect(result.pairs.some((p) => p.classification === "hedged_long")).toBe(false);
    expect(result.summary.protectiveNotional).toBe(0);
    expect(result.summary.hedgeCount).toBe(0);
    const rows = result.rankedExposures.filter((r) => r.underlying === "ZZA");
    expect(rows).toHaveLength(1);
    expect(rows[0].classification).toBe("speculative");
    expect(rows[0].notes).toContain(ASSUMED_VOL_NOT_STOCK_NOTE);
    // both legs are carried for display
    expect(rows[0].legs?.map((l) => l.optionType).sort()).toEqual(["CALL", "PUT"]);
  });

  it("put + out-of-the-money call: one netted options-only row, % of book from the net delta exposure", () => {
    seedStock("ZZA", 100);
    // $130-strike call (far out of the money) and a $95 put, both priced.
    const callId = seedOption("ZZA", "CALL", 130, expiry, 1);
    const putId = seedOption("ZZA", "PUT", 95, expiry, 5);
    seedHolding(acctA, callId, 1);
    seedHolding(acctA, putId, 1);
    const callExposure = 1 * 100 * greeksOf(callId).delta * 100;
    const putExposure = 1 * 100 * greeksOf(putId).delta * 100;
    expect(greeksOf(callId).delta).toBeLessThan(0.8);
    const net = callExposure + putExposure;

    const result = computeDefenseAnalysis(db, [acctA]);

    const rows = result.rankedExposures.filter((r) => r.underlying === "ZZA");
    expect(rows).toHaveLength(1);
    expect(rows[0].netExposure).toBeCloseTo(net, 6);
    // long book = the call's positive exposure only
    expect(rows[0].pctOfBook).toBeCloseTo(Math.abs(net) / callExposure, 6);
    expect(rows[0].legs).toHaveLength(2);
    // exactly one of the two lists carries the name
    const asPair = result.pairs.filter((p) => p.underlying === "ZZA").length;
    const asBet = result.standaloneBets.filter((b) => b.underlying === "ZZA").length;
    expect(asPair + asBet).toBe(1);
    expect(net < 0 ? asBet : asPair).toBe(1);
    expect(result.summary.protectiveNotional).toBe(0);
  });

  it("shares + deep call + put: core includes both", () => {
    const { callId } = seedDeepCallAndPut(acctA, acctA);
    const zza = (db.prepare("SELECT id FROM securities WHERE symbol = 'ZZA'").get() as { id: number }).id;
    seedHolding(acctA, zza, 100); // 100 shares x $100 = $10,000

    const result = computeDefenseAnalysis(db, [acctA]);
    const pair = result.pairs.find((p) => p.underlying === "ZZA")!;
    const callPart = 2 * 100 * greeksOf(callId).delta * 100;
    expect(pair.classification).toBe("hedged_long");
    expect(pair.coreExposure).toBeCloseTo(10000 + callPart, 6);
    expect(pair.stockEquivalentExposure).toBeCloseTo(callPart, 6);
    expect(pair.hasAmplifiers).toBe(false);
  });

  it("call in one account, put in another: a hedge only in a scope that holds both", () => {
    const { callId, putId } = seedDeepCallAndPut(acctA, acctB);

    const both = computeDefenseAnalysis(db, [acctA, acctB]);
    const pair = both.pairs.find((p) => p.underlying === "ZZA")!;
    expect(pair.classification).toBe("hedged_long");
    expect(both.standaloneBets).toHaveLength(0);
    expect(both.hedgeScores.map((h) => h.securityId)).toEqual([putId]);

    const all = computeDefenseAnalysis(db);
    expect(all.pairs.find((p) => p.underlying === "ZZA")!.classification).toBe("hedged_long");

    // Account A alone: the call is an unhedged stock-equivalent holding.
    const onlyA = computeDefenseAnalysis(db, [acctA]);
    expect(onlyA.pairs.find((p) => p.underlying === "ZZA")!.classification).toBe("unhedged");
    expect(onlyA.summary.protectiveNotional).toBe(0);

    // Account B alone: the put has nothing to hedge there.
    const onlyB = computeDefenseAnalysis(db, [acctB]);
    expect(onlyB.pairs.find((p) => p.underlying === "ZZA")).toBeUndefined();
    expect(onlyB.standaloneBets).toHaveLength(1);
    expect(onlyB.standaloneBets[0].kind).toBe("single_name_put");
    void callId;
  });

  it("the same call held in two accounts: core is the sum of both accounts' contracts", () => {
    const { callId } = seedDeepCallAndPut(acctA, acctA);
    seedHolding(acctB, callId, 3); // 2 in A + 3 in B = 5 contracts

    const result = computeDefenseAnalysis(db, [acctA, acctB]);
    const pair = result.pairs.find((p) => p.underlying === "ZZA")!;
    const delta = greeksOf(callId).delta;
    // 5 contracts x 100 x delta x $100
    expect(pair.coreExposure).toBeCloseTo(5 * 100 * delta * 100, 6);
    // contract-weighted delta of two accounts holding the same contract is that contract's delta
    expect(pair.instruments.find((i) => i.securityId === callId)!.delta).toBeCloseTo(delta, 10);
  });

  it("a short deep call is ignored for core: a put beside it is still a standalone bet", () => {
    seedStock("ZZA", 100);
    const callId = seedOption("ZZA", "CALL", 60, expiry, 43);
    const putId = seedOption("ZZA", "PUT", 95, expiry, 5);
    seedHolding(acctA, callId, -2);
    seedHolding(acctA, putId, 1);

    const result = computeDefenseAnalysis(db, [acctA]);
    expect(result.pairs.find((p) => p.underlying === "ZZA")).toBeUndefined();
    expect(result.standaloneBets).toHaveLength(1);
    expect(result.rankedExposures.filter((r) => r.underlying === "ZZA")).toHaveLength(1);
    expect(result.summary.protectiveNotional).toBe(0);
  });
});
