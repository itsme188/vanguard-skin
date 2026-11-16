import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import {
  attributeProxies,
  resolveProxyBeta,
  NOT_CREDITED_UNKNOWN,
  type AttributionContext,
  type ProxyCandidate,
  type ProxyFundIdentity,
} from "@/lib/compute/hedging";

// Review round 5 (2026-11-15), Defense:
//  R1 an own-sector credit is capped at the sector's room AFTER every
//     look-through and Tier-1 credit, in a fixed order (by underlying), so the
//     result never depends on row order and no bar passes 100%.
//  R2 an assumed beta says WHY it was assumed: too little history, or a
//     measured beta that failed the fit test.
//  R3 an unknown-type fund fails closed on the geography route too.

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const eq = (sector: string | null): ProxyFundIdentity => ({ fundCategory: null, assetClass: "equity", sector, leveraged: false });
const cand = (underlying: string, notional: number): ProxyCandidate => ({
  underlying,
  protectiveNotional: notional,
  source: "no_core_etf",
  instruments: [],
});

function ctx(over: Partial<AttributionContext> = {}): AttributionContext {
  return {
    sectorWeights: new Map([["ZLT", [{ sector: "Energy", weight_pct: 100 }]]]),
    etfGeography: new Map(),
    longExposureBySector: new Map([["Energy", 100], ["Technology", 900]]),
    longExposureByGeography: new Map([["Europe", 500]]),
    tier1CreditedBySector: new Map(),
    totalLongExposure: 1000,
    resolveBeta: (s: string) => (s === "ZAA" ? { beta: 1.2, source: "computed" as const } : { beta: 0.8, source: "computed" as const }),
    fundIdentityByUnderlying: new Map([["ZAA", eq("Energy")], ["ZBB", eq("Energy")]]),
    ...over,
  };
}

const totalCredit = (r: ReturnType<typeof attributeProxies>) =>
  sum(r.proxies.flatMap((p) => p.creditedTo.map((c) => c.credited)));
const byUnderlying = (r: ReturnType<typeof attributeProxies>) =>
  JSON.stringify([...r.proxies].sort((a, b) => a.underlying.localeCompare(b.underlying)));

