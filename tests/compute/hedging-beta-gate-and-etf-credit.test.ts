import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import {
  computeDefenseAnalysis,
  computeGapGuardedBetaStats,
  resolveProxyBeta,
} from "@/lib/compute/hedging";
import { MIN_BETA_PAIRS } from "@/lib/compute/beta-confidence";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// F1: a proxy hedge's computed fallback beta goes through the house
// confidence gate (betaConfidenceVerdict: r² ≥ 0.10 and ≥ 30 return pairs).
// A slope from a handful of return pairs used to be credited as fact.
//
// F2: a Tier-1 hedge on an ETF is credited across the ETF's look-through
// sectors, the same way the ETF's long exposure is spread, not 100% to the
// ETF's single securities.sector.

let db: Database.Database;

function dailySeries(start: string, closes: number[]): Array<{ date: string; close: number }> {
  const d = new Date(start + "T00:00:00Z");
  return closes.map((close) => {
    const row = { date: d.toISOString().slice(0, 10), close };
    d.setUTCDate(d.getUTCDate() + 1);
    return row;
  });
}

/** Deterministic wiggle around 100, n closes. */
function benchCloses(n: number): number[] {
  const out: number[] = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    c *= 1 + 0.01 * Math.sin(i * 1.7) + 0.004 * Math.cos(i * 0.9);
    out.push(c);
  }
  return out;
}

function insertSecurity(symbol: string, type = "ETF", sector: string | null = null): number {
  const r = db
    .prepare(`INSERT INTO securities (symbol, name, security_type, sector, source_key) VALUES (?, ?, ?, ?, ?)`)
    .run(symbol, symbol, type, sector, `t:${symbol}`);
  return r.lastInsertRowid as number;
}

function seedSpy(closes: number[]) {
  for (const row of dailySeries("2026-06-01", closes)) {
    db.prepare(`INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`).run(
      row.date,
      row.close,
    );
  }
}

function seedPrices(sid: number, closes: number[]) {
  for (const row of dailySeries("2026-06-01", closes)) {
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(
      sid,
      row.date,
      row.close,
    );
  }
}

describe("proxy beta confidence gate (F1)", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("computeGapGuardedBetaStats reports the pair count and r²", () => {
    const bench = dailySeries("2026-06-01", benchCloses(41));
    const sec = bench.map((b) => ({ date: b.date, close: 100 * Math.pow(b.close / 100, 2) }));
    const stats = computeGapGuardedBetaStats(sec, bench);
    expect(stats).not.toBeNull();
    expect(stats!.pairs).toBe(40);
    expect(stats!.beta).toBeCloseTo(2, 6);
    expect(stats!.rSquared).toBeCloseTo(1, 6);
  });

  it("a newly listed fund with only a few return pairs is UNMEASURED, never credited at its noisy slope (ruling 19 = B)", () => {
    const spy = benchCloses(9); // 8 return pairs
    seedSpy(spy);
    const sid = insertSecurity("ZZN");
    // A steep 4x mover: the old path published beta ≈ 4.
    seedPrices(sid, spy.map((c) => 100 * Math.pow(c / 100, 4)));
    expect(resolveProxyBeta(db, "ZZN")).toEqual({ beta: null, source: "unmeasured", reason: "no_history" });
  });

  it("a fund with enough pairs but no market fit (r² < 0.10) is UNMEASURED (ruling 19 = B)", () => {
    const spy = benchCloses(MIN_BETA_PAIRS + 11);
    seedSpy(spy);
    const sid = insertSecurity("ZZR");
    // A return series uncorrelated with the benchmark's.
    let c = 50;
    const own = spy.map((_, i) => (c *= 1 + 0.01 * Math.sin(i * 5.3 + 2) * Math.cos(i * 0.31)));
    seedPrices(sid, own);
    const stats = computeGapGuardedBetaStats(dailySeries("2026-06-01", own), dailySeries("2026-06-01", spy));
    expect(stats!.pairs).toBeGreaterThanOrEqual(MIN_BETA_PAIRS);
    expect(stats!.rSquared).toBeLessThan(0.1);
    expect(resolveProxyBeta(db, "ZZR")).toEqual({ beta: null, source: "unmeasured", reason: "low_fit" });
  });

  it("a fund past both gates keeps its computed beta", () => {
    const spy = benchCloses(MIN_BETA_PAIRS + 11);
    seedSpy(spy);
    const sid = insertSecurity("ZZG");
    seedPrices(sid, spy.map((c) => 100 * Math.pow(c / 100, 2)));
    const r = resolveProxyBeta(db, "ZZG");
    expect(r.source).toBe("computed");
    expect(r.beta).toBeCloseTo(2, 4);
  });
});

