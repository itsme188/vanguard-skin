import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyBook,
  computeGapGuardedBeta,
  resolveProxyBeta,
  attributeProxies,
  type DefenseInstrument,
  type UnderlyingGroup,
  type AttributionContext,
  type ProxyCandidate,
} from "@/lib/compute/hedging";
import { runMigrations } from "@/lib/db/migrate";

function inst(over: Partial<DefenseInstrument>): DefenseInstrument {
  return {
    securityId: 1,
    symbol: "TEST",
    underlying: "TEST",
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

describe("classifyBook — Tier 1 pairs", () => {
  it("classifies long stock + puts as hedged_long with capped coverage", () => {
    const r = classifyBook(new Map([group("MSFT", false, [
      inst({ securityId: 1, symbol: "MSFT", exposure: 20000 }),
      inst({ securityId: 2, symbol: "MSFT  270115P00400000", isOption: true, optionType: "PUT", quantity: 2, exposure: -8000, marketValue: 3000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "MSFT")!;
    expect(pair.classification).toBe("hedged_long");
    expect(pair.coreExposure).toBe(20000);
    expect(pair.offsetCredited).toBe(8000);
    expect(pair.coveragePct).toBeCloseTo(0.4);
    expect(pair.netExposure).toBe(12000);
  });

  it("classifies short stock + long call as hedged_short", () => {
    const r = classifyBook(new Map([group("PAYC", false, [
      inst({ securityId: 1, symbol: "PAYC", quantity: -80, exposure: -12000, marketValue: -12000 }),
      inst({ securityId: 2, symbol: "PAYC  260116C00200000", isOption: true, optionType: "CALL", quantity: 1, exposure: 4000, marketValue: 1500 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "PAYC")!;
    expect(pair.classification).toBe("hedged_short");
    expect(pair.offsetCredited).toBe(4000);
    expect(pair.coveragePct).toBeCloseTo(4000 / 12000);
  });

  it("flags same-sign options on a long core as amplifiers, not hedges", () => {
    const r = classifyBook(new Map([group("INTC", false, [
      inst({ securityId: 1, symbol: "INTC", exposure: 5000 }),
      inst({ securityId: 2, symbol: "INTC  260320C00030000", isOption: true, optionType: "CALL", quantity: 20, exposure: 15000, marketValue: 6000 }),
      inst({ securityId: 3, symbol: "INTC  260320P00045000", isOption: true, optionType: "PUT", quantity: 4, exposure: -3000, marketValue: 2000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "INTC")!;
    expect(pair.classification).toBe("hedged_long"); // opposing puts exist
    expect(pair.amplifierExposure).toBe(15000);
    expect(pair.hasAmplifiers).toBe(true);
    expect(pair.netExposure).toBe(17000);
  });

  it("caps offset credit at |core| and spills ETF excess to proxy candidates", () => {
    const r = classifyBook(new Map([group("XLE", true, [
      inst({ securityId: 1, symbol: "XLE", exposure: 10000 }),
      inst({ securityId: 2, symbol: "XLE   260116P00080000", isOption: true, optionType: "PUT", quantity: 10, exposure: -16000, marketValue: 5000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "XLE")!;
    expect(pair.offsetCredited).toBe(10000);        // capped
    expect(pair.coveragePct).toBeCloseTo(1.0);
    const spill = r.proxyCandidates.find((c) => c.underlying === "XLE")!;
    expect(spill.protectiveNotional).toBe(6000);    // the excess
    expect(spill.source).toBe("tier1_spill");
  });

  it("routes a short ETF plus same-sign puts entirely to proxy candidates (MAGS case)", () => {
    const r = classifyBook(new Map([group("MAGS", true, [
      inst({ securityId: 1, symbol: "MAGS", quantity: -300, exposure: -15000, marketValue: -15000 }),
      inst({ securityId: 2, symbol: "MAGS  260116P00050000", isOption: true, optionType: "PUT", quantity: 10, exposure: -9000, marketValue: 4000 }),
    ])]));
    expect(r.pairs.find((p) => p.underlying === "MAGS")).toBeUndefined();
    const c = r.proxyCandidates.find((c) => c.underlying === "MAGS")!;
    expect(c.protectiveNotional).toBe(24000);       // short shares + puts
    expect(c.source).toBe("etf_negative_stack");
  });

  it("routes ETF puts with no core to proxy candidates", () => {
    const r = classifyBook(new Map([group("MTUM", true, [
      inst({ securityId: 2, symbol: "MTUM  260116P00200000", isOption: true, optionType: "PUT", quantity: 3, exposure: -12000, marketValue: 3500 }),
    ])]));
    expect(r.proxyCandidates.find((c) => c.underlying === "MTUM")!.protectiveNotional).toBe(12000);
  });

  it("classifies single-name puts on non-held stock AND naked single-name shorts as standalone bets", () => {
    const r = classifyBook(new Map([
      group("RGTI", false, [
        inst({ securityId: 2, symbol: "RGTI  260116P00010000", isOption: true, optionType: "PUT", quantity: 20, exposure: -5000, marketValue: 2500 }),
      ]),
      group("AMD", false, [
        inst({ securityId: 3, symbol: "AMD", quantity: -20, exposure: -3000, marketValue: -3000 }),
      ]),
    ]));
    expect(r.standaloneBets).toHaveLength(2);
    expect(r.pairs.find((p) => p.underlying === "AMD")).toBeUndefined();
    expect(r.proxyCandidates).toHaveLength(0);
  });

  it("classifies naked long calls as speculative pairs (risk, never protection)", () => {
    const r = classifyBook(new Map([group("FROG", false, [
      inst({ securityId: 2, symbol: "FROG  260116C00040000", isOption: true, optionType: "CALL", quantity: 4, exposure: 7000, marketValue: 2000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "FROG")!;
    expect(pair.classification).toBe("speculative");
    expect(pair.netExposure).toBe(7000);
  });

  it("classifies plain long stock with no options as unhedged", () => {
    const r = classifyBook(new Map([group("XOM", false, [
      inst({ securityId: 1, symbol: "XOM", exposure: 11000 }),
    ])]));
    expect(r.pairs.find((p) => p.underlying === "XOM")!.classification).toBe("unhedged");
  });
});

function dailySeries(start: string, closes: number[]): Array<{ date: string; close: number }> {
  const out: Array<{ date: string; close: number }> = [];
  const d = new Date(start + "T00:00:00Z");
  for (const close of closes) {
    out.push({ date: d.toISOString().slice(0, 10), close });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("computeGapGuardedBeta", () => {
  it("computes ~2.0 beta for a 2x levered series", () => {
    const bench = dailySeries("2026-06-01", [100, 101, 99.9, 101.5, 100.8, 102, 101.2, 103, 102.1, 104]);
    const sec = dailySeries("2026-06-01", bench.map((b, i) => 100 * Math.pow(b.close / 100, 2)));
    const beta = computeGapGuardedBeta(sec, bench.slice());
    expect(beta).not.toBeNull();
    expect(beta!).toBeGreaterThan(1.6);
    expect(beta!).toBeLessThan(2.4);
  });

  it("drops return pairs spanning a >7 calendar-day gap", () => {
    // Two dense clusters separated by a 9-month hole; the cross-gap pair
    // would inject a giant fake return (the NFLX β=-14.31 failure mode).
    const a = dailySeries("2025-06-01", [100, 101, 100.5, 101.2, 100.9, 101.8]);
    const b = dailySeries("2026-03-27", [50, 50.4, 50.1, 50.8, 50.5, 51]).map((r) => ({ ...r }));
    const bench = [...dailySeries("2025-06-01", [400, 402, 401, 403, 402, 404]), ...dailySeries("2026-03-27", [500, 502, 501, 504, 502, 505])];
    const beta = computeGapGuardedBeta([...a, ...b], bench);
    expect(beta).not.toBeNull();
    expect(Math.abs(beta!)).toBeLessThan(5); // sane despite the -50% "day"
  });

  it("returns null with fewer than 6 usable return pairs", () => {
    expect(computeGapGuardedBeta(dailySeries("2026-06-01", [100, 101, 102]), dailySeries("2026-06-01", [400, 401, 402]))).toBeNull();
  });
});

describe("resolveProxyBeta", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("prefers the cached security_betas row", () => {
    db.prepare(`INSERT INTO securities (symbol, name, security_type, source_key) VALUES ('MTUM','MTUM','ETF','t:MTUM')`).run();
    const sid = (db.prepare(`SELECT id FROM securities WHERE symbol='MTUM'`).get() as { id: number }).id;
    db.prepare(`INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, 60, 1.42, datetime('now'))`).run(sid);
    expect(resolveProxyBeta(db, "MTUM")).toEqual({ beta: 1.42, source: "cached" });
  });

  it("falls back to assumed 1.0 when nothing is available", () => {
    expect(resolveProxyBeta(db, "ZZZQ")).toEqual({ beta: 1.0, source: "assumed" });
  });

  const SPY_CLOSES = [100, 101, 99.9, 101.5, 100.8, 102, 101.2, 103, 102.1, 104];

  function seedSpyBenchmark() {
    for (const row of dailySeries("2026-06-01", SPY_CLOSES)) {
      db.prepare(
        `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`
      ).run(row.date, row.close);
    }
  }

  function insertSecurity(symbol: string): number {
    db.prepare(
      `INSERT INTO securities (symbol, name, security_type, source_key) VALUES (?, ?, 'ETF', ?)`
    ).run(symbol, symbol, `t:${symbol}`);
    return (db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(symbol) as { id: number }).id;
  }

  it("computes beta from prices + benchmark_prices when there is no cached row (computed tier)", () => {
    seedSpyBenchmark();
    const sid = insertSecurity("XLE");
    // 2x-levered mover vs SPY (same construction as computeGapGuardedBeta's 2x test).
    const sec = dailySeries("2026-06-01", SPY_CLOSES.map((c) => 100 * Math.pow(c / 100, 2)));
    for (const row of sec) {
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(
        sid,
        row.date,
        row.close
      );
    }
    const result = resolveProxyBeta(db, "XLE");
    expect(result.source).toBe("computed");
    expect(result.beta).toBeGreaterThan(1.6);
    expect(result.beta).toBeLessThan(2.4);
  });

  it("prefers the prices-table close over a near-identical (~3bp offset) benchmark_prices duplicate on the same date", () => {
    seedSpyBenchmark();
    const sid = insertSecurity("DIA");
    const clean = dailySeries("2026-06-01", SPY_CLOSES); // clean 1x mover vs SPY
    for (const row of clean) {
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(
        sid,
        row.date,
        row.close
      );
    }
    // Same symbol, same dates, near-identical closes (few-bp source discrepancy) in benchmark_prices too.
    for (const row of clean) {
      db.prepare(
        `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('DIA', ?, ?, 'tws')`
      ).run(row.date, row.close * 1.0003);
    }
    const result = resolveProxyBeta(db, "DIA");
    expect(result.source).toBe("computed");
    expect(Number.isFinite(result.beta)).toBe(true);
    expect(result.beta).toBeGreaterThan(0.5);
    expect(result.beta).toBeLessThan(1.5);
  });

  it("prefers the prices-table close over a byte-identical benchmark_prices duplicate on the same date", () => {
    seedSpyBenchmark();
    const sid = insertSecurity("DIA");
    const clean = dailySeries("2026-06-01", SPY_CLOSES); // clean 1x mover vs SPY
    for (const row of clean) {
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(
        sid,
        row.date,
        row.close
      );
    }
    // Same symbol, same dates, byte-identical closes duplicated into benchmark_prices.
    for (const row of clean) {
      db.prepare(
        `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('DIA', ?, ?, 'tws')`
      ).run(row.date, row.close);
    }
    const result = resolveProxyBeta(db, "DIA");
    expect(result.source).toBe("computed");
    expect(Number.isFinite(result.beta)).toBe(true);
    expect(result.beta).toBeGreaterThan(0.5);
    expect(result.beta).toBeLessThan(1.5);
  });
});

function ctx(over: Partial<AttributionContext> = {}): AttributionContext {
  return {
    sectorWeights: new Map(),
    etfGeography: new Map(),
    longExposureBySector: new Map([["Technology", 100000], ["Financials", 40000]]),
    longExposureByGeography: new Map([["Europe", 20000]]),
    tier1CreditedBySector: new Map(),
    totalLongExposure: 200000,
    resolveBeta: () => ({ beta: 1.0, source: "assumed" as const }),
    ...over,
  };
}

function cand(underlying: string, notional: number): ProxyCandidate {
  return { underlying, protectiveNotional: notional, source: "no_core_etf", instruments: [] };
}

describe("attributeProxies — Tier 2 cascade", () => {
  it("routes via cached sector weights and builds sector coverage", () => {
    const r = attributeProxies([cand("IGV", 10000)], ctx({
      sectorWeights: new Map([["IGV", [{ sector: "Technology", weight_pct: 90 }, { sector: "Communication Services", weight_pct: 10 }]]]),
    }));
    expect(r.proxies[0].route).toBe("sector");
    expect(r.proxies[0].creditedTo).toEqual([
      { bucket: "Technology", credited: 9000 },
      { bucket: "Communication Services", credited: 1000 },
    ]);
    const tech = r.sectorCoverage.find((s) => s.sector === "Technology")!;
    expect(tech.longExposure).toBe(100000);
    expect(tech.protected).toBe(9000);
    expect(tech.coveragePct).toBeCloseTo(0.09);
  });

  it("routes country ETFs via geography when no sector weights", () => {
    const r = attributeProxies([cand("EWG", 5000)], ctx({
      etfGeography: new Map([["EWG", "Europe"]]),
    }));
    expect(r.proxies[0].route).toBe("geography");
    expect(r.proxies[0].creditedTo).toEqual([{ bucket: "Europe", credited: 5000 }]);
  });

  it("falls back to beta-weighted broad-book credit and carries the beta source", () => {
    const r = attributeProxies([cand("MTUM", 10000)], ctx({
      resolveBeta: () => ({ beta: 1.2, source: "cached" as const }),
    }));
    expect(r.proxies[0].route).toBe("beta");
    expect(r.proxies[0].creditedTo).toEqual([{ bucket: "book", credited: 12000 }]);
    expect(r.proxies[0].betaSource).toBe("cached");
  });

  it("includes tier-1 credits in sector coverage", () => {
    const r = attributeProxies([], ctx({
      tier1CreditedBySector: new Map([["Financials", 8000]]),
    }));
    const fin = r.sectorCoverage.find((s) => s.sector === "Financials")!;
    expect(fin.protected).toBe(8000);
    expect(fin.coveragePct).toBeCloseTo(0.2);
  });
});