describe("R1: own-sector credit does not depend on row order", () => {
  it("two own-sector funds on one sector give the same split in either order", () => {
    const ab = attributeProxies([cand("ZAA", 60), cand("ZBB", 80)], ctx());
    const ba = attributeProxies([cand("ZBB", 80), cand("ZAA", 60)], ctx());
    expect(byUnderlying(ab)).toBe(byUnderlying(ba));
    expect(JSON.stringify(ab.sectorCoverage)).toBe(JSON.stringify(ba.sectorCoverage));
    // Total conserved: 60 x 1.2 + 80 x 0.8.
    expect(totalCredit(ab)).toBeCloseTo(136, 9);
    expect(totalCredit(ba)).toBeCloseTo(136, 9);
    const energy = ab.sectorCoverage.find((s) => s.sector === "Energy")!;
    expect(energy.coveragePct).toBeCloseTo(1, 12);
  });

  it("a look-through fund is credited first, whatever the row order: the bar stays at 100%", () => {
    const ownFirst = attributeProxies([cand("ZAA", 60), cand("ZLT", 50)], ctx());
    const ltFirst = attributeProxies([cand("ZLT", 50), cand("ZAA", 60)], ctx());
    expect(byUnderlying(ownFirst)).toBe(byUnderlying(ltFirst));
    for (const r of [ownFirst, ltFirst]) {
      const energy = r.sectorCoverage.find((s) => s.sector === "Energy")!;
      expect(energy.coveragePct).toBeLessThanOrEqual(1 + 1e-12);
      expect(totalCredit(r)).toBeCloseTo(50 + 72, 9);
      const own = r.proxies.find((p) => p.underlying === "ZAA")!;
      expect(own.creditedTo).toEqual([
        { bucket: "Energy", credited: 50 },
        { bucket: "book", credited: 22 },
      ]);
    }
    // Proxies stay in candidate order (index coupling with the candidates).
    expect(ownFirst.proxies.map((p) => p.underlying)).toEqual(["ZAA", "ZLT"]);
    expect(ltFirst.proxies.map((p) => p.underlying)).toEqual(["ZLT", "ZAA"]);
  });

  it("look-through alone past a sector's long exposure caps the bar at 100% and keeps the total, naming the excess", () => {
    const r = attributeProxies([cand("ZLT", 150)], ctx());
    const energy = r.sectorCoverage.find((s) => s.sector === "Energy")!;
    expect(energy.coveragePct).toBe(1);
    expect(energy.protected).toBe(150);
    expect(energy.protectedBeyondExposure).toBe(50);
    expect(totalCredit(r)).toBe(150);
    // An own-sector fund then has no room: all of it goes to the whole book.
    const r2 = attributeProxies([cand("ZAA", 10), cand("ZLT", 150)], ctx());
    expect(r2.proxies.find((p) => p.underlying === "ZAA")!.creditedTo).toEqual([
      { bucket: "Energy", credited: 0 },
      { bucket: "book", credited: 12 },
    ]);
  });

  it("no sector ever passes 100% and every bar under it reports no excess", () => {
    const r = attributeProxies([cand("ZBB", 500), cand("ZLT", 30), cand("ZAA", 40)], ctx({
      tier1CreditedBySector: new Map([["Energy", 20]]),
    }));
    for (const s of r.sectorCoverage) {
      if (s.coveragePct !== null) expect(s.coveragePct).toBeLessThanOrEqual(1 + 1e-12);
    }
    const energy = r.sectorCoverage.find((s) => s.sector === "Energy")!;
    expect(energy.protectedBeyondExposure).toBe(0);
    expect(totalCredit(r)).toBeCloseTo(500 * 0.8 + 30 + 40 * 1.2, 9);
  });
});

describe("R3: an unknown-type fund is never credited through its geography", () => {
  it("fails closed when the type is unknown, even with a held geography", () => {
    const r = attributeProxies([cand("ZEU", 100)], ctx({
      etfGeography: new Map([["ZEU", "Europe"]]),
      fundIdentityByUnderlying: new Map([["ZEU", { fundCategory: null, assetClass: null, sector: null, leveraged: false }]]),
    }));
    expect(r.proxies[0].route).toBe("not_credited");
    expect(r.proxies[0].notCreditedReason).toBe(NOT_CREDITED_UNKNOWN);
    expect(r.proxies[0].creditedTo).toEqual([]);
  });

  it("fails closed when no identity is on file at all", () => {
    const r = attributeProxies([cand("ZEU", 100)], ctx({ etfGeography: new Map([["ZEU", "Europe"]]) }));
    expect(r.proxies[0].route).toBe("not_credited");
  });

  it("an equity fund keeps the geography route at notional x 1", () => {
    const r = attributeProxies([cand("ZEU", 100)], ctx({
      etfGeography: new Map([["ZEU", "Europe"]]),
      fundIdentityByUnderlying: new Map([["ZEU", eq(null)]]),
    }));
    expect(r.proxies[0].route).toBe("geography");
    expect(r.proxies[0].creditedTo).toEqual([{ bucket: "Europe", credited: 100 }]);
  });
});

