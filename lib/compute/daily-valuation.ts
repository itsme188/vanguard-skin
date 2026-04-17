import type Database from "better-sqlite3";
import { marketValue } from "@/lib/valuation";

/** Don't carry a price forward more than 45 days — beyond that, the position
 *  was likely liquidated or the data is too stale to be meaningful. */
const PRICE_STALENESS_DAYS = 45;

interface DailyValuationResult {
  datesComputed: number;
  accountsProcessed: number;
}

interface PriceDateRow {
  date: string;
}

interface HoldingRow {
  security_id: number;
  quantity: number;
  security_type: string | null;
  multiplier: number;
  as_of_date: string;
}

interface PriceRow {
  close_price: number;
  price_date: string;
}

interface CashAnchor {
  month_end_date: string;
  snapshot_total: number;
  holdings_value: number | null;
  cash_value: number | null;
}

export function computeDailyValuations(db: Database.Database): DailyValuationResult {
  return db.transaction(() => {
    // Clear existing valuations
    db.prepare("DELETE FROM daily_valuations").run();

    // Get all accounts that have holdings
    const accounts = db
      .prepare(
        "SELECT DISTINCT account_id FROM holdings ORDER BY account_id"
      )
      .all() as { account_id: number }[];

    // Get all dates that have price data
    const priceDates = db
      .prepare("SELECT DISTINCT date FROM prices ORDER BY date")
      .all() as PriceDateRow[];

    const insertValuation = db.prepare(
      `INSERT OR REPLACE INTO daily_valuations
       (account_id, valuation_date, cash_balance, holdings_value, total_value, holdings_count, priced_count, data_quality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // Use most recent price on or before this date, within staleness window.
    // This carries forward month-end prices for mutual funds/bonds that lack
    // daily pricing, eliminating the month-end spike artifacts.
    const getPrice = db.prepare(
      `SELECT close_price, date AS price_date FROM prices
       WHERE security_id = ? AND date <= ? AND date >= date(?, '-${PRICE_STALENESS_DAYS} days')
       ORDER BY date DESC LIMIT 1`
    );

    // Use the most recent overall holdings snapshot for this account, not
    // per-security MAX. This prevents "ghost holdings" — securities from older
    // snapshots that no longer appear in the latest statement (i.e., sold).
    const getHoldings = db.prepare(
      `SELECT h.security_id, h.quantity, s.security_type, COALESCE(s.multiplier, 1) AS multiplier, h.as_of_date
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE h.account_id = ?
         AND h.as_of_date = (
           SELECT MAX(h2.as_of_date)
           FROM holdings h2
           WHERE h2.account_id = h.account_id
             AND h2.as_of_date <= ?
         )
       GROUP BY h.security_id`
    );

    let datesComputed = 0;
    const accountsProcessed = new Set<number>();

    for (const account of accounts) {
      for (const { date } of priceDates) {
        // Get holdings as of this date (most recent snapshot on or before this date)
        const holdings = getHoldings.all(account.account_id, date) as HoldingRow[];

        if (holdings.length === 0) continue;

        let holdingsValue = 0;
        let pricedCount = 0;
        let maxPriceStaleDays = 0;

        for (const holding of holdings) {
          const price = getPrice.get(holding.security_id, date, date) as PriceRow | undefined;

          if (price) {
            holdingsValue += marketValue(holding.quantity, price.close_price, holding.security_type, holding.multiplier);
            pricedCount++;

            // Track staleness of the oldest price used in this valuation
            const priceDateMs = new Date(price.price_date).getTime();
            const valDateMs = new Date(date).getTime();
            const staleDays = Math.floor((valDateMs - priceDateMs) / 86_400_000);
            if (staleDays > maxPriceStaleDays) maxPriceStaleDays = staleDays;
          }
        }

        if (pricedCount === 0) continue;

        const cashBalance = 0; // Cash tracking could be added later
        const totalValue = cashBalance + holdingsValue;

        // Holdings staleness: how old is the holdings snapshot relative to valuation date?
        const holdingsAgeDays = Math.floor(
          (new Date(date).getTime() - new Date(holdings[0].as_of_date).getTime()) / 86_400_000
        );

        // Assess data quality: if holdings are from a prior date, always estimated
        const dataQuality =
          holdingsAgeDays > 0 ? "estimated" :
          pricedCount === holdings.length && maxPriceStaleDays <= 1 ? "live" :
          maxPriceStaleDays <= 3 ? "recent" :
          "estimated";

        insertValuation.run(
          account.account_id,
          date,
          cashBalance,
          holdingsValue,
          totalValue,
          holdings.length,
          pricedCount,
          dataQuality
        );

        datesComputed++;
        accountsProcessed.add(account.account_id);
      }
    }

    // Phase 2: Infer cash balances from monthly snapshot anchors.
    // At each snapshot date: cash = snapshot_total − computed_holdings_value.
    // Carry this cash forward until the next snapshot arrives.
    const getCashAnchors = db.prepare(
      `SELECT ms.month_end_date, ms.total_value AS snapshot_total, dv.holdings_value, ms.cash_value
       FROM monthly_snapshots ms
       LEFT JOIN daily_valuations dv
         ON dv.account_id = ms.account_id AND dv.valuation_date = ms.month_end_date
       WHERE ms.account_id = ?
       ORDER BY ms.month_end_date`
    );

    const updateCashRange = db.prepare(
      `UPDATE daily_valuations
       SET cash_balance = ?, total_value = holdings_value + ?
       WHERE account_id = ?
         AND valuation_date >= ?
         AND valuation_date < ?`
    );

    const updateCashFromDate = db.prepare(
      `UPDATE daily_valuations
       SET cash_balance = ?, total_value = holdings_value + ?
       WHERE account_id = ?
         AND valuation_date >= ?`
    );

    for (const account of accounts) {
      const anchors = getCashAnchors.all(account.account_id) as CashAnchor[];

      for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        if (anchor.holdings_value === null && anchor.cash_value === null) continue;

        // Prefer TWS-reported cash when available; fall back to inference
        const cashResidual = anchor.cash_value != null
          ? anchor.cash_value
          : anchor.holdings_value != null
            ? anchor.snapshot_total - anchor.holdings_value
            : 0;

        if (i < anchors.length - 1) {
          // Apply from this snapshot up to (but not including) the next
          updateCashRange.run(
            cashResidual, cashResidual,
            account.account_id,
            anchor.month_end_date, anchors[i + 1].month_end_date
          );
        } else {
          // Last snapshot — carry forward indefinitely
          updateCashFromDate.run(
            cashResidual, cashResidual,
            account.account_id,
            anchor.month_end_date
          );
        }
      }
    }

    return { datesComputed, accountsProcessed: accountsProcessed.size };
  })();
}
