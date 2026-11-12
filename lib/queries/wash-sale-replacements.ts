/**
 * Where an engine-named wash-sale replacement purchase was bought.
 *
 * `detectWashSales` (lib/compute/tax-report.ts) scans every account's lots
 * (opening-snapshot lots excluded) and names the replacement by security and
 * date only. This reads the accounts holding a lot of that security bought
 * on that date, from the same lot set. Read-only; no figure is computed.
 * Readers: the chat's realized-gains tool and the chat Portfolio Context.
 */
import type Database from "better-sqlite3";

/** Account names, sorted, holding a lot of `symbol` acquired on `date`. */
export function washSaleReplacementAccounts(db: Database.Database, symbol: string, date: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.name FROM tax_lots tl
         JOIN securities s ON s.id = tl.security_id
         JOIN accounts a ON a.id = tl.account_id
        WHERE s.symbol = ? AND tl.acquisition_date = ? AND tl.is_from_opening_snapshot = 0
        ORDER BY a.name`,
    )
    .all(symbol, date) as { name: string }[];
  return rows.map((r) => r.name);
}
