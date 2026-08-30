import type Database from "better-sqlite3";
import type { Holding } from "@/lib/types";
import { adjustedMarketValueSQL, scaledCostBasisFallbackSQL } from "@/lib/valuation";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

export interface HoldingWithSecurity extends Holding {
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  account_name: string;
  underlying_symbol: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  option_type: "CALL" | "PUT" | null;
  multiplier: number;
}

export interface AllHoldingsRow {
  account_id: number;
  account_name: string;
  security_id: number;
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  multiplier: number;
  quantity: number;
  cost_basis: number | null;
  as_of_date: string;
  current_price: number | null;
  current_value: number | null;
  unrealized_gain: number | null;
}

export function getAllHoldings(db: Database.Database): AllHoldingsRow[] {
  const marketValueExpr = adjustedMarketValueSQL(
    "h.quantity",
    "p.close_price",
    "s.security_type",
    "COALESCE(s.multiplier, 1)",
    "COALESCE(fx.usd_per_unit, 1)",
  );

  // Cost basis fallback: Plaid sync writes holdings rows with cost_basis =
  // NULL (Plaid's investments/holdings/get response has no reliable basis
  // field for every account type). Statement imports write the same
  // (account, security) pair with cost_basis populated on the period-end
  // date, so the row this query displays — the per-(account, security)
  // latest row, see the WHERE clause below — is usually the NULL-basis
  // Plaid row. Without the fallback every Vanguard holding rendered "-"
  // cost basis and NULL unrealized gain after the first Plaid sync. The
  // inner alias is h3 so it stays distinct from the h2 that
  // latestHoldingsPredicate uses inside its own subquery.
  // Mirrors the identical pattern in getCrossAccountPositions
  // (lib/digest/send-earnings-email.ts).
  const costBasisExpr = scaledCostBasisFallbackSQL("h", "h3");

  const sql = `
    SELECT
      h.account_id,
      a.name AS account_name,
      h.security_id,
      s.symbol,
      s.name AS security_name,
      s.security_type,
      COALESCE(s.multiplier, 1) AS multiplier,
      h.quantity,
      ${costBasisExpr} * COALESCE(fx.usd_per_unit, 1) AS cost_basis,
      h.as_of_date,
      p.close_price AS current_price,
      CASE WHEN p.close_price IS NOT NULL
        THEN ${marketValueExpr}
        ELSE NULL END AS current_value,
      CASE WHEN p.close_price IS NOT NULL AND NULLIF(${costBasisExpr}, 0) IS NOT NULL
        THEN ${marketValueExpr} - (${costBasisExpr} * COALESCE(fx.usd_per_unit, 1))
        ELSE NULL END AS unrealized_gain
    FROM holdings h
    JOIN accounts a ON a.id = h.account_id
    JOIN securities s ON s.id = h.security_id
    LEFT JOIN prices p ON p.security_id = h.security_id
      AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = h.security_id)
    LEFT JOIN fx_rates fx ON fx.currency = s.currency
    WHERE ${latestHoldingsPredicate()}
      AND (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
    ORDER BY current_value DESC NULLS LAST
  `;
  // "Latest" is keyed per-(account, security) via latestHoldingsPredicate,
  // never a per-account global MAX(as_of_date): a position that only
  // restates on the monthly statement (Treasuries, mutual funds) carries an
  // older as_of_date than the daily broker/Plaid rows, and the per-account
  // MAX dropped it from the table entirely — with the table's totals and
  // allocation percentages then computed on the short list. QA finding
  // accounts-holdings--global-max-as-of-date-drops-19-live-positions-72k-treasuries.
  //
  // The predicate also carries quantity != 0 (not > 0), which is why the
  // WHERE clause above does not repeat it: shorts are real positions and
  // must render, but the closed-equity reconciler's quantity=0 tombstone
  // rows (written at the latest snapshot date to mark statement-disappeared
  // positions) are not. A tombstone IS the latest row for its (account,
  // security) pair, so per-pair keying still hides the closed position
  // rather than resurrecting the older non-zero row (QA 2026-07-11; All
  // Accounts view was silently dropping every short, understating position
  // count and Total).

  return db.prepare(sql).all() as AllHoldingsRow[];
}

export function getHoldingsByAccount(
  db: Database.Database,
  accountId: number,
  asOfDate?: string
): HoldingWithSecurity[] {
  // Cost basis fallback — see getAllHoldings above for the Plaid-NULL
  // rationale; same pattern as getCrossAccountPositions. Inner alias h3
  // stays distinct from the h2 that latestHoldingsPredicate uses inside its
  // own subquery.
  const costBasisExpr = scaledCostBasisFallbackSQL("h", "h3");

  let sql = `
    SELECT h.*, s.symbol, s.name as security_name, s.security_type, a.name as account_name,
           s.underlying_symbol, s.strike_price, s.expiration_date, s.option_type,
           COALESCE(s.multiplier, 1) as multiplier,
           ${costBasisExpr} * COALESCE(fx.usd_per_unit, 1) as cost_basis
    FROM holdings h
    JOIN securities s ON s.id = h.security_id
    JOIN accounts a ON a.id = h.account_id
    LEFT JOIN fx_rates fx ON fx.currency = s.currency
    WHERE h.account_id = ?
  `;
  const params: (number | string)[] = [accountId];

  if (asOfDate) {
    // Explicit date = point-in-time snapshot: every row stamped that exact
    // date. quantity != 0 (not > 0) is spelled out here because the default
    // branch's predicate is not in play: shorts are real positions and must
    // render, but the closed-equity reconciler's quantity=0 tombstone rows
    // (written at the latest snapshot date to mark statement-disappeared
    // positions) are not — pre-filter they surfaced as "0 shares" holdings
    // (QA 2026-07-11).
    sql += " AND h.quantity != 0 AND h.as_of_date = ?";
    params.push(asOfDate);
  } else {
    // Default read keys "latest" per-(account, security), never a
    // per-account global MAX(as_of_date): a position that only restates on
    // the monthly statement (Treasuries, mutual funds) carries an older
    // as_of_date than the daily broker/Plaid rows, and the per-account MAX
    // dropped it from the table entirely — with the table's totals and
    // allocation percentages then computed on the short list. QA finding
    // accounts-holdings--global-max-as-of-date-drops-19-live-positions-72k-treasuries.
    //
    // latestHoldingsPredicate carries the quantity != 0 clause itself (same
    // shorts-yes / tombstones-no contract as above), so it is not repeated;
    // a tombstone IS the latest row for its (account, security) pair, so
    // per-pair keying still hides the closed position rather than
    // resurrecting the older non-zero row. accountFilter is empty because
    // the WHERE clause already binds h.account_id = ?.
    sql += ` AND ${latestHoldingsPredicate({ accountFilter: "" })}`;
    // Parity with getAllHoldings: a matured bond/bill that escaped
    // purgeMaturedBondHoldings must not surface as a live position under
    // per-pair "latest" keying (2026-08-30 landing-review nit). The explicit
    // asOfDate branch above deliberately keeps it — a point-in-time snapshot
    // legitimately shows a bond that had not matured on that date.
    sql += " AND (s.maturity_date IS NULL OR s.maturity_date >= date('now'))";
  }

  sql += " ORDER BY s.symbol";

  return db.prepare(sql).all(...params) as HoldingWithSecurity[];
}

export function getLatestHoldingsDate(
  db: Database.Database,
  accountId: number
): string | null {
  const result = db
    .prepare(
      "SELECT MAX(as_of_date) as latest FROM holdings WHERE account_id = ?"
    )
    .get(accountId) as { latest: string | null };
  return result?.latest ?? null;
}
