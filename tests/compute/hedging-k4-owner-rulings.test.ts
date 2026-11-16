import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import {
  attributeProxies,
  classifyBook,
  computeDefenseAnalysis,
  proxyFundVerdict,
  ASSUMED_PROXY_BETA,
  type AttributionContext,
  type DefenseInstrument,
  type ProxyCandidate,
  type UnderlyingGroup,
} from "@/lib/compute/hedging";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// Owner rulings of 2026-11-15 on the Defense tab (unit K4):
//  K4a  a call that hedges a SHORT is reported on its own and left out of the
//       protection ratio, which measures protection of the LONG book.
//  K4b  a fund with no look-through uses its own sector at a measured beta; a
//       commodity or other non-equity fund is "not credited"; an unknown type
//       fails closed.
//  K4c  every assumed beta says so.
//  K4e  a short with puts on the same name is not "naked"; short rows show no
//       long-sector cover.

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

let db: Database.Database;
let acct: number;

interface SecOpts {
  type?: string;
  sector?: string | null;
  fundCategory?: string | null;
  assetClass?: string | null;
  geography?: string | null;
}

function sec(symbol: string, o: SecOpts = {}): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, sector, fund_category, asset_class, geography, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(symbol, symbol, o.type ?? "Stock", o.sector ?? null, o.fundCategory ?? null, o.assetClass ?? null, o.geography ?? null, `t:${symbol}`)
    .lastInsertRowid as number;
}

function hold(sid: number, qty: number, price: number) {
  db.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, '2026-07-01')").run(
    acct,
    sid,
    qty,
    qty * price
  );
  db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-07-01', 'test')").run(sid, price);
}

