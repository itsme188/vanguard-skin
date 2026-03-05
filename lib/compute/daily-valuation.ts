import type Database from "better-sqlite3";
import { marketValue } from "@/lib/valuation";

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
       (account_id, valuation_date, cash_balance, holdings_value, total_value)
       VALUES (?, ?, ?, ?, ?)`
    );

    let datesComputed = 0;
    const accountsProcessed = new Set<number>();

    for (const account of accounts) {
      for (const { date } of priceDates) {
        // Get holdings as of this date (most recent snapshot on or before this date)
        const holdings = db
          .prepare(
            `SELECT h.security_id, h.quantity, s.security_type, h.as_of_date
             FROM holdings h
             JOIN securities s ON s.id = h.security_id
             WHERE h.account_id = ?
               AND h.as_of_date = (
                 SELECT MAX(h2.as_of_date)
                 FROM holdings h2
                 WHERE h2.account_id = h.account_id
                   AND h2.security_id = h.security_id
                   AND h2.as_of_date <= ?
               )
             GROUP BY h.security_id`
          )
          .all(account.account_id, date) as HoldingRow[];

        if (holdings.length === 0) continue;

        let holdingsValue = 0;
        let hasAnyPrice = false;

        for (const holding of holdings) {
          // Get price for this security on this date
          const price = db
            .prepare(
              "SELECT close_price FROM prices WHERE security_id = ? AND date = ?"
            )
            .get(holding.security_id, date) as PriceRow | undefined;

          if (price) {
            holdingsValue += marketValue(holding.quantity, price.close_price, holding.security_type);
            hasAnyPrice = true;
          }
        }

        if (!hasAnyPrice) continue;

        const cashBalance = 0; // Cash tracking could be added later
        const totalValue = cashBalance + holdingsValue;

        insertValuation.run(
          account.account_id,
          date,
          cashBalance,
          holdingsValue,
          totalValue
        );

        datesComputed++;
        accountsProcessed.add(account.account_id);
      }
    }

    return { datesComputed, accountsProcessed: accountsProcessed.size };
  })();
}
