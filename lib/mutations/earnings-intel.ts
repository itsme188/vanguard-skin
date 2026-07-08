import type Database from "better-sqlite3";

export interface EarningsIntelUpsert {
  eventId: number;
  impliedMovePct: number | null;
  impliedMethod: "straddle" | "iv_approx" | null;
  expiryUsed: string | null;
  straddleMid: number | null;
  spot: number | null;
  computedAt: string;
}

export interface ReportHistoryRow {
  reportedDate: string;
  fiscalDateEnding: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
  reportTime: "pre-market" | "post-market" | null;
  postPrintMovePct: number | null;
}

export function upsertEarningsIntel(db: Database.Database, row: EarningsIntelUpsert): void {
  db.prepare(
    `INSERT INTO earnings_intel (event_id, implied_move_pct, implied_method, expiry_used, straddle_mid, spot, computed_at)
     VALUES (@eventId, @impliedMovePct, @impliedMethod, @expiryUsed, @straddleMid, @spot, @computedAt)
     ON CONFLICT(event_id) DO UPDATE SET
       implied_move_pct = excluded.implied_move_pct,
       implied_method   = excluded.implied_method,
       expiry_used      = excluded.expiry_used,
       straddle_mid     = excluded.straddle_mid,
       spot             = excluded.spot,
       computed_at      = excluded.computed_at`
  ).run(row);
}

const KEEP_QUARTERS = 12;

export function replaceReportHistory(
  db: Database.Database,
  symbol: string,
  rows: ReportHistoryRow[],
): void {
  const sym = symbol.toUpperCase();
  const upsert = db.prepare(
    `INSERT INTO earnings_report_history
       (symbol, reported_date, fiscal_date_ending, eps_actual, eps_estimate, surprise_pct, report_time, post_print_move_pct, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(symbol, reported_date) DO UPDATE SET
       fiscal_date_ending = excluded.fiscal_date_ending,
       eps_actual = excluded.eps_actual,
       eps_estimate = excluded.eps_estimate,
       surprise_pct = excluded.surprise_pct,
       report_time = excluded.report_time,
       post_print_move_pct = excluded.post_print_move_pct,
       fetched_at = excluded.fetched_at`
  );
  const prune = db.prepare(
    `DELETE FROM earnings_report_history
     WHERE symbol = ? AND reported_date NOT IN (
       SELECT reported_date FROM earnings_report_history
       WHERE symbol = ? ORDER BY reported_date DESC LIMIT ${KEEP_QUARTERS})`
  );
  db.transaction(() => {
    for (const r of rows) {
      upsert.run(sym, r.reportedDate, r.fiscalDateEnding, r.epsActual, r.epsEstimate,
        r.surprisePct, r.reportTime, r.postPrintMovePct);
    }
    prune.run(sym, sym);
  })();
}
