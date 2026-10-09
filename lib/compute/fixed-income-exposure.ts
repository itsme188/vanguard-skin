/**
 * The numbers behind the Fixed Income card: individual bond holdings, their
 * value, their duration and the value-weighted average.
 *
 * Every duration here comes from `estimateBondRateLeg`
 * (lib/compute/bond-duration.ts), the ONE duration rule the scenario engines
 * use. The card used to read only the stored `securities.duration_years`, so
 * a bond with none stored showed a dash here while a scenario on the same tab
 * moved it by a duration worked out from its maturity, coupon and price.
 *
 * A bond the rule cannot model (no maturity date, no coupon, no usable price
 * or yield) is still LISTED, carries the reason, and is counted in
 * `unmeasuredBondCount` / `unmeasuredBondValue`. It is given no duration and
 * is left out of the weighted average: unknown is not zero, and nothing is
 * ever assumed for a bond (CLAUDE.md, "Scenario inputs are never defaulted").
 *
 * `today` is the caller's Eastern calendar date (`todayET()`); this file
 * never reads the clock, so a bond maturing today is judged on one date by
 * the filter and by the duration rule.
 *
 * Scope: individual bonds only, as the card has always shown. Bond funds are
 * not listed here.
 */
import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import {
  estimateBondRateLeg,
  type BondUnmodelledReason,
  type CouponSource,
  type RateDurationSource,
} from "./bond-duration";

export interface FixedIncomeBond {
  symbol: string;
  name: string | null;
  /** US dollars. */
  marketValue: number;
  /** The duration the scenario rate leg would use; null when the bond is not modelled. */
  durationYears: number | null;
  /** Where the duration came from; null when the bond is not modelled. */
  durationSource: RateDurationSource | null;
  /** Why the bond has no duration; null when it has one. */
  unmodelledReason: BondUnmodelledReason | null;
  /** Set only when a coupon decided the outcome (see `BondRateLeg.couponSource`). */
  couponSource: CouponSource | null;
  creditRating: string | null;
  /** The STORED coupon (`securities.coupon_rate`), annual percent. */
  couponRate: number | null;
  maturityDate: string | null;
}

export interface FixedIncomeExposure {
  /** The Eastern date the durations and the maturity filter were judged on. */
  asOfDate: string;
  bonds: FixedIncomeBond[];
  totalBondValue: number;
  /** Value of the bonds that have a duration. */
  measuredBondValue: number;
  /** Value of the bonds listed without one. */
  unmeasuredBondValue: number;
  unmeasuredBondCount: number;
  /** How many durations were worked out rather than read from a stored figure. */
  derivedBondCount: number;
  portfolioValue: number;
  bondAllocationPct: number;
  /** Value-weighted over the bonds that have a duration; null when none has. */
  weightedAvgDuration: number | null;
  creditBreakdown: { rating: string; weight: number }[];
}

interface BondRow {
  symbol: string;
  name: string | null;
  security_type: string;
  sector: string | null;
  fund_category: string | null;
  market_value: number;
  duration_years: number | null;
  credit_rating: string | null;
  coupon_rate: number | null;
  maturity_date: string | null;
  bond_price: number | null;
}

const LATEST_PRICES_CTE = `latest_prices AS (
           SELECT security_id, close_price
           FROM prices
           WHERE (security_id, date) IN (
             SELECT security_id, MAX(date) FROM prices GROUP BY security_id
           )
         )`;

/**
 * @param accountIds the resolved scope (`resolveScope`); null or undefined means every account.
 * @param today      the Eastern calendar date, YYYY-MM-DD.
 */