function option(under: string, type: "PUT" | "CALL", strike: number, qty: number, price: number): number {
  const expiry = addDays(todayET(), 180);
  const tag = expiry.replace(/-/g, "").slice(2);
  const sid = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, 'Option', ?, ?, ?, ?, 100)`
    )
    .run(`${under.padEnd(6)}${tag}${type[0]}${String(strike * 1000).padStart(8, "0")}`, `${under} ${type}`, under, type, strike, expiry)
    .lastInsertRowid as number;
  hold(sid, qty, price);
  return sid;
}

function fresh() {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('Taxable')").run();
  acct = (db.prepare("SELECT id FROM accounts WHERE name='Taxable'").get() as { id: number }).id;
}

describe("K4a: a call that hedges a short is not long-book protection", () => {
  beforeEach(() => {
    fresh();
    // Long book: 100 ZZL at 100 with one put against it.
    const zzl = sec("ZZL", { sector: "Technology" });
    hold(zzl, 100, 100);
    option("ZZL", "PUT", 90, 1, 3);
    // Short book: -100 ZZS at 50 with one long call against it.
    const zzs = sec("ZZS", { sector: "Energy" });
    hold(zzs, -100, 50);
    option("ZZS", "CALL", 55, 1, 2);
  });

  it("splits the credit: protection ratio = long-side protection / long exposure; conservation with the short-side figure", () => {
    const r = computeDefenseAnalysis(db, [acct]);
    const longPair = r.pairs.find((p) => p.underlying === "ZZL")!;
    const shortPair = r.pairs.find((p) => p.underlying === "ZZS")!;
    expect(longPair.classification).toBe("hedged_long");
    expect(shortPair.classification).toBe("hedged_short");
    expect(shortPair.offsetCredited).toBeGreaterThan(0);

    const s = r.summary;
    expect(s.shortSideHedgeNotional).toBeCloseTo(shortPair.offsetCredited, 9);
    expect(s.protectiveNotional).toBeCloseTo(longPair.offsetCredited, 9);
    // Old figure (every pair's credit) = new long-side + short-side.
    const oldProtective = sum(r.pairs.map((p) => p.offsetCredited)) + sum(r.proxies.flatMap((p) => p.creditedTo.map((c) => c.credited)));
    expect(s.protectiveNotional + s.shortSideHedgeNotional).toBeCloseTo(oldProtective, 9);
    expect(s.protectionRatio).toBeCloseTo(s.protectiveNotional / s.longExposure, 12);
  });

  it("the call's credited delta is out of long exposure and out of the long-sector bars; net = long + short + that delta", () => {
    const r = computeDefenseAnalysis(db, [acct]);
    const shortPair = r.pairs.find((p) => p.underlying === "ZZS")!;
    const call = shortPair.instruments.find((i) => i.isOption)!;
    const ratio = shortPair.offsetCredited / shortPair.offsetExposure;
    const zzlShares = r.pairs.find((p) => p.underlying === "ZZL")!.instruments.find((i) => !i.isOption)!;

    expect(r.summary.shortSideHedgeExposure).toBeCloseTo(call.exposure * ratio, 9);
    expect(r.summary.longExposure).toBeCloseTo(zzlShares.exposure + call.exposure * (1 - ratio), 9);
    expect(r.summary.netExposure).toBeCloseTo(
      r.summary.longExposure + r.summary.shortExposure + r.summary.shortSideHedgeExposure,
      9
    );
    const energy = r.sectorCoverage.find((x) => x.sector === "Energy");
    expect(energy?.protected ?? 0).toBe(0);
    expect(energy?.longExposure ?? 0).toBeCloseTo(call.exposure * (1 - ratio), 9);
  });

  it("the call's hedge row is marked short-side; the short row shows no long-sector cover", () => {
    const r = computeDefenseAnalysis(db, [acct]);
    const callScore = r.hedgeScores.find((h) => h.underlying === "ZZS")!;
    const putScore = r.hedgeScores.find((h) => h.underlying === "ZZL")!;
    expect(callScore.side).toBe("short");
    expect(putScore.side).toBe("long");
    expect(r.summary.shortSideHedgeCount).toBe(1);
    const shortRow = r.rankedExposures.find((x) => x.underlying === "ZZS")!;
    expect(shortRow.sectorProxyCoveragePct).toBeNull();
  });
});

describe("K4b: a fund with no look-through", () => {
  beforeEach(() => {
    fresh();
    const zzl = sec("ZZL", { sector: "Healthcare" });
    hold(zzl, 100, 100);
    const zzh = sec("ZZH", { type: "ETF", sector: "Healthcare", assetClass: "equity" });
    db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 100, '2026-07-01', 'test')").run(zzh);
    db.prepare("INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, 60, 1.25, datetime('now'))").run(zzh);
    option("ZZH", "PUT", 95, 1, 3);
    const zzc = sec("ZZC", { type: "ETF", sector: "Energy", fundCategory: "Commodities (Oil)", geography: "Global" });
    db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 80, '2026-07-01', 'test')").run(zzc);
    option("ZZC", "PUT", 75, 2, 3);
    const zzu = sec("ZZU", { type: "ETF", sector: "Technology" });
    db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 40, '2026-07-01', 'test')").run(zzu);
    option("ZZU", "PUT", 38, 1, 2);
  });

  it("an equity fund with its own sector is credited to that sector at its measured beta", () => {
    const r = computeDefenseAnalysis(db, [acct]);
    const p = r.proxies.find((x) => x.underlying === "ZZH")!;
    expect(p.route).toBe("own_sector");
    expect(p.betaSource).toBe("cached");
    expect(p.creditedTo).toEqual([{ bucket: "Healthcare", credited: expect.closeTo(p.protectiveNotional * 1.25, 6) }]);
    const hc = r.sectorCoverage.find((x) => x.sector === "Healthcare")!;
    expect(hc.protected).toBeCloseTo(p.protectiveNotional * 1.25, 6);
  });

  it("a commodity fund and a fund of unknown type are not credited, listed with a reason, and counted", () => {
    const r = computeDefenseAnalysis(db, [acct]);
    const c = r.proxies.find((x) => x.underlying === "ZZC")!;
    const u = r.proxies.find((x) => x.underlying === "ZZU")!;
    expect(c.route).toBe("not_credited");
    expect(u.route).toBe("not_credited");
    expect(c.creditedTo).toEqual([]);
    expect(u.creditedTo).toEqual([]);
    expect(r.notCreditedHedges.map((n) => n.underlying).sort()).toEqual(["ZZC", "ZZU"]);
    expect(r.notCreditedHedges.find((n) => n.underlying === "ZZC")!.reason).toMatch(/commodit/i);
    expect(r.notCreditedHedges.find((n) => n.underlying === "ZZU")!.reason).toMatch(/unknown/i);
    expect(r.summary.notCreditedCount).toBe(2);
    // Nothing from them reaches the ratio, the bars or the hedge book.
    const h = r.proxies.find((x) => x.underlying === "ZZH")!;
    expect(r.summary.protectiveNotional).toBeCloseTo(sum(h.creditedTo.map((x) => x.credited)), 9);
    expect(r.sectorCoverage.find((x) => x.sector === "Energy")?.protected ?? 0).toBe(0);
    expect(r.hedgeScores.some((x) => x.underlying === "ZZC" || x.underlying === "ZZU")).toBe(false);
  });
});

describe("proxyFundVerdict (K4b, one reader)", () => {
  it("commodity and bond categories are not equity protection; leveraged funds keep the old path", () => {
    expect(proxyFundVerdict({ fundCategory: "Commodities (Oil)", assetClass: "equity", sector: "Energy", leveraged: false }).kind).toBe(
      "not_credited"
    );
    expect(proxyFundVerdict({ fundCategory: "Commodity", assetClass: null, sector: null, leveraged: false }).kind).toBe("not_credited");
    expect(proxyFundVerdict({ fundCategory: "US Treasury", assetClass: null, sector: null, leveraged: false }).kind).toBe("not_credited");
    expect(proxyFundVerdict({ fundCategory: "Leveraged/Inverse (Commodities)", assetClass: null, sector: null, leveraged: true }).kind).toBe(
      "unchanged"
    );
  });
  it("equity evidence with a GICS sector routes to that sector; without one, to the book; no evidence fails closed", () => {
    expect(proxyFundVerdict({ fundCategory: null, assetClass: "equity", sector: "information technology", leveraged: false })).toEqual({
      kind: "equity",
      ownSector: "Technology",
    });
    expect(proxyFundVerdict({ fundCategory: "US Large Cap Equity", assetClass: null, sector: "Diversified", leveraged: false })).toEqual({
      kind: "equity",
      ownSector: null,
    });
    expect(proxyFundVerdict({ fundCategory: null, assetClass: null, sector: "Energy", leveraged: false }).kind).toBe("not_credited");
  });
});

function ctx(over: Partial<AttributionContext> = {}): AttributionContext {
  return {
    sectorWeights: new Map(),
    etfGeography: new Map(),
    longExposureBySector: new Map([["Energy", 50000]]),
    longExposureByGeography: new Map([["Global", 50000]]),
    tier1CreditedBySector: new Map(),
    totalLongExposure: 100000,
    resolveBeta: () => ({ beta: ASSUMED_PROXY_BETA, source: "assumed" as const }),
    ...over,
  };
}
const cand = (underlying: string, notional: number): ProxyCandidate => ({
  underlying,
  protectiveNotional: notional,
  source: "no_core_etf",
  instruments: [],
});

describe("attributeProxies: a commodity fund never takes the geography route", () => {
  it("is not credited even when its geography is held", () => {
    let betaCalls = 0;
    const r = attributeProxies(
      [cand("ZZC", 1000)],
      ctx({
        etfGeography: new Map([["ZZC", "Global"]]),
        fundIdentityByUnderlying: new Map([["ZZC", { fundCategory: "Commodities (Oil)", assetClass: null, sector: "Energy", leveraged: false }]]),
        resolveBeta: () => {
          betaCalls++;
          return { beta: 1, source: "cached" as const };
        },
      })
    );
    expect(r.proxies[0].route).toBe("not_credited");
    expect(betaCalls).toBe(0);
    expect(r.sectorCoverage.every((s) => s.protected === 0)).toBe(true);
  });
});

describe("attributeProxies: an own-sector credit never covers a sector past 100%", () => {
  it("credits the sector up to its unprotected long exposure and the rest to the whole book", () => {
    const r = attributeProxies(
      [cand("ZZX", 8000)],
      ctx({
        longExposureBySector: new Map([["Energy", 5000]]),
        tier1CreditedBySector: new Map([["Energy", 1000]]),
        fundIdentityByUnderlying: new Map([["ZZX", { fundCategory: null, assetClass: "equity", sector: "Energy", leveraged: false }]]),
        resolveBeta: () => ({ beta: 1.5, source: "cached" as const }),
      })
    );
    expect(r.proxies[0].route).toBe("own_sector");
    expect(r.proxies[0].creditedTo).toEqual([
      { bucket: "Energy", credited: 4000 },
      { bucket: "book", credited: 8000 },
    ]);
    const energy = r.sectorCoverage.find((x) => x.sector === "Energy")!;
    expect(energy.coveragePct).toBeCloseTo(1, 12);
  });
});

describe("K4c: an assumed beta says so", () => {
  beforeEach(() => {
    fresh();
    const zzl = sec("ZZL", { sector: "Healthcare" });
    hold(zzl, 100, 100);
    const zzk = sec("ZZK", { type: "ETF", assetClass: "equity" });
    db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 100, '2026-07-01', 'test')").run(zzk);
    option("ZZK", "PUT", 95, 1, 3);
  });

  it("the row's route text carries 'assumed' and the summary counts it", () => {
    const r = computeDefenseAnalysis(db, [acct]);
    const p = r.proxies.find((x) => x.underlying === "ZZK")!;
    expect(p.route).toBe("beta");
    expect(p.betaSource).toBe("assumed");
    const row = r.hedgeScores.find((h) => h.underlying === "ZZK")!;
    expect(row.protects).toMatch(/assumed/);
    expect(row.betaAssumed).toBe(true);
    expect(r.summary.assumedBetaHedgeCount).toBe(1);
  });
});

describe("K4e: a short with puts on the same name", () => {
  const inst = (o: Partial<DefenseInstrument>): DefenseInstrument => ({
    securityId: 1,
    symbol: "ZZP",
    underlying: "ZZP",
    isOption: false,
    optionType: null,
    quantity: 0,
    exposure: 0,
    marketValue: 0,
    underlyingIsEtf: false,
    sector: "Technology",
    geography: null,
    greeksAvailable: false,
    ...o,
  });
  it("is not labelled a naked short", () => {
    const g: UnderlyingGroup = {
      underlying: "ZZP",
      underlyingIsEtf: false,
      instruments: [
        inst({ securityId: 1, quantity: -100, exposure: -5000 }),
        inst({ securityId: 2, symbol: "ZZP P", isOption: true, optionType: "PUT", quantity: 1, exposure: -2000 }),
      ],
    };
    const r = classifyBook(new Map([["ZZP", g]]));
    expect(r.standaloneBets).toHaveLength(1);
    expect(r.standaloneBets[0].kind).toBe("short_with_bearish_options");
    expect(r.standaloneBets[0].notes?.join(" ")).toMatch(/nothing protects against a rally/);
  });
  it("short shares alone stay a naked short", () => {
    const g: UnderlyingGroup = {
      underlying: "ZZP",
      underlyingIsEtf: false,
      instruments: [inst({ securityId: 1, quantity: -100, exposure: -5000 })],
    };
    expect(classifyBook(new Map([["ZZP", g]])).standaloneBets[0].kind).toBe("naked_short");
  });
});
