import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, PRESET_SCENARIOS, type ScenarioResult } from "@/lib/compute/scenarios";
import {
  estimateBondRateLeg,
  fundDefaultRefusal,
  summarizeUnmodelledBonds,
  FUND_DEFAULT_DURATION_YEARS,
  type RateLegInputs,
} from "@/lib/compute/bond-duration";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * Ruling D6 (2026-10-08): the 5-year fund default is for a fund that really
 * is a bond fund. It needs a bond-family fund category AND no sign that the
 * fund is an equity fund (a GICS equity sector, or an equity word in its
 * name). A fund that fails either test is never given a duration. The custom
 * engine lists and counts it; the rate preset treats an equity-evidence fund
 * as the equity position it is (unit N3) and lists only the unconfirmed one.
 * Synthetic figures only: ZZ* names, round numbers.
 */
const TODAY = "2030-01-15";

function fund(over: Partial<RateLegInputs>): RateLegInputs {
  return {
    security_type: "ETF",
    security_name: "ZZ Aggregate Bond ETF",
    sector: null,
    fund_category: "US Aggregate Bond",
    duration_years: null,
    maturity_date: null,
    coupon_rate: null,
    bond_price: 50,
    ...over,
  };
}

describe("estimateBondRateLeg: the fund default needs corroboration", () => {
  it("a real bond fund still takes the 5-year default", () => {
    for (const sector of [null, "Fixed Income", " fixed income ", "Diversified", "Financial"]) {
      const leg = estimateBondRateLeg(fund({ sector }), 200, TODAY)!;
      expect(leg.durationSource, String(sector)).toBe("fund-default");
      expect(leg.durationYears, String(sector)).toBe(FUND_DEFAULT_DURATION_YEARS);
      expect(leg.changePercent, String(sector)).toBeCloseTo(Math.exp(-5 * 0.02) - 1, 12);
      expect(leg.unmodelledReason, String(sector)).toBeUndefined();
    }
  });

  it("a bond category with a GICS equity sector is not modelled", () => {
    for (const sector of ["Financials", "financials", "Technology", "Information Technology", "Real Estate", "Health Care"]) {
      const leg = estimateBondRateLeg(fund({ sector, security_name: "ZZ Fund" }), 200, TODAY)!;
      expect(leg.unmodelledReason, sector).toBe("fund-equity-evidence");
      expect(leg.changePercent, sector).toBe(0);
      expect(leg.durationYears, sector).toBeUndefined();
      expect(leg.durationSource, sector).toBeUndefined();
    }
  });

  it("a bond category with an equity word in the fund's name is not modelled", () => {
    for (const name of [
      "ZZ Long Short Equity ETF",
      "ZZ Long/Short Fund",
      "ZZ Long-Short Opportunities",
      "ZZ Total Stock Market Index",
      "ZZ Global Equities Fund",
      "zz dividend stocks etf",
    ]) {
      const leg = estimateBondRateLeg(fund({ security_name: name, fund_category: "Diversified Bond" }), 200, TODAY)!;
      expect(leg.unmodelledReason, name).toBe("fund-equity-evidence");
      expect(leg.changePercent, name).toBe(0);
      expect(leg.durationYears, name).toBeUndefined();
    }
  });

  it("an equity word must be a whole word: a bond fund's ordinary name is not equity evidence", () => {
    for (const name of ["ZZ Bond Fund Admiral Shares", "ZZ iShares Core Aggregate Bond", "ZZ Short-Term Treasury ETF", "ZZ Stockton Municipal Bond", null]) {
      const leg = estimateBondRateLeg(fund({ security_name: name }), 200, TODAY)!;
      expect(leg.durationSource, String(name)).toBe("fund-default");
    }
  });

  it("an unknown or missing category is not modelled, even with a Fixed Income sector", () => {
    for (const fund_category of [null, "", "ZZ Bond", "Corporate Something"]) {
      const leg = estimateBondRateLeg(fund({ sector: "Fixed Income", fund_category }), 200, TODAY)!;
      expect(leg.unmodelledReason, String(fund_category)).toBe("fund-category-unconfirmed");
      expect(leg.changePercent, String(fund_category)).toBe(0);
      expect(leg.durationYears, String(fund_category)).toBeUndefined();
    }
  });

  it("equity evidence is named first when both tests fail", () => {
    const leg = estimateBondRateLeg(
      fund({ sector: "Fixed Income", fund_category: "ZZ Bond", security_name: "ZZ Equity Income" }),
      200,
      TODAY,
    )!;
    expect(leg.unmodelledReason).toBe("fund-equity-evidence");
  });

  it("a stored fund duration is a stored input, not a default: it is used as stored", () => {
    const leg = estimateBondRateLeg(fund({ sector: "Fixed Income", fund_category: "ZZ Bond", duration_years: 3 }), 200, TODAY)!;
    expect(leg.durationSource).toBe("fund-stored");
    expect(leg.changePercent).toBeCloseTo(Math.exp(-3 * 0.02) - 1, 12);
    expect(leg.unmodelledReason).toBeUndefined();
  });

  it("an equity fund with no bond label is still not this module's business", () => {
    expect(estimateBondRateLeg(fund({ sector: "Financials", fund_category: "US Large Cap Equity" }), 200, TODAY)).toBeNull();
  });

  it("fundDefaultRefusal is the one reader of the rule", () => {
    expect(fundDefaultRefusal(fund({}))).toBeNull();
    expect(fundDefaultRefusal(fund({ sector: "Financials" }))).toBe("fund-equity-evidence");
    expect(fundDefaultRefusal(fund({ fund_category: " diversified bond " }))).toBeNull();
    expect(fundDefaultRefusal(fund({ fund_category: "ZZ Bond" }))).toBe("fund-category-unconfirmed");
  });
});

