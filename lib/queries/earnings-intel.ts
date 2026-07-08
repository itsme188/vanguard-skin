import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { parseStoredTimestamp } from "@/lib/format";
import type { ReportHistoryRow } from "@/lib/mutations/earnings-intel";

export interface EarningsIntelRow {
  eventId: number;
  impliedMovePct: number | null;
  impliedMethod: "straddle" | "iv_approx" | null;
  expiryUsed: string | null;
  straddleMid: number | null;
  spot: number | null;
  computedAt: string;
}

const HISTORY_STALE_DAYS = 70;

export function getIntelForEvents(db: Database.Database, eventIds: number[]): Map<number, EarningsIntelRow> {
  const out = new Map<number, EarningsIntelRow>();
  if (eventIds.length === 0) return out;
  const placeholders = eventIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT event_id AS eventId, implied_move_pct AS impliedMovePct, implied_method AS impliedMethod,
            expiry_used AS expiryUsed, straddle_mid AS straddleMid, spot, computed_at AS computedAt
     FROM earnings_intel WHERE event_id IN (${placeholders})`
  ).all(...eventIds) as EarningsIntelRow[];
  for (const r of rows) out.set(r.eventId, r);
  return out;
}

function familyPlaceholders(symbol: string): { list: string; syms: string[] } {
  const syms = issuerSiblings(symbol).map((s) => s.toUpperCase());
  return { list: syms.map(() => "?").join(","), syms };
}

export function getReportHistoryForFamily(
  db: Database.Database,
  symbol: string,
  limit = 8,
): ReportHistoryRow[] {
  const { list, syms } = familyPlaceholders(symbol);
  return db.prepare(
    `SELECT reported_date AS reportedDate, fiscal_date_ending AS fiscalDateEnding,
            eps_actual AS epsActual, eps_estimate AS epsEstimate, surprise_pct AS surprisePct,
            report_time AS reportTime, post_print_move_pct AS postPrintMovePct
     FROM earnings_report_history
     WHERE symbol IN (${list})
     ORDER BY reported_date DESC LIMIT ?`
  ).all(...syms, limit) as ReportHistoryRow[];
}

export function isHistoryStale(db: Database.Database, symbol: string): boolean {
  const { list, syms } = familyPlaceholders(symbol);
  const row = db.prepare(
    `SELECT MAX(fetched_at) AS latest FROM earnings_report_history WHERE symbol IN (${list})`
  ).get(...syms) as { latest: string | null };
  if (!row.latest) return true;
  const ageMs = Date.now() - parseStoredTimestamp(row.latest).getTime();
  return ageMs > HISTORY_STALE_DAYS * 24 * 60 * 60 * 1000;
}