describe("R2: an assumed beta carries its reason", () => {
  function db(): Database.Database {
    const d = new Database(":memory:");
    runMigrations(d);
    return d;
  }
  const dates = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const t = new Date(Date.UTC(2026, 5, 1) + i * 86_400_000);
      return t.toISOString().slice(0, 10);
    });

  it("too little history: reason no_history", () => {
    const d = db();
    d.prepare("INSERT INTO securities (symbol, name, security_type, source_key) VALUES ('ZQ', 'ZQ', 'ETF', 't:ZQ')").run();
    const r = resolveProxyBeta(d, "ZQ");
    expect(r.source).toBe("assumed");
    expect(r.assumedReason).toBe("no_history");
  });

  it("a measured beta that fails the fit test: reason low_fit", () => {
    const d = db();
    const sid = d
      .prepare("INSERT INTO securities (symbol, name, security_type, source_key) VALUES ('ZQ', 'ZQ', 'ETF', 't:ZQ')")
      .run().lastInsertRowid as number;
    const ds = dates(50);
    // SPY alternates up/down; the fund moves on its own pattern (period 3),
    // so the slope is measured on 49 pairs but explains almost nothing.
    let spy = 100;
    let zq = 100;
    ds.forEach((date, i) => {
      spy *= i % 2 === 0 ? 1.01 : 0.99;
      zq *= i % 3 === 0 ? 1.02 : 0.99;
      d.prepare("INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')").run(date, spy);
      d.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')").run(sid, date, zq);
    });
    const r = resolveProxyBeta(d, "ZQ");
    expect(r.source).toBe("assumed");
    expect(r.assumedReason).toBe("low_fit");
  });
});

describe("R2: the orchestrator carries the assumed-beta reason and the long/short split", () => {
  it("a fit-test failure reads 'assumed, low fit' and is counted apart", async () => {
    const { computeDefenseAnalysis } = await import("@/lib/compute/hedging");
    const { todayET, addDays } = await import("@/lib/calendar/date-utils");
    const d = new Database(":memory:");
    d.pragma("foreign_keys = ON");
    runMigrations(d);
    const acct = d.prepare("INSERT INTO accounts (name) VALUES ('Taxable')").run().lastInsertRowid as number;
    const sec = (symbol: string, type: string, sector: string | null, assetClass: string | null) =>
      d
        .prepare("INSERT INTO securities (symbol, name, security_type, sector, asset_class, source_key) VALUES (?, ?, ?, ?, ?, ?)")
        .run(symbol, symbol, type, sector, assetClass, `t:${symbol}`).lastInsertRowid as number;
    const hold = (sid: number, qty: number, price: number) => {
      d.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, '2026-07-01')").run(acct, sid, qty, qty * price);
    };
    const zzl = sec("ZZL", "Stock", "Healthcare", null);
    hold(zzl, 100, 100);
    d.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 100, '2026-07-01', 'test')").run(zzl);
    const zzk = sec("ZZK", "ETF", null, "equity");
    let spy = 100;
    let zq = 100;
    for (let i = 0; i < 50; i++) {
      const date = new Date(Date.UTC(2026, 4, 1) + i * 86_400_000).toISOString().slice(0, 10);
      spy *= i % 2 === 0 ? 1.01 : 0.99;
      zq *= i % 3 === 0 ? 1.02 : 0.99;
      d.prepare("INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')").run(date, spy);
      d.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')").run(zzk, date, zq);
    }
    const expiry = addDays(todayET(), 180);
    const tag = expiry.replace(/-/g, "").slice(2);
    const put = d
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
         VALUES (?, 'ZZK PUT', 'Option', 'ZZK', 'PUT', ?, ?, 100)`
      )
      .run(`ZZK   ${tag}P00100000`, Math.round(zq), expiry).lastInsertRowid as number;
    hold(put, 1, 3);
    d.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 3, '2026-07-01', 'test')").run(put);

    const r = computeDefenseAnalysis(d, [acct]);
    const p = r.proxies.find((x) => x.underlying === "ZZK")!;
    expect(p.betaSource).toBe("assumed");
    expect(p.assumedBetaReason).toBe("low_fit");
    const row = r.hedgeScores.find((h) => h.underlying === "ZZK")!;
    expect(row.protects).toMatch(/assumed, low fit/);
    expect(row.betaAssumedReason).toBe("low_fit");
    expect(r.summary.assumedBetaHedgeCount).toBe(1);
    expect(r.summary.assumedBetaLowFitCount).toBe(1);
    expect(r.summary.longSideHedgeCount + r.summary.shortSideHedgeCount).toBe(r.summary.hedgeCount);
    expect(r.diagnostics.some((x) => x.kind === "assumed_beta" && /fit test/.test(x.detail))).toBe(true);
  });
});
