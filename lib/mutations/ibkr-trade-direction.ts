import type Database from "better-sqlite3";
import type { ParsedTransaction } from "@/lib/import/types";
import { readIbkrTradeDirection } from "@/lib/import/ibkr-trade-direction";
import { bumpTaxGenerationIfPresent } from "@/lib/compute/tax-convention";

/** Backfill evidence only, never rewrite cash, quantity, identities or source keys. */
export function backfillIbkrTradeDirection(
  db: Database.Database, batchId: number, parsed: ParsedTransaction[], apply = false,
) {
  return db.transaction(() => {
    const report = { matched: 0, changed: 0, unchanged: 0, refused: 0 };
    const select = db.prepare(`SELECT t.id, t.trade_date, t.quantity, t.amount, t.notes,
      s.symbol FROM transactions t JOIN securities s ON s.id=t.security_id
      WHERE t.import_batch_id=? AND t.source_key=?`);
    const update = db.prepare("UPDATE transactions SET notes=? WHERE id=?");
    for (const tx of parsed) {
      if (!tx.sourceKey.startsWith("ibkr:trade:") || !readIbkrTradeDirection(tx.notes)) continue;
      const row = select.get(batchId, tx.sourceKey) as {
        id: number; trade_date: string; quantity: number; amount: number; notes: string | null; symbol: string;
      } | undefined;
      if (!row) { report.refused++; continue; }
      if (row.trade_date !== tx.tradeDate || row.symbol !== tx.symbol ||
          tx.quantity == null || tx.amount == null ||
          Math.abs(row.quantity - tx.quantity) > 1e-8 || Math.abs(row.amount - tx.amount) > 0.005) {
        report.refused++; continue;
      }
      report.matched++;
      const existing = readIbkrTradeDirection(row.notes);
      const incoming = readIbkrTradeDirection(tx.notes);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(incoming)) report.unchanged++;
        else report.refused++;
        continue;
      }
      report.changed++;
      if (apply) update.run([row.notes, tx.notes].filter(Boolean).join("\n"), row.id);
    }
    if (apply && report.changed) bumpTaxGenerationIfPresent(db);
    return report;
  })();
}
