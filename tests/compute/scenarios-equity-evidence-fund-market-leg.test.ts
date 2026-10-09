import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, type ScenarioResult } from "@/lib/compute/scenarios";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * A fund labelled with a bond category but carrying equity evidence (an
 * equity sector, or an equity word in its name) is refused the 5-year
 * duration default. It must then not ALSO be treated as a zero-beta bond
 * fund on the market leg: with no rate leg and no market leg a -20% market
 * shock left it unchanged and it was listed nowhere.
 * Synthetic figures only: ZZ* names, round numbers (200 x 50 = 10,000 each).
 */
describe("custom scenario: an equity-evidence fund takes the market move", () => {
  let db: Database.Database;
  let today: string;
  const F1 = 1; // bond category + equity sector
  const F2 = 2; // bond category + equity word in the name
  const PLAIN_SECTOR = 3; // an ordinary equity fund, same sector as F1
  const PLAIN = 4; // an ordinary equity fund, no sector
  const REAL_BOND = 5;
  const STORED = 6; // equity sector, but a stored duration
  const UNCONFIRMED = 7; // Fixed Income sector, unknown category

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
    seed(F1, "ZZA", "ZZ Managed Fund", "Financials", "Diversified Bond");
    seed(F2, "ZZB", "Alpha Long/Short Equity Fund", null, "Diversified Bond");
    seed(PLAIN_SECTOR, "ZZC", "ZZ Financial Fund", "Financials", "US Large Cap Equity");
    seed(PLAIN, "ZZD", "ZZ Broad Fund", null, "US Large Cap Equity");
    seed(REAL_BOND, "ZZE", "ZZ Aggregate Bond Fund", "Fixed Income", "US Aggregate Bond");
    seed(STORED, "ZZF", "ZZ Managed Income Fund", "Financials", "Diversified Bond", 4);
    seed(UNCONFIRMED, "ZZG", "ZZ Income Fund", "Fixed Income", "ZZ Income");
  });

  const rowOf = (res: ScenarioResult, id: number) => res.positionImpacts.find((p) => p.securityId === id)!;
  const run = (marketMove: number, rateMove?: number) =>
    computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove, rateMove });

  it("market -20%: each equity-evidence fund falls like a plain equity fund (about -2,000 on 10,000)", () => {
    const res = run(-0.2);
    const plainSector = rowOf(res, PLAIN_SECTOR);
    const plain = rowOf(res, PLAIN);
    expect(plain.estimatedChange).toBeCloseTo(-2000, 6);
    expect(plainSector.estimatedChange).toBeCloseTo(-2000, 6);

    const f1 = rowOf(res, F1);
    const f2 = rowOf(res, F2);
    expect(f1.currentValue).toBeCloseTo(10_000, 6);
    expect(f1.estimatedChange).toBeCloseTo(plainSector.estimatedChange, 6);
    expect(f1.changePercent).toBeCloseTo(plainSector.changePercent, 12);
    expect(f1.beta).toBe(plainSector.beta);
    expect(f2.estimatedChange).toBeCloseTo(plain.estimatedChange, 6);
    expect(f2.changePercent).toBeCloseTo(plain.changePercent, 12);
    expect(f2.beta).toBe(plain.beta);
  });

  it("a real bond fund still takes nothing on the market leg", () => {
    const real = rowOf(run(-0.2), REAL_BOND);
    expect(real.estimatedChange).toBeCloseTo(0, 12);
    expect(real.beta).toBe(0);
  });

  it("a fund with a stored duration keeps its treatment: zero market leg, its stored rate leg", () => {
    expect(rowOf(run(-0.2), STORED).estimatedChange).toBeCloseTo(0, 12);
    const both = rowOf(run(-0.2, 100), STORED);
    expect(both.rateDurationSource).toBe("fund-stored");
    expect(both.changePercent).toBeCloseTo(Math.exp(-4 * 0.01) - 1, 12);
  });

  it("a fund refused only for an unconfirmed category is unchanged: zero market leg", () => {
    expect(rowOf(run(-0.2), UNCONFIRMED).estimatedChange).toBeCloseTo(0, 12);
  });

  it("market and rate together: the equity-evidence fund takes the market move and still no duration", () => {
    const res = run(-0.2, 200);
    const f1 = rowOf(res, F1);
    expect(f1.bondUnmodelledReason).toBe("fund-equity-evidence");
    expect(f1.rateDurationYears).toBeUndefined();
    expect(f1.changePercent).toBeCloseTo(rowOf(res, PLAIN_SECTOR).changePercent, 12);
    expect(f1.estimatedChange).toBeCloseTo(-2000, 6);
  });
});