describe("summarizeUnmodelledBonds: funds left out are counted on their own", () => {
  it("counts a left-out fund in fundCount and keeps it out of the individual-bond share", () => {
    const summary = summarizeUnmodelledBonds([
      { securityType: "Bond", currentValue: 3000 },
      { securityType: "bond", currentValue: 1000, bondUnmodelledReason: "no-maturity" },
      { securityType: "ETF", currentValue: 9000, bondUnmodelledReason: "fund-equity-evidence" },
      { securityType: "Mutual Fund", currentValue: 2000, bondUnmodelledReason: "fund-category-unconfirmed" },
      { securityType: "Mutual Fund", currentValue: 7000 },
    ]);
    expect(summary).toEqual({ count: 1, valueShare: 0.25, fundCount: 2 });
  });
});

describe("both scenario engines: a mislabelled fund is never marked down by 5 years", () => {
  let db: Database.Database;
  let today: string;
  const REAL = 1;
  const EQUITY_SECTOR = 2;
  const EQUITY_NAME = 3;
  const UNKNOWN_CATEGORY = 4;
  const RATE_PRESET = "rate_shock_up_25bp";

  function seed(id: number, symbol: string, name: string, sector: string | null, fundCategory: string | null) {
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category) VALUES (?, ?, ?, 'ETF', ?, ?)`,
    ).run(id, symbol, name, sector, fundCategory);
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
    seed(REAL, "ZZA", "ZZ Aggregate Bond ETF", "Fixed Income", "US Aggregate Bond");
    seed(EQUITY_SECTOR, "ZZB", "ZZ Managed Fund", "Financials", "Diversified Bond");
    seed(EQUITY_NAME, "ZZC", "ZZ Long Short Equity ETF", null, "Diversified Bond");
    seed(UNKNOWN_CATEGORY, "ZZD", "ZZ Income Fund", "Fixed Income", "ZZ Income");
  });

  const rowOf = (res: ScenarioResult, id: number) => res.positionImpacts.find((p) => p.securityId === id)!;
  const runs = (): Array<[string, ScenarioResult, number]> => [
    ["custom +200bp", computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: 0, rateMove: 200 }), 200],
    ["rate preset", computeScenario(db, PRESET_SCENARIOS.find((p) => p.id === RATE_PRESET)!), 25],
  ];

  it("custom engine: the real bond fund moves on the default; the three others add nothing and carry a reason", () => {
    const [label, res, bps] = runs()[0];
    const real = rowOf(res, REAL);
    expect(real.rateDurationSource, label).toBe("fund-default");
    expect(real.changePercent, label).toBeCloseTo(Math.exp(-5 * (bps / 10000)) - 1, 12);
    expect(real.bondUnmodelledReason, label).toBeUndefined();

    for (const [id, reason] of [
      [EQUITY_SECTOR, "fund-equity-evidence"],
      [EQUITY_NAME, "fund-equity-evidence"],
      [UNKNOWN_CATEGORY, "fund-category-unconfirmed"],
    ] as const) {
      const row = rowOf(res, id);
      expect(row.bondUnmodelledReason, `${label} ${id}`).toBe(reason);
      expect(row.changePercent, `${label} ${id}`).toBe(0);
      expect(row.estimatedChange, `${label} ${id}`).toBe(0);
      expect(row.rateDurationYears, `${label} ${id}`).toBeUndefined();
      expect(row.rateDurationSource, `${label} ${id}`).toBeUndefined();
    }
    expect(res.bondsUnmodelled, label).toEqual({ count: 0, valueShare: 0, fundCount: 3 });
    // Only the real fund's 10,000 moves (no market move in this run).
    expect(res.estimatedChange, label).toBeCloseTo(10_000 * (Math.exp(-5 * (bps / 10000)) - 1), 8);
  });

  // Unit N3 (2026-10-08) deliberately changed the PRESET here. A fund with
  // equity evidence and no stored duration used to take a bond leg of zero,
  // so in the one preset where growth equity is meant to lag it stood still.
  // It is now an equity position for the recipe (the normal factor path) and
  // is no longer counted as a fund left out. A fund refused only for an
  // unconfirmed category is unchanged: not modelled, counted.
  it("rate preset: an equity-evidence fund takes the equity factor path; the unconfirmed one stays out", () => {
    const factors = db.prepare(
      `INSERT INTO security_factors (security_id, interest_rate_sensitive, growth_vs_value) VALUES (?, ?, ?)`,
    );
    factors.run(EQUITY_SECTOR, "Moderate", "Growth");
    factors.run(EQUITY_NAME, "Low", "Blend");
    // Factor rows a classifier could also hang on the other two: they must
    // not pull either fund onto the equity path.
    factors.run(REAL, "Moderate", "Growth");
    factors.run(UNKNOWN_CATEGORY, "Moderate", "Growth");

    const res = computeScenario(db, PRESET_SCENARIOS.find((p) => p.id === RATE_PRESET)!);

    // The real bond fund: exp(-5 x 0.0025) - 1 = -1.2422% of 10,000.
    const real = rowOf(res, REAL);
    expect(real.rateDurationSource).toBe("fund-default");
    expect(real.changePercent).toBeCloseTo(Math.exp(-5 * 0.0025) - 1, 12);

    // ZZB (Moderate rate bucket, Growth). Preset shock -2.5%.
    //   blend = 0.50 (Moderate) + 0.5 x 1.00 (Growth) = 1.00
    //   subject by both factor selectors, membership floor 0.50
    //   change = -0.025 x max(0.50, 1.00) = -2.5%  ->  -250 on 10,000
    const growth = rowOf(res, EQUITY_SECTOR);
    expect(growth.currentValue).toBeCloseTo(10_000, 8);
    expect(growth.changePercent).toBeCloseTo(-0.025, 12);
    expect(growth.estimatedChange).toBeCloseTo(-250, 8);
    expect(growth.subjectShare).toBe(1);

    // ZZC (Low rate bucket, Blend): not a subject, so the spillover leg.
    //   blend = 0.10 (Low) + 0.5 x 0.25 (Blend) = 0.225
    //   change = -0.025 x 0.25 (spillover) x 0.225 = -0.140625%
    //   -> -14.0625 on 10,000
    const blend = rowOf(res, EQUITY_NAME);
    expect(blend.changePercent).toBeCloseTo(-0.00140625, 12);
    expect(blend.estimatedChange).toBeCloseTo(-14.0625, 8);
    expect(blend.subjectShare).toBe(0);

    for (const row of [growth, blend]) {
      expect(row.bondUnmodelledReason, row.symbol).toBeUndefined();
      expect(row.rateDurationYears, row.symbol).toBeUndefined();
      expect(row.rateDurationSource, row.symbol).toBeUndefined();
    }

    const unconfirmed = rowOf(res, UNKNOWN_CATEGORY);
    expect(unconfirmed.bondUnmodelledReason).toBe("fund-category-unconfirmed");
    expect(unconfirmed.changePercent).toBe(0);
    expect(unconfirmed.estimatedChange).toBe(0);

    // Only the unconfirmed fund is left out now.
    expect(res.bondsUnmodelled).toEqual({ count: 0, valueShare: 0, fundCount: 1 });
    expect(res.estimatedChange).toBeCloseTo(10_000 * (Math.exp(-5 * 0.0025) - 1) - 250 - 14.0625, 8);
  });

  it("rate preset: an equity-evidence fund with a STORED duration keeps the bond treatment", () => {
    db.prepare(`UPDATE securities SET duration_years = 4 WHERE id = ?`).run(EQUITY_SECTOR);
    db.prepare(
      `INSERT INTO security_factors (security_id, interest_rate_sensitive, growth_vs_value) VALUES (?, 'Moderate', 'Growth')`,
    ).run(EQUITY_SECTOR);
    const res = computeScenario(db, PRESET_SCENARIOS.find((p) => p.id === RATE_PRESET)!);
    const row = rowOf(res, EQUITY_SECTOR);
    // exp(-4 x 0.0025) - 1 = -0.995%
    expect(row.rateDurationSource).toBe("fund-stored");
    expect(row.changePercent).toBeCloseTo(Math.exp(-4 * 0.0025) - 1, 12);
  });

  it("with no rate move nothing is listed", () => {
    const res = computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: -0.1 });
    expect(res.bondsUnmodelled).toEqual({ count: 0, valueShare: 0, fundCount: 0 });
    expect(res.positionImpacts.every((p) => p.bondUnmodelledReason === undefined)).toBe(true);
  });
});
