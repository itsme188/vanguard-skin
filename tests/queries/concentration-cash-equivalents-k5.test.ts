/**
 * Owner ruling 2026-11-15: cash and cash-equivalent funds matter when
 * analysing a portfolio; leaving them out, or ranking a sweep fund as the
 * book's biggest "position", is wrong.
 *
 * The rule both concentration surfaces now follow:
 *  - every weight stays a share of the WHOLE book, cash included (cash
 *    dilutes concentration);
 *  - cash equivalents (isCashEquivalentSecurity / cashEquivalentSecuritySql)
 *    form ONE "Cash and equivalents" line with its share;
 *  - that line is never in the ranked top-N list and never raises a
 *    single-position warning;
 *  - the Herfindahl sums the squared whole-book weights of the RISKY
 *    positions only (candidate ii): cash is a riskless bucket, so more cash
 *    lowers the index.
 *
 * Synthetic tickers and round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getConcentrationMetrics } from "@/lib/queries/analysis";
import { computeConcentration } from "@/lib/compute/risk";
import { getConcentrationUniverse } from "@/lib/queries/concentration-universe";

let db: Database.Database;
let acct: number;

function seedPosition(
  symbol: string,
  quantity: number,
  price: number,
  opts: { type?: string; category?: string | null } = {},
) {
  const id = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, fund_category, multiplier) VALUES (?, ?, ?, ?, 1)",
    )
    .run(symbol, `${symbol} Test`, opts.type ?? "Stock", opts.category ?? null)
    .lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, '2026-03-02')",
  ).run(acct, id, quantity, Math.abs(quantity * price));
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-03-02', 'test')",
  ).run(id, price);
}

/** A money-market sweep fund, labelled the way the live data labels it. */
function seedSweep(symbol: string, dollars: number) {
  seedPosition(symbol, dollars, 1, { type: "Mutual Fund", category: "Cash Equivalent" });
}

function seedFiveStocks(each: number) {
  for (const s of ["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"]) seedPosition(s, each / 10, 10);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('K5 Test')").run();
  acct = (db.prepare("SELECT id FROM accounts WHERE name = 'K5 Test'").get() as { id: number }).id;
});

describe("a book that is 50% cash and five equal stocks", () => {
  beforeEach(() => {
    seedSweep("ZZCASH", 5_000);
    seedFiveStocks(1_000);
  });

  it("the universe marks the sweep fund as a cash equivalent", () => {
    const u = getConcentrationUniverse(db);
    expect(u.find((p) => p.symbol === "ZZCASH")?.isCashEquivalent).toBe(true);
    expect(u.filter((p) => p.isCashEquivalent)).toHaveLength(1);
  });

  it("the card shows one cash line at 50% and keeps it out of the ranked list and warnings", () => {
    const m = getConcentrationMetrics(db);
    expect(m.cash.weight_pct).toBeCloseTo(50, 9);
    expect(m.cash.market_value).toBeCloseTo(5_000, 9);
    expect(m.cash.holding_count).toBe(1);
    expect(m.top_positions.map((p) => p.symbol)).not.toContain("ZZCASH");
    expect(m.top_positions).toHaveLength(5);
    // Each stock is a share of the WHOLE book, cash included.
    for (const p of m.top_positions) expect(p.weight_pct).toBeCloseTo(10, 9);
    expect(m.warnings.some((w) => w.includes("ZZCASH"))).toBe(false);
  });

  it("the Herfindahl leaves cash out of the sum of squares (dilution): 5 x 0.1^2 = 0.05", () => {
    const m = getConcentrationMetrics(db);
    expect(m.hhi).toBeCloseTo(0.05, 12);
    expect(m.effective_positions).toBe(20);
  });

  it("Risk Decomposition reports the identical index, cash share and ranked list", () => {
    const m = getConcentrationMetrics(db);
    const r = computeConcentration(db);
    expect(r.herfindahl).toBe(m.hhi);
    expect(r.cashWeight).toBeCloseTo(0.5, 12);
    expect(r.positionCount).toBe(5);
    expect(r.top5Positions.map((p) => p.symbol)).not.toContain("ZZCASH");
    expect(r.top5Concentration).toBeCloseTo(0.5, 12);
  });
});

describe("the same five stocks with no cash", () => {
  beforeEach(() => seedFiveStocks(1_000));

  it("reads 0.2 (five equal positions) and a zero cash line", () => {
    const m = getConcentrationMetrics(db);
    expect(m.hhi).toBeCloseTo(0.2, 12);
    expect(m.cash.weight_pct).toBe(0);
    expect(m.cash.holding_count).toBe(0);
    expect(computeConcentration(db).herfindahl).toBe(m.hhi);
    expect(computeConcentration(db).cashWeight).toBe(0);
  });

  it("adding cash LOWERS the index (cash reduces single-name risk)", () => {
    const without = getConcentrationMetrics(db).hhi;
    seedSweep("ZZCASH", 5_000);
    expect(getConcentrationMetrics(db).hhi).toBeLessThan(without);
  });
});

describe("a book that is all cash", () => {
  beforeEach(() => {
    seedSweep("ZZCASH", 3_000);
    seedPosition("ZZMMF", 2_000, 1, { type: "money_market" });
  });

  it("shows a 100% cash line, no ranked positions and no single-name index", () => {
    const m = getConcentrationMetrics(db);
    expect(m.cash.weight_pct).toBeCloseTo(100, 9);
    expect(m.cash.holding_count).toBe(2);
    expect(m.top_positions).toEqual([]);
    expect(m.hhi).toBe(0);
    expect(m.effective_positions).toBe(0);
    expect(m.warnings).toEqual([]);
    expect(Number.isFinite(m.hhi)).toBe(true);

    const r = computeConcentration(db);
    expect(r.herfindahl).toBeNull();
    expect(r.cashWeight).toBeCloseTo(1, 12);
    expect(r.top5Positions).toEqual([]);
    expect(r.positionCount).toBe(0);
  });
});

describe("a short next to cash", () => {
  beforeEach(() => {
    seedSweep("ZZCASH", 4_000);
    seedPosition("ZZL", 400, 10); // +4,000
    seedPosition("ZZS", -200, 10); // -2,000
  });

  it("weights stay gross over the whole book; the short is ranked, cash is not", () => {
    // gross = 4,000 + 4,000 + 2,000 = 10,000
    const m = getConcentrationMetrics(db);
    expect(m.cash.weight_pct).toBeCloseTo(40, 9);
    expect(m.top_positions.map((p) => p.symbol)).toEqual(["ZZL", "ZZS"]);
    expect(m.top_positions[1].market_value).toBeCloseTo(-2_000, 9);
    expect(m.top_positions[1].weight_pct).toBeCloseTo(20, 9);
    // 0.4^2 + 0.2^2 = 0.20
    expect(m.hhi).toBeCloseTo(0.2, 12);
    expect(computeConcentration(db).herfindahl).toBe(m.hhi);
  });
});

describe("the week-over-week snapshot uses the same rule", () => {
  it("an as-of date also keeps cash out of the index", () => {
    seedSweep("ZZCASH", 5_000);
    seedFiveStocks(1_000);
    const past = computeConcentration(db, undefined, "2026-03-05");
    expect(past.herfindahl).toBeCloseTo(0.05, 12);
    expect(past.cashWeight).toBeCloseTo(0.5, 12);
  });
});
