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
 * name). A fund that fails either test is listed as not modelled and counted;
 * it is never given a duration.
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

describe("both scenario engines: a mislabelled fund is listed, never marked down by 5 years", () => {
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

  it("the real bond fund moves on the default; the three others add nothing and carry a reason", () => {
    for (const [label, res, bps] of runs()) {
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
      // Only the real fund's 10,000 moves.
      expect(res.estimatedChange, label).toBeCloseTo(10_000 * (Math.exp(-5 * (bps / 10000)) - 1), 8);
    }
  });

  it("with no rate move nothing is listed", () => {
    const res = computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: -0.1 });
    expect(res.bondsUnmodelled).toEqual({ count: 0, valueShare: 0, fundCount: 0 });
    expect(res.positionImpacts.every((p) => p.bondUnmodelledReason === undefined)).toBe(true);
  });
});
