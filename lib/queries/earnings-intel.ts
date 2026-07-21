import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { parseStoredTimestamp } from "@/lib/format";
import type { ReportHistoryRow } from "@/lib/mutations/earnings-intel";
import { summarizeHistory } from "@/lib/earnings/report-history";
import type { CockpitPayload, CockpitIntel, CockpitRow } from "@/lib/queries/earnings-cockpit";
// NOTE: do NOT import `IntelEvent` from "@/lib/earnings/intel" here — that
// module imports `isHistoryStale` from this file, so a value/type import
// back would form a cycle. cockpitRowsToIntelEvents below returns the
// structural shape inline instead (matches IntelEvent by field shape).

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

function allCockpitRows(payload: CockpitPayload): CockpitRow[] {
  return [...payload.lanes.bmo, ...payload.lanes.amc, ...payload.lanes.unknown, ...payload.carryover];
}

/**
 * Structural IntelEvent shape (see note above on why this isn't imported).
 *
 * INVARIANT — never re-ensure a released event: the preview-time intel row
 * (straddle mid / implied move) is the recap's "priced-in" anchor (spec
 * §recap: "no recompute post-print" — lib/digest/send-earnings-email.ts
 * ~1215). Once release has occurred, the options chain has moved past the
 * pre-print quote (after-hours gap, post-crush IV), so recomputing here would
 * have `upsertEarningsIntel` silently overwrite the pre-print straddle row
 * with a post-print value — the recap would then present post-print pricing
 * as "what the options market priced in", and the nightly R2 snapshot would
 * carry the poisoned value on to the Worker. The cached row is still
 * DECORATED for display via decorateCockpitIntel below (read-only) — it's
 * only re-ensuring (fetch + upsert) that's forbidden post-print.
 *
 * `row.stages.released.state` (from deriveEventStages, cockpit-stages.ts) is
 * the authoritative discriminant: "released" covers both a same-day row past
 * its known release_time AND a carryover (yesterday's unfinished) row, which
 * cockpit-stages.ts marks "released" via its isPastDay fallback even without
 * a known release time. "upcoming"/"unknown" rows have not released yet and
 * still flow through to ensureIntelForEvents.
 */
export function cockpitRowsToIntelEvents(
  payload: CockpitPayload
): { id: number; symbol: string; event_date: string; event_time: string | null }[] {
  return allCockpitRows(payload)
    .filter((r) => r.stages.released.state !== "released")
    .map((r) => ({
      id: r.eventId,
      symbol: r.symbol,
      event_date: r.eventDate,
      event_time: r.eventTime,
    }));
}

/**
 * Decorates every row across all lanes + carryover with cached implied-move
 * intel + history summary. Read-only DB access, mutates rows in place. Never
 * fetches over the network — callers run ensureIntelForEvents first.
 */
export function decorateCockpitIntel(db: Database.Database, payload: CockpitPayload): void {
  const rows = allCockpitRows(payload);
  if (rows.length === 0) return;
  const intelMap = getIntelForEvents(db, rows.map((r) => r.eventId));
  // Family-level history cache: GOOG + GOOGL rows share one read.
  const historyByFamily = new Map<string, ReportHistoryRow[]>();
  for (const row of rows) {
    const intel = intelMap.get(row.eventId);
    const famKey = issuerSiblings(row.symbol).map((s) => s.toUpperCase()).sort().join("|");
    let history = historyByFamily.get(famKey);
    if (!history) {
      history = getReportHistoryForFamily(db, row.symbol, 8);
      historyByFamily.set(famKey, history);
    }
    if (!intel && history.length === 0) {
      row.intel = null;
      continue;
    }
    const summary = summarizeHistory(history);
    row.intel = {
      impliedMovePct: intel?.impliedMovePct ?? null,
      impliedMethod: intel?.impliedMethod ?? null,
      histAvgAbsMovePct: summary.avgAbsMovePct,
      histBeatCount: summary.beatCount,
      histQuarterCount: summary.quarterCount,
    } satisfies CockpitIntel;
  }
}
