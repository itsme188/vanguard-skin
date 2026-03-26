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
       (account_id, valuation_date, cash_balance, holdings_value, total_value, holdings_count, priced_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    // Use most recent price on or before this date, within staleness window.
    // This carries forward month-end prices for mutual funds/bonds that lack
    // daily pricing, eliminating the month-end spike artifacts.
    const getPrice = db.prepare(
      `SELECT close_price FROM prices
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

        for (const holding of holdings) {
          const price = getPrice.get(holding.security_id, date, date) as PriceRow | undefined;

          if (price) {
            holdingsValue += marketValue(holding.quantity, price.close_price, holding.security_type, holding.multiplier);
            pricedCount++;
          }
        }

        if (pricedCount === 0) continue;

        const cashBalance = 0; // Cash tracking could be added later
        const totalValue = cashBalance + holdingsValue;

        insertValuation.run(
          account.account_id,
          date,
          cashBalance,
          holdingsValue,
          totalValue,
          holdings.length,
          pricedCount
        );

        datesComputed++;
        accountsProcessed.add(account.account_id);
      }
    }

    return { datesComputed, accountsProcessed: accountsProcessed.size };
  })();
}
