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

/**
 * A refresh that could not price an implied move (TWS down, Web API
 * unconfigured, no stored IV) writes NULL straddle columns. Before 2026-11-08
 * the conflict clause copied those NULLs over a stored straddle, so one
 * weekend page view erased every pre-print implied move until TWS returned.
 * Now a row with no `impliedMethod` keeps the stored implied move and the
 * `computed_at` that dates it (the chip's age stays honest); `spot` still
 * refreshes when the new row has one. A row that carries an implied move
 * replaces the stored one as before.
 */
export function upsertEarningsIntel(db: Database.Database, row: EarningsIntelUpsert): void {
  db.prepare(
    `INSERT INTO earnings_intel (event_id, implied_move_pct, implied_method, expiry_used, straddle_mid, spot, computed_at)
     VALUES (@eventId, @impliedMovePct, @impliedMethod, @expiryUsed, @straddleMid, @spot, @computedAt)
     ON CONFLICT(event_id) DO UPDATE SET
       implied_move_pct = CASE WHEN excluded.implied_method IS NULL THEN earnings_intel.implied_move_pct ELSE excluded.implied_move_pct END,
       implied_method   = CASE WHEN excluded.implied_method IS NULL THEN earnings_intel.implied_method   ELSE excluded.implied_method   END,
       expiry_used      = CASE WHEN excluded.implied_method IS NULL THEN earnings_intel.expiry_used      ELSE excluded.expiry_used      END,
       straddle_mid     = CASE WHEN excluded.implied_method IS NULL THEN earnings_intel.straddle_mid     ELSE excluded.straddle_mid     END,
       spot             = COALESCE(excluded.spot, earnings_intel.spot),
       computed_at      = CASE
                            WHEN excluded.implied_method IS NULL AND earnings_intel.implied_method IS NOT NULL
                              THEN earnings_intel.computed_at
                            ELSE excluded.computed_at
                          END`
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
