import { db } from "@/lib/db";
import { resolveScope } from "@/lib/queries/accounts";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get("scope");
    const accountIds = resolveScope(db, scope);
    const accountFilter = accountIds
      ? `AND h.account_id IN (${accountIds.join(",")})`
      : "";
    // Get all bond holdings with current values
    const bonds = db
      .prepare(
        `WITH latest_holdings AS (
           SELECT h.security_id, h.account_id, SUM(h.quantity) AS total_qty
           FROM holdings h
           WHERE h.as_of_date = (
             SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id
           )
           AND h.quantity > 0
           ${accountFilter}
           GROUP BY h.security_id
         ),
         latest_prices AS (
           SELECT security_id, close_price
           FROM prices
           WHERE (security_id, date) IN (
             SELECT security_id, MAX(date) FROM prices GROUP BY security_id
           )
         )
         SELECT
           s.symbol,
           s.name,
           lh.total_qty * COALESCE(lp.close_price, 0) / 100.0 * COALESCE(fx.usd_per_unit, 1) AS market_value,
           s.duration_years,
           s.credit_rating,
           s.coupon_rate,
           s.maturity_date
         FROM latest_holdings lh
         JOIN securities s ON s.id = lh.security_id
         LEFT JOIN latest_prices lp ON lp.security_id = lh.security_id
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
         WHERE LOWER(s.security_type) = 'bond'
           AND (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
           AND COALESCE(lp.close_price, 0) > 0
         ORDER BY market_value DESC`
      )
      .all() as Array<{
      symbol: string;
      name: string | null;
      market_value: number;
      duration_years: number | null;
      credit_rating: string | null;
      coupon_rate: number | null;
      maturity_date: string | null;
    }>;

    // Get total portfolio value for allocation %
    const portfolio = db
      .prepare(
        `WITH latest_holdings AS (
           SELECT h.security_id, SUM(h.quantity) AS total_qty
           FROM holdings h
           WHERE h.as_of_date = (
             SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id
           )
           AND h.quantity > 0
           ${accountFilter}
           GROUP BY h.security_id
         ),
         latest_prices AS (
           SELECT security_id, close_price
           FROM prices
           WHERE (security_id, date) IN (
             SELECT security_id, MAX(date) FROM prices GROUP BY security_id
           )
         )
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
         WHERE COALESCE(lp.close_price, 0) > 0`
      )
      .get() as { total_value: number } | undefined;

    const totalBondValue = bonds.reduce((s, b) => s + b.market_value, 0);
    const portfolioValue = portfolio?.total_value ?? 0;
    const bondAllocationPct =
      portfolioValue > 0 ? (totalBondValue / portfolioValue) * 100 : 0;

    // Weighted average duration (only bonds with duration data)
    const bondsWithDuration = bonds.filter((b) => b.duration_years != null);
    const weightedAvgDuration =
      bondsWithDuration.length > 0 && totalBondValue > 0
        ? bondsWithDuration.reduce(
            (sum, b) => sum + b.duration_years! * b.market_value,
            0
          ) / totalBondValue
        : null;

    // Credit quality breakdown
    const creditMap = new Map<string, number>();
    for (const b of bonds) {
      const rating = b.credit_rating ?? "Unrated";
      creditMap.set(rating, (creditMap.get(rating) ?? 0) + b.market_value);
    }
    const creditBreakdown = Array.from(creditMap.entries())
      .map(([rating, value]) => ({
        rating,
        weight: totalBondValue > 0 ? value / totalBondValue : 0,
      }))
      .sort((a, b) => b.weight - a.weight);

    return Response.json({
      success: true,
      data: {
        bonds: bonds.map((b) => ({
          symbol: b.symbol,
          name: b.name,
          marketValue: b.market_value,
          durationYears: b.duration_years,
          creditRating: b.credit_rating,
          couponRate: b.coupon_rate,
          maturityDate: b.maturity_date,
        })),
        totalBondValue,
        portfolioValue,
        bondAllocationPct,
        weightedAvgDuration,
        creditBreakdown,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
