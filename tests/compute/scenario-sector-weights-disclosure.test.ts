import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, type ScenarioResult } from "@/lib/compute/scenarios";
import { explodeHoldingBySector } from "@/lib/compute/explode-sector";
import { getEtfSectorWeights } from "@/lib/queries/etf-weights";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * A custom scenario with a sector shock looks through a fund only when the
 * fund has cached sector weights. A held fund with none takes the market move
 * alone. The result now NAMES those funds (`fundsWithoutSectorWeights`); it
 * changes no figure. Synthetic symbols and round invented numbers only.
 */
let db: Database.Database;
let today: string;

const WITH_WEIGHTS = 1; // AAA
const NO_WEIGHTS_ETF = 2; // BBB
const NO_WEIGHTS_MF = 3; // CCC
const NO_WEIGHTS_OWN_SECTOR = 4; // DDD, own sector Financials
const STOCK = 5;
const CASH = 6;
const BOND_FUND = 7;

function seed(
  id: number,
  symbol: string,
  opts: { type: string; sector?: string | null; fundCategory?: string | null; price: number; quantity: number | null },
) {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, symbol, symbol, opts.type, opts.sector ?? null, opts.fundCategory ?? null);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`).run(id, today, opts.price);
  if (opts.quantity !== null) {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, ?, ?)`,
    ).run(id, today, opts.quantity, `h-${id}`);
  }
}

function weights(symbol: string, rows: Array<[string, number]>) {
  for (const [sector, pct] of rows) {
    db.prepare(`INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES (?, ?, ?, ?, 'test')`).run(symbol, sector, pct, today);
  }
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  today = todayET();
  db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();

  seed(WITH_WEIGHTS, "AAA", { type: "ETF", sector: "Diversified", price: 100, quantity: 100 });
  seed(NO_WEIGHTS_ETF, "BBB", { type: "ETF", sector: "Diversified", price: 50, quantity: 300 });
  seed(NO_WEIGHTS_MF, "CCC", { type: "Mutual Fund", sector: null, price: 20, quantity: 200 });
  seed(NO_WEIGHTS_OWN_SECTOR, "DDD", { type: "ETF", sector: "Financials", price: 40, quantity: 100 });
  seed(STOCK, "ZZEQ", { type: "Stock", sector: "Technology", price: 100, quantity: 50 });
  seed(CASH, "ZZCASH", { type: "Mutual Fund", sector: "Fixed Income", fundCategory: "Cash Equivalent", price: 1, quantity: 5000 });
  seed(BOND_FUND, "ZZBFUND", { type: "Mutual Fund", sector: "Fixed Income", fundCategory: "ZZ Mortgage Bond", price: 10, quantity: 1000 });
  // Not held: must never be named, with or without weights.
  seed(8, "EEE", { type: "ETF", sector: "Diversified", price: 10, quantity: null });

  weights("AAA", [["Technology", 40], ["Financials", 60]]);
});

function run(sectorMoves: Record<string, number> | undefined, marketMove = -0.1): ScenarioResult {
  return computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove, sectorMoves });
}
const rowOf = (res: ScenarioResult, id: number) => res.positionImpacts.find((p) => p.securityId === id)!;

describe("custom sector shock: funds with no cached sector weights are named", () => {
  it("names exactly the held equity funds that took the market move alone, in symbol order", () => {
    const res = run({ Technology: -0.5 });
    expect(res.fundsWithoutSectorWeights).toEqual(["BBB", "CCC", "DDD"]);
  });

  it("does not name a fund whose own sector carries the shock: it takes that move as one bucket", () => {
    const res = run({ Financials: -0.3 });
    expect(res.fundsWithoutSectorWeights).toEqual(["BBB", "CCC"]);
    expect(rowOf(res, NO_WEIGHTS_OWN_SECTOR).changePercent).toBeCloseTo(-0.3, 12);
  });

  it("is empty with no sector override, with an empty override, and when every fund has weights", () => {
    expect(run(undefined).fundsWithoutSectorWeights).toEqual([]);
    expect(run({}).fundsWithoutSectorWeights).toEqual([]);

    weights("BBB", [["Technology", 100]]);
    weights("CCC", [["Healthcare", 100]]);
    weights("DDD", [["Financials", 100]]);
    expect(run({ Technology: -0.5 }).fundsWithoutSectorWeights).toEqual([]);
  });

  it("stops naming a fund as soon as its weights are on file", () => {
    weights("BBB", [["Technology", 100]]);
    expect(run({ Technology: -0.5 }).fundsWithoutSectorWeights).toEqual(["CCC", "DDD"]);
  });

  it("never names cash funds or bond funds (no equity move reaches them) or a fund that is not held", () => {
    const named = run({ Technology: -0.5 }).fundsWithoutSectorWeights!;
    expect(named).not.toContain("ZZCASH");
    expect(named).not.toContain("ZZBFUND");
    expect(named).not.toContain("EEE");
    expect(named).not.toContain("ZZEQ");
  });

  it("respects the account scope", () => {
    db.prepare(`INSERT INTO accounts (id, name) VALUES (99, 'Other')`).run();
    const res = computeScenario(
      db,
      { id: "custom", name: "c", description: "", category: "custom", marketMove: -0.1, sectorMoves: { Technology: -0.5 } },
      { accountIds: [99] },
    );
    expect(res.fundsWithoutSectorWeights).toEqual([]);
  });
});

describe("the disclosure changes no scenario figure", () => {
  it("a named fund's row is the market-only row, figure for figure", () => {
    const shocked = run({ Technology: -0.5 });
    const marketOnly = run(undefined);
    for (const id of [NO_WEIGHTS_ETF, NO_WEIGHTS_MF, NO_WEIGHTS_OWN_SECTOR]) {
      expect(rowOf(shocked, id), `security ${id}`).toEqual(rowOf(marketOnly, id));
    }
  });

  it("a fund with weights still takes the look-through move the shared helper gives", () => {
    const sectorMoves: Record<string, number> = { Technology: -0.5 };
    const res = run(sectorMoves);
    const row = rowOf(res, WITH_WEIGHTS);
    const parts = explodeHoldingBySector("AAA", "ETF", row.currentValue, getEtfSectorWeights(db), "Diversified");
    const expected = parts.reduce(
      (sum, part) => sum + (part.value / row.currentValue) * (sectorMoves[part.sector] ?? -0.1) * row.beta,
      0,
    );
    expect(row.changePercent).toBeCloseTo(expected, 12);
    expect(row.changePercent).not.toBeCloseTo(-0.1, 6);
  });

  it("totals are still the sum of the rows, and the rows carry no new field", () => {
    const res = run({ Technology: -0.5 });
    const sum = res.positionImpacts.reduce((s, p) => s + p.estimatedChange, 0);
    expect(res.estimatedChange).toBe(sum);
    expect(res.estimatedPortfolioValue).toBe(res.currentPortfolioValue + sum);
    expect(res.estimatedChangePercent).toBe(sum / res.currentPortfolioValue);
    for (const row of res.positionImpacts) {
      expect(Object.keys(row).sort()).toEqual(Object.keys(rowOf(run(undefined), row.securityId)).sort());
    }
  });
});
