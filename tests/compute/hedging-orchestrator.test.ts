import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { todayET, addDays } from "@/lib/calendar/date-utils";

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

interface SeedSecurityOpts {
  type?: string;
  underlyingSymbol?: string | null;
  optionType?: "CALL" | "PUT" | null;
  strikePrice?: number | null;
  expirationDate?: string | null;
  multiplier?: number;
  sector?: string | null;
  geography?: string | null;
  currency?: string;
}

function seedSecurity(symbol: string, opts: SeedSecurityOpts = {}): number {
  const r = db
    .prepare(
      `INSERT INTO securities
        (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier, sector, geography, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      `${symbol} Corp`,
      opts.type ?? "Stock",
      opts.underlyingSymbol ?? null,
      opts.optionType ?? null,
      opts.strikePrice ?? null,
      opts.expirationDate ?? null,
      opts.multiplier ?? 1,
      opts.sector ?? null,
      opts.geography ?? null,
      opts.currency ?? "USD"
    );
  return r.lastInsertRowid as number;
}

function seedHolding(accountId: number, securityId: number, qty: number, asOfDate = "2026-07-01") {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, ?)"
  ).run(accountId, securityId, qty, qty * 100, asOfDate);
}

function seedPrice(securityId: number, price: number, date = "2026-07-01") {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, price, date);
}

function daysFromNow(days: number): string {
  return addDays(todayET(), days);
}

describe("computeDefenseAnalysis", () => {
  let accountA: number;
  let accountB: number;
  let msftId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    accountA = seedAccount("Account A");
    accountB = seedAccount("Account B");

    const expiry180 = daysFromNow(180);
    const expiryTag = expiry180.replace(/-/g, "").slice(2);

    // 100 sh MSFT @ $500
    msftId = seedSecurity("MSFT", { type: "Stock", sector: "Technology", geography: "US" });
    seedHolding(accountA, msftId, 100);
    seedPrice(msftId, 500);

    // 2 MSFT puts, strike 400, expiry +180d, multiplier 100, option price $10
    const msftPutId = seedSecurity(`MSFT  ${expiryTag}P00400000`, {
      type: "Option",
      underlyingSymbol: "MSFT",
      optionType: "PUT",
      strikePrice: 400,
      expirationDate: expiry180,
      multiplier: 100,
    });
    seedHolding(accountA, msftPutId, 2);
    seedPrice(msftPutId, 10);

    // MTUM: no shares held, just a price for the option's underlying valuation
    const mtumId = seedSecurity("MTUM", { type: "ETF" });
    seedPrice(mtumId, 220);

    // 3 MTUM puts, strike 200, expiry +180d, multiplier 100
    const mtumPutId = seedSecurity(`MTUM  ${expiryTag}P00200000`, {
      type: "Option",
      underlyingSymbol: "MTUM",
      optionType: "PUT",
      strikePrice: 200,
      expirationDate: expiry180,
      multiplier: 100,
    });
    seedHolding(accountA, mtumPutId, 3);
    seedPrice(mtumPutId, 5);

    // -80 sh PAYC in account B (naked short, no options)
    const paycId = seedSecurity("PAYC", { type: "Stock" });
    seedHolding(accountB, paycId, -80);
    seedPrice(paycId, 200);
  });

  it("builds MSFT hedged_long, MTUM proxy via assumed beta, and PAYC naked_short, with a positive protection ratio", () => {
    const result = computeDefenseAnalysis(db);

    expect(result.summary.protectionRatio).not.toBeNull();
    expect(result.summary.protectionRatio!).toBeGreaterThan(0);

    const msftPair = result.pairs.find((p) => p.underlying === "MSFT");
    expect(msftPair).toBeDefined();
    expect(msftPair!.classification).toBe("hedged_long");

    const mtumProxy = result.proxies.find((p) => p.underlying === "MTUM");
    expect(mtumProxy).toBeDefined();
    expect(mtumProxy!.route).toBe("beta");
    expect(mtumProxy!.betaSource).toBe("assumed");
    expect(
      result.diagnostics.some((d) => d.kind === "assumed_beta" && d.symbol === "MTUM")
    ).toBe(true);

    const paycBet = result.standaloneBets.find((b) => b.underlying === "PAYC");
    expect(paycBet).toBeDefined();
    expect(paycBet!.kind).toBe("naked_short");
  });

  it("scoping to account A excludes PAYC from standaloneBets and from summary.shortExposure", () => {
    const all = computeDefenseAnalysis(db);
    const scoped = computeDefenseAnalysis(db, [accountA]);

    expect(all.standaloneBets.find((b) => b.underlying === "PAYC")).toBeDefined();
    expect(scoped.standaloneBets.find((b) => b.underlying === "PAYC")).toBeUndefined();

    // Excluding PAYC's negative exposure makes shortExposure less negative (i.e. greater).
    expect(scoped.summary.shortExposure).toBeGreaterThan(all.summary.shortExposure);
  });

  it("scales MSFT's core exposure by the FX rate when its currency is foreign", () => {
    const before = computeDefenseAnalysis(db);
    const msftPairBefore = before.pairs.find((p) => p.underlying === "MSFT")!;
    expect(msftPairBefore.coreExposure).toBeCloseTo(50000, 2);

    db.prepare("UPDATE securities SET currency = 'KRW' WHERE id = ?").run(msftId);
    db.prepare(
      "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('KRW', 0.0007, '2026-07-01', 'test')"
    ).run();

    const after = computeDefenseAnalysis(db);
    const msftPairAfter = after.pairs.find((p) => p.underlying === "MSFT")!;

    expect(msftPairAfter.coreExposure).toBeCloseTo(msftPairBefore.coreExposure * 0.0007, 2);
  });

  it("excludes the opposing CALL from an etf_negative_stack candidate's hedge-book rows and never over-scores its credited notional", () => {
    // Short 100 sh IWM (ETF) + 3 protective puts (same-sign as the short) +
    // 1 opposing CALL that partially offsets the short — the CALL must not
    // get a hedgeScores row, and the sum of what DOES get scored for this
    // candidate must not exceed the credited protectiveNotional.
    const expiry180 = daysFromNow(180);
    const expiryTag = expiry180.replace(/-/g, "").slice(2);

    const iwmId = seedSecurity("IWM", { type: "ETF" });
    seedHolding(accountA, iwmId, -100);
    seedPrice(iwmId, 220);

    const iwmPutId = seedSecurity(`IWM   ${expiryTag}P00200000`, {
      type: "Option",
      underlyingSymbol: "IWM",
      optionType: "PUT",
      strikePrice: 200,
      expirationDate: expiry180,
      multiplier: 100,
    });
    seedHolding(accountA, iwmPutId, 3);
    seedPrice(iwmPutId, 5);

    const iwmCallId = seedSecurity(`IWM   ${expiryTag}C00230000`, {
      type: "Option",
      underlyingSymbol: "IWM",
      optionType: "CALL",
      strikePrice: 230,
      expirationDate: expiry180,
      multiplier: 100,
    });
    seedHolding(accountA, iwmCallId, 1);
    seedPrice(iwmCallId, 4);

    const result = computeDefenseAnalysis(db, [accountA]);

    expect(result.pairs.find((p) => p.underlying === "IWM")).toBeUndefined();
    const proxy = result.proxies.find((p) => p.underlying === "IWM");
    expect(proxy).toBeDefined();

    // The call never earns a hedge-book row.
    expect(result.hedgeScores.find((h) => h.securityId === iwmCallId)).toBeUndefined();

    // Everything scored for this candidate (core short + puts) sums to no
    // more than the credited protectiveNotional (the call's offset already
    // reduced what's credited via coreRemainder).
    const scoredForCandidate = result.hedgeScores
      .filter((h) => h.underlying === "IWM")
      .reduce((a, h) => a + h.protectedNotional, 0);
    expect(scoredForCandidate).toBeLessThanOrEqual(proxy!.protectiveNotional + 0.01);
  });

  it("surfaces a greeks_fallback diagnostic when an option's underlying has no price to compute Greeks", () => {
    const badUnderlyingId = seedSecurity("BADU", { type: "Stock" });
    // Deliberately NOT calling seedPrice(badUnderlyingId, ...) — the Greeks
    // engine can't solve without an underlying price ("no_underlying_price").
    void badUnderlyingId;
    const expiry90 = daysFromNow(90);
    const badPutSymbol = `BADU  ${expiry90.replace(/-/g, "").slice(2)}P00050000`;
    const badPutId = seedSecurity(badPutSymbol, {
      type: "Option",
      underlyingSymbol: "BADU",
      optionType: "PUT",
      strikePrice: 50,
      expirationDate: expiry90,
      multiplier: 100,
    });
    seedHolding(accountA, badPutId, 2);

    const result = computeDefenseAnalysis(db, [accountA]);

    expect(
      result.diagnostics.some((d) => d.kind === "greeks_fallback" && d.symbol === badPutSymbol)
    ).toBe(true);
  });
});

describe("computeDefenseAnalysis — held-sibling display labels", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("labels a BRK/B holding as BRK/B, never the internal family key BRK A", () => {
    const acct = seedAccount("Taxable");
    const brkb = seedSecurity("BRK/B", { sector: "Financials" });
    seedHolding(acct, brkb, 116);
    seedPrice(brkb, 500);

    const result = computeDefenseAnalysis(db);
    const labels = [
      ...result.pairs.map((p) => p.underlying),
      ...result.standaloneBets.map((b) => b.underlying),
      ...result.rankedExposures.map((r) => r.underlying),
      ...result.hedgeScores.map((h) => h.underlying),
      ...result.hedgeScores.map((h) => h.protects),
      ...result.proxies.map((p) => p.underlying),
    ];
    expect(labels).toContain("BRK/B");
    expect(labels).not.toContain("BRK A");
  });

  it("a hedge on one sibling still groups with the core but shows the held share class", () => {
    const acct = seedAccount("Taxable");
    const goog = seedSecurity("GOOG", { sector: "Communication Services" });
    seedHolding(acct, goog, 100);
    seedPrice(goog, 200);
    // Put on the GOOGL sibling — same issuer family, must pair with GOOG core
    const expiry = daysFromNow(120);
    const put = seedSecurity(`GOOGL ${expiry.replace(/-/g, "").slice(2)}P00190000`, {
      type: "Option",
      underlyingSymbol: "GOOGL",
      optionType: "PUT",
      strikePrice: 190,
      expirationDate: expiry,
      multiplier: 100,
    });
    seedHolding(acct, put, 1);
    seedPrice(put, 5);

    const result = computeDefenseAnalysis(db);
    // Family grouping preserved: exactly one exposure row for the family...
    const famRows = result.rankedExposures.filter((r) =>
      ["GOOG", "GOOGL", "GOOG/GOOGL"].includes(r.underlying),
    );
    expect(famRows).toHaveLength(1);
    // ...and its label leads with the actually-held GOOG share class.
    expect(famRows[0].underlying).toContain("GOOG");
    expect(famRows[0].underlying).not.toBe("GOOGL");
  });
});

describe("computeDefenseAnalysis — expired option exclusion", () => {
  // A lapsed contract must never render as a live hedge: the SQL universe
  // pull used `date('now', '-1 day')`, a slip copied from
  // purgeExpiredOptionHoldings's DELETE grace window (lib/mutations/expired-
  // options.ts) into what should have been a strict "expiring today or
  // later" read-time filter. That let a QQQ put that expired yesterday still
  // render "Runway -1d" / an "expiring" badge and still count toward
  // PROTECTION RATIO. See lib/compute/option-expiry.ts.
  let acct: number;
  let msft: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    acct = seedAccount("Taxable");
    msft = seedSecurity("MSFT", { type: "Stock", sector: "Technology", geography: "US" });
    seedHolding(acct, msft, 100);
    seedPrice(msft, 500);
  });

  function seedMsftPut(expirationDate: string) {
    const tag = expirationDate.replace(/-/g, "").slice(2);
    const putId = seedSecurity(`MSFT  ${tag}P00400000`, {
      type: "Option",
      underlyingSymbol: "MSFT",
      optionType: "PUT",
      strikePrice: 400,
      expirationDate,
      multiplier: 100,
    });
    seedHolding(acct, putId, 2);
    seedPrice(putId, 10);
    return putId;
  }

  it("keeps an option expiring TODAY live: hedged pair, positive protection ratio, no negative runway", () => {
    const putId = seedMsftPut(todayET());

    const result = computeDefenseAnalysis(db, [acct]);

    const pair = result.pairs.find((p) => p.underlying === "MSFT");
    expect(pair?.classification).toBe("hedged_long");
    expect(result.summary.protectionRatio).toBeGreaterThan(0);

    const score = result.hedgeScores.find((h) => h.securityId === putId);
    expect(score).toBeDefined();
    expect(score!.runwayDays).not.toBeNull();
    expect(score!.runwayDays!).toBeGreaterThanOrEqual(0);
  });

  it("excludes an option that expired YESTERDAY from pairs, hedgeScores, and protection ratio", () => {
    const yesterday = addDays(todayET(), -1);
    const putId = seedMsftPut(yesterday);

    const result = computeDefenseAnalysis(db, [acct]);

    // No opposing option survives the filter — MSFT's core reverts to unhedged.
    const pair = result.pairs.find((p) => p.underlying === "MSFT");
    expect(pair?.classification).toBe("unhedged");

    // The expired put must never surface in the hedge book...
    expect(result.hedgeScores.find((h) => h.securityId === putId)).toBeUndefined();
    // ...nor anywhere in the ranked exposures / proxies as a live position.
    expect(result.rankedExposures.some((r) => r.securityId === putId)).toBe(false);

    // ...and it must not inflate PROTECTION RATIO.
    expect(result.summary.protectionRatio).toBe(0);

    // No hedge score anywhere renders a negative runway.
    for (const score of result.hedgeScores) {
      expect(score.runwayDays === null || score.runwayDays >= 0).toBe(true);
    }
  });

  it("a non-option holding (no expiration_date) is unaffected by the expiry filter", () => {
    // MSFT itself carries no expiration_date; confirm the IS NULL branch of
    // the shared predicate keeps it regardless of any expired option noise.
    seedMsftPut(addDays(todayET(), -1)); // dead weight, should not affect MSFT core

    const result = computeDefenseAnalysis(db, [acct]);
    const pair = result.pairs.find((p) => p.underlying === "MSFT");
    expect(pair).toBeDefined();
    expect(pair!.coreExposure).toBeCloseTo(50000, 2);
  });
});