export function computeFixedIncomeExposure(
  db: Database.Database,
  accountIds: number[] | null | undefined,
  today: string,
): FixedIncomeExposure {
  const accountFilter = accountIds
    ? `AND h.account_id IN (${accountIds.map((id) => Number(id)).join(",")})`
    : "";
  const latestHoldingsCte = `latest_holdings AS (
           SELECT h.security_id, SUM(h.quantity) AS total_qty
           FROM holdings h
           WHERE ${latestHoldingsPredicate({ includeShorts: false, accountFilter })}
           GROUP BY h.security_id
         )`;

  // Bond holdings with a price. The stored price is per 100 face, in the
  // bond's own currency; the value is converted to dollars, the price is not
  // (the duration rule reads it as a quote, not as money).
  const rows = db
    .prepare(
      `WITH ${latestHoldingsCte},
         ${LATEST_PRICES_CTE}
         SELECT
           s.symbol,
           s.name,
           s.security_type,
           s.sector,
           s.fund_category,
           lh.total_qty * COALESCE(lp.close_price, 0) / 100.0 * COALESCE(fx.usd_per_unit, 1) AS market_value,
           s.duration_years,
           s.credit_rating,
           s.coupon_rate,
           s.maturity_date,
           lp.close_price AS bond_price
         FROM latest_holdings lh
         JOIN securities s ON s.id = lh.security_id
         LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
         WHERE LOWER(s.security_type) = 'bond'
           AND (s.maturity_date IS NULL OR s.maturity_date >= ?)
           AND COALESCE(lp.close_price, 0) > 0
         ORDER BY market_value DESC`,
    )
    .all(today) as BondRow[];

  // Total portfolio value, for the allocation percent.
  const portfolio = db
    .prepare(
      `WITH ${latestHoldingsCte},
         ${LATEST_PRICES_CTE}
         SELECT SUM(
           (CASE
             WHEN LOWER(s.security_type) = 'bond'
               THEN lh.total_qty * COALESCE(lp.close_price, 0) / 100.0
             ELSE lh.total_qty * COALESCE(lp.close_price, 0) * COALESCE(s.multiplier, 1)
           END) * COALESCE(fx.usd_per_unit, 1)
         ) AS total_value
         FROM latest_holdings lh
         JOIN securities s ON s.id = lh.security_id
         LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
         WHERE COALESCE(lp.close_price, 0) > 0`,
    )
    .get() as { total_value: number | null } | undefined;

  const bonds: FixedIncomeBond[] = rows.map((row) => {
    // A rate move of zero: only the duration and its source are read. This is
    // the same call, with the same stored inputs, the scenario engine makes.
    const leg = estimateBondRateLeg(
      {
        security_type: row.security_type,
        security_name: row.name,
        sector: row.sector,
        fund_category: row.fund_category,
        duration_years: row.duration_years,
        maturity_date: row.maturity_date,
        coupon_rate: row.coupon_rate,
        bond_price: row.bond_price,
      },
      0,
      today,
    );
    const durationYears =
      leg && typeof leg.durationYears === "number" && Number.isFinite(leg.durationYears) ? leg.durationYears : null;
    return {
      symbol: row.symbol,
      name: row.name,
      marketValue: row.market_value,
      durationYears,
      durationSource: durationYears != null ? (leg?.durationSource ?? null) : null,
      unmodelledReason: durationYears != null ? null : (leg?.unmodelledReason ?? null),
      couponSource: leg?.couponSource ?? null,
      creditRating: row.credit_rating,
      couponRate: row.coupon_rate,
      maturityDate: row.maturity_date,
    };
  });

  const totalBondValue = bonds.reduce((sum, b) => sum + b.marketValue, 0);
  const portfolioValue = portfolio?.total_value ?? 0;
  const bondAllocationPct = portfolioValue > 0 ? (totalBondValue / portfolioValue) * 100 : 0;

  // The average is over the bonds that HAVE a duration. A bond without one is
  // unknown, not zero: dividing by the whole sleeve would count it as zero
  // and understate rate risk by exactly its share.
  const measured = bonds.filter((b) => b.durationYears != null);
  const measuredBondValue = measured.reduce((sum, b) => sum + b.marketValue, 0);
  const weightedAvgDuration =
    measured.length > 0 && measuredBondValue > 0
      ? measured.reduce((sum, b) => sum + b.durationYears! * b.marketValue, 0) / measuredBondValue
      : null;

  const creditMap = new Map<string, number>();
  for (const b of bonds) {
    const rating = b.creditRating ?? "Unrated";
    creditMap.set(rating, (creditMap.get(rating) ?? 0) + b.marketValue);
  }
  const creditBreakdown = Array.from(creditMap.entries())
    .map(([rating, value]) => ({ rating, weight: totalBondValue > 0 ? value / totalBondValue : 0 }))
    .sort((a, b) => b.weight - a.weight);

  return {
    asOfDate: today,
    bonds,
    totalBondValue,
    measuredBondValue,
    unmeasuredBondValue: totalBondValue - measuredBondValue,
    unmeasuredBondCount: bonds.length - measured.length,
    derivedBondCount: measured.filter((b) => b.durationSource !== "stored").length,
    portfolioValue,
    bondAllocationPct,
    weightedAvgDuration,
    creditBreakdown,
  };
}
