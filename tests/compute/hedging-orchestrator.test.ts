import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, vi } from "vitest";
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
  let zzaId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    accountA = seedAccount("Account A");
    accountB = seedAccount("Account B");

    const expiry180 = daysFromNow(180);
    const expiryTag = expiry180.replace(/-/g, "").slice(2);

    // 100 sh ZZA @ $500
    zzaId = seedSecurity("ZZA", { type: "Stock", sector: "Technology", geography: "US" });
    seedHolding(accountA, zzaId, 100);
    seedPrice(zzaId, 500);

    // 2 ZZA puts, strike 400, expiry +180d, multiplier 100, option price $10
    const zzaPutId = seedSecurity(`ZZA   ${expiryTag}P00400000`, {
      type: "Option",
      underlyingSymbol: "ZZA",
      optionType: "PUT",
      strikePrice: 400,
      expirationDate: expiry180,
      multiplier: 100,
    });
    seedHolding(accountA, zzaPutId, 2);
    seedPrice(zzaPutId, 10);

    // ZZM: no shares held, just a price for the option's underlying valuation
    const zzmId = seedSecurity("ZZM", { type: "ETF" });
    seedPrice(zzmId, 220);

    // 4 ZZM puts, strike 200, expiry +180d, multiplier 100
    const zzmPutId = seedSecurity(`ZZM   ${expiryTag}P00200000`, {
      type: "Option",
      underlyingSymbol: "ZZM",
      optionType: "PUT",
      strikePrice: 200,
      expirationDate: expiry180,
      multiplier: 100,
    });
    seedHolding(accountA, zzmPutId, 4);
    seedPrice(zzmPutId, 5);

    // -60 sh ZZB in account B (naked short, no options)
    const zzbId = seedSecurity("ZZB", { type: "Stock" });
    seedHolding(accountB, zzbId, -60);
    seedPrice(zzbId, 200);
  });

  it("builds ZZA hedged_long, ZZM proxy via assumed beta, and ZZB naked_short, with a positive protection ratio", () => {
    const result = computeDefenseAnalysis(db);

    expect(result.summary.protectionRatio).not.toBeNull();
    expect(result.summary.protectionRatio!).toBeGreaterThan(0);

    const zzaPair = result.pairs.find((p) => p.underlying === "ZZA");
    expect(zzaPair).toBeDefined();
    expect(zzaPair!.classification).toBe("hedged_long");

    const zzmProxy = result.proxies.find((p) => p.underlying === "ZZM");
    expect(zzmProxy).toBeDefined();
    expect(zzmProxy!.route).toBe("beta");
    expect(zzmProxy!.betaSource).toBe("assumed");
    expect(
      result.diagnostics.some((d) => d.kind === "assumed_beta" && d.symbol === "ZZM")
    ).toBe(true);

    const zzbBet = result.standaloneBets.find((b) => b.underlying === "ZZB");
    expect(zzbBet).toBeDefined();
    expect(zzbBet!.kind).toBe("naked_short");
  });

  it("scoping to account A excludes ZZB from standaloneBets and from summary.shortExposure", () => {
    const all = computeDefenseAnalysis(db);
    const scoped = computeDefenseAnalysis(db, [accountA]);

    expect(all.standaloneBets.find((b) => b.underlying === "ZZB")).toBeDefined();
    expect(scoped.standaloneBets.find((b) => b.underlying === "ZZB")).toBeUndefined();

    // Excluding ZZB's negative exposure makes shortExposure less negative (i.e. greater).
    expect(scoped.summary.shortExposure).toBeGreaterThan(all.summary.shortExposure);
  });

  it("scales ZZA's core exposure by the FX rate when its currency is foreign", () => {
    const before = computeDefenseAnalysis(db);
    const zzaPairBefore = before.pairs.find((p) => p.underlying === "ZZA")!;
    expect(zzaPairBefore.coreExposure).toBeCloseTo(50000, 2);

    db.prepare("UPDATE securities SET currency = 'KRW' WHERE id = ?").run(zzaId);
    db.prepare(
      "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('KRW', 0.0007, '2026-07-01', 'test')"
    ).run();

    const after = computeDefenseAnalysis(db);
    const zzaPairAfter = after.pairs.find((p) => p.underlying === "ZZA")!;

    expect(zzaPairAfter.coreExposure).toBeCloseTo(zzaPairBefore.coreExposure * 0.0007, 2);
  });

  it("excludes the opposing CALL from an etf_negative_stack candidate's hedge-book rows and never over-scores its credited notional", () => {
    // Short 100 sh ZZQ (ETF) + 3 protective puts (same-sign as the short) +
    // 1 opposing CALL that partially offsets the short — the CALL must not
    // get a hedgeScores row, and the sum of what DOES get scored for this
    // candidate must not exceed the credited protectiveNotional.
    const expiry180 = daysFromNow(180);
    const expiryTag = expiry180.replace(/-/g, "").slice(2);

    const zzqId = seedSecurity("ZZQ", { type: "ETF" });
    seedHolding(accountA, zzqId, -100);
    seedPrice(zzqId, 220);

    const zzqPutId = seedSecurity(`ZZQ   ${expiryTag}P00200000`, {
      type: "Option",
      underlyingSymbol: "ZZQ",
      optionType: "PUT",
      strikePrice: 200,
      expirationDate: expiry180,
      multiplier: 100,
    });
    seedHolding(accountA, zzqPutId, 3);
    seedPrice(zzqPutId, 5);

    const zzqCallId = seedSecurity(`ZZQ   ${expiryTag}C00230000`, {
      type: "Option",
      underlyingSymbol: "ZZQ",
      optionType: "CALL",
      strikePrice: 230,
      expirationDate: expiry180,
      multiplier: 100,
    });
    seedHolding(accountA, zzqCallId, 1);
    seedPrice(zzqCallId, 4);

    const result = computeDefenseAnalysis(db, [accountA]);

    expect(result.pairs.find((p) => p.underlying === "ZZQ")).toBeUndefined();
    const proxy = result.proxies.find((p) => p.underlying === "ZZQ");
    expect(proxy).toBeDefined();

    // The call never earns a hedge-book row.
    expect(result.hedgeScores.find((h) => h.securityId === zzqCallId)).toBeUndefined();

    // Everything scored for this candidate (core short + puts) sums to no
    // more than the credited protectiveNotional (the call's offset already
    // reduced what's credited via coreRemainder).
    const scoredForCandidate = result.hedgeScores
      .filter((h) => h.underlying === "ZZQ")
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
    seedHolding(acct, brkb, 100);
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
  // later" read-time filter. That let a put that expired yesterday still
  // render "Runway -1d" / an "expiring" badge and still count toward
  // PROTECTION RATIO. See lib/compute/option-expiry.ts.
  let acct: number;
  let zza: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    acct = seedAccount("Taxable");
    zza = seedSecurity("ZZA", { type: "Stock", sector: "Technology", geography: "US" });
    seedHolding(acct, zza, 100);
    seedPrice(zza, 500);
  });

  function seedZzaPut(expirationDate: string, strike = 400) {
    const tag = expirationDate.replace(/-/g, "").slice(2);
    const occStrike = String(strike * 1000).padStart(8, "0");
    const putId = seedSecurity(`ZZA   ${tag}P${occStrike}`, {
      type: "Option",
      underlyingSymbol: "ZZA",
      optionType: "PUT",
      strikePrice: strike,
      expirationDate,
      multiplier: 100,
    });
    seedHolding(acct, putId, 2);
    seedPrice(putId, 10);
    return putId;
  }

  it("keeps an option expiring TODAY live: hedged pair, positive protection ratio, no negative runway", () => {
    // Two things pin this case to the finance rule rather than the wall clock:
    //  - the Greeks engine treats a same-day contract as live only until the
    //    16:00 ET close (options-greeks.ts::isExpiredAsOf), so freeze "now"
    //    well before it; 12:00 at -05:00 is 13:00 ET in EDT and 12:00 ET in
    //    EST — early afternoon either way. Without freezing, the test flips
    //    after the close.
    //  - with hours to expiry a 20%-OTM put has delta ≈ 0 and, correctly,
    //    hedges nothing — seed an ITM strike so the pair is a real hedge.
    const today = todayET();
    vi.useFakeTimers({ now: new Date(`${today}T12:00:00-05:00`), toFake: ["Date"] });
    try {
      const putId = seedZzaPut(today, 520);

      const result = computeDefenseAnalysis(db, [acct]);

      const pair = result.pairs.find((p) => p.underlying === "ZZA");
      expect(pair?.classification).toBe("hedged_long");
      expect(result.summary.protectionRatio).toBeGreaterThan(0);

      const score = result.hedgeScores.find((h) => h.securityId === putId);
      expect(score).toBeDefined();
      expect(score!.runwayDays).not.toBeNull();
      expect(score!.runwayDays!).toBeGreaterThanOrEqual(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes an option that expired YESTERDAY from pairs, hedgeScores, and protection ratio", () => {
    const yesterday = addDays(todayET(), -1);
    const putId = seedZzaPut(yesterday);

    const result = computeDefenseAnalysis(db, [acct]);

    // No opposing option survives the filter — ZZA's core reverts to unhedged.
    const pair = result.pairs.find((p) => p.underlying === "ZZA");
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
    // ZZA itself carries no expiration_date; confirm the IS NULL branch of
    // the shared predicate keeps it regardless of any expired option noise.
    seedZzaPut(addDays(todayET(), -1)); // dead weight, should not affect ZZA core

    const result = computeDefenseAnalysis(db, [acct]);
    const pair = result.pairs.find((p) => p.underlying === "ZZA");
    expect(pair).toBeDefined();
    expect(pair!.coreExposure).toBeCloseTo(50000, 2);
  });
});