describe("Tier-1 ETF hedge credited by look-through sectors (F2)", () => {
  let acct: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("INSERT INTO accounts (name) VALUES ('Taxable')").run();
    acct = (db.prepare("SELECT id FROM accounts WHERE name='Taxable'").get() as { id: number }).id;

    // A broad fund whose own securities.sector says Technology, but whose
    // look-through is 60% Technology / 40% Financials.
    const etf = insertSecurity("ZZE", "ETF", "Technology");
    db.prepare("INSERT INTO etf_sector_weights VALUES ('ZZE','Technology',60,'2026-06-08','manual')").run();
    db.prepare("INSERT INTO etf_sector_weights VALUES ('ZZE','Financials',40,'2026-06-08','manual')").run();
    db.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, 100, 10000, '2026-07-01')").run(acct, etf);
    db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 100, '2026-07-01', 'test')").run(etf);

    const expiry = addDays(todayET(), 180);
    const tag = expiry.replace(/-/g, "").slice(2);
    const put = db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier, sector)
         VALUES (?, 'ZZE put', 'Option', 'ZZE', 'PUT', 95, ?, 100, 'Technology')`,
      )
      .run(`ZZE   ${tag}P00095000`, expiry).lastInsertRowid as number;
    db.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, 1, 300, '2026-07-01')").run(acct, put);
    db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 4, '2026-07-01', 'test')").run(put);
  });

  it("spreads the pair's credited offset across the fund's sectors, conserving the total", () => {
    const r = computeDefenseAnalysis(db, [acct]);
    const pair = r.pairs.find((p) => p.underlying === "ZZE");
    expect(pair?.classification).toBe("hedged_long");
    expect(pair!.offsetCredited).toBeGreaterThan(0);

    const tech = r.sectorCoverage.find((s) => s.sector === "Technology")!;
    const fin = r.sectorCoverage.find((s) => s.sector === "Financials")!;
    expect(fin.protected).toBeGreaterThan(0);
    expect(tech.protected).toBeCloseTo(pair!.offsetCredited * 0.6, 6);
    expect(fin.protected).toBeCloseTo(pair!.offsetCredited * 0.4, 6);
    // Same coverage in both sectors: the hedge sits on the whole fund.
    expect(tech.coveragePct!).toBeCloseTo(fin.coveragePct!, 6);

    // Conservation: the sectors carry exactly the credited protection.
    const total = r.sectorCoverage.reduce((a, s) => a + s.protected, 0);
    expect(total).toBeCloseTo(pair!.offsetCredited, 6);
  });

  it("a single stock's pair still credits its own sector", () => {
    const stock = insertSecurity("ZZS", "Stock", "Energy");
    db.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, 100, 5000, '2026-07-01')").run(acct, stock);
    db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 50, '2026-07-01', 'test')").run(stock);
    const expiry = addDays(todayET(), 180);
    const tag = expiry.replace(/-/g, "").slice(2);
    const put = db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier, sector)
         VALUES (?, 'ZZS put', 'Option', 'ZZS', 'PUT', 48, ?, 100, 'Energy')`,
      )
      .run(`ZZS   ${tag}P00048000`, expiry).lastInsertRowid as number;
    db.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, 1, 200, '2026-07-01')").run(acct, put);
    db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 2, '2026-07-01', 'test')").run(put);

    const r = computeDefenseAnalysis(db, [acct]);
    const pair = r.pairs.find((p) => p.underlying === "ZZS")!;
    expect(pair.offsetCredited).toBeGreaterThan(0);
    const energy = r.sectorCoverage.find((s) => s.sector === "Energy")!;
    expect(energy.protected).toBeCloseTo(pair.offsetCredited, 6);
  });
});
