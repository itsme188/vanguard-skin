/**
 * Past-print history for the earnings intelligence tier (audit §4C #10).
 * Surprise history from Alpha Vantage EARNINGS (free tier; key shared with
 * transcripts — callers cap invocations); post-print moves from Yahoo daily
 * closes. Own calendar_events history is one season deep — NOT the source.
 */
import type Database from "better-sqlite3";
import { fetchYahooDailyCloses, type DailyClose } from "@/lib/quotes/yahoo-daily";
import { replaceReportHistory, type ReportHistoryRow } from "@/lib/mutations/earnings-intel";

export interface AvReport {
  fiscalDateEnding: string | null;
  reportedDate: string;
  reportedEPS: number | null;
  estimatedEPS: number | null;
  surprisePercentage: number | null;
  reportTime: "pre-market" | "post-market" | null;
}

const KEEP_QUARTERS = 12;
const SUMMARY_QUARTERS = 8;

function num(v: unknown): number | null {
  if (v == null || v === "None" || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

export async function fetchAvEarningsHistory(
  symbol: string,
  deps: { apiKey: string; fetchImpl?: typeof fetch },
): Promise<AvReport[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const url =
      `https://www.alphavantage.co/query?function=EARNINGS` +
      `&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(deps.apiKey)}`;
    const resp = await fetchImpl(url);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { quarterlyEarnings?: Array<Record<string, unknown>> };
    const q = json.quarterlyEarnings;
    if (!Array.isArray(q)) return []; // covers AV "Note"/"Information" rate-limit payloads
    return q
      .filter((r) => typeof r.reportedDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.reportedDate as string))
      .sort((a, b) => ((a.reportedDate as string) < (b.reportedDate as string) ? 1 : -1))
      .slice(0, KEEP_QUARTERS)
      .map((r) => ({
        fiscalDateEnding: typeof r.fiscalDateEnding === "string" ? r.fiscalDateEnding : null,
        reportedDate: r.reportedDate as string,
        reportedEPS: num(r.reportedEPS),
        estimatedEPS: num(r.estimatedEPS),
        surprisePercentage: num(r.surprisePercentage),
        reportTime:
          r.reportTime === "pre-market" || r.reportTime === "post-market" ? r.reportTime : null,
      }));
  } catch {
    return [];
  }
}

/**
 * Post-print move conventions (next-day close proxy; intraday T+2h is not
 * reconstructable for past quarters):
 *   post-market (or unknown): (close[D+1] − close[D]) / close[D]
 *   pre-market:               (close[D]   − close[D−1]) / close[D−1]
 * where D = last trading day ≤ reportedDate (post) / first ≥ reportedDate (pre),
 * and D±1 are ADJACENT rows in the (ascending) close series.
 */
export function computePostPrintMoves(
  reports: AvReport[],
  closes: DailyClose[],
): ReportHistoryRow[] {
  const sorted = [...closes].sort((a, b) => (a.date < b.date ? -1 : 1));
  return reports.map((r) => {
    let movePct: number | null = null;
    if (sorted.length > 0) {
      if (r.reportTime === "pre-market") {
        const di = sorted.findIndex((c) => c.date >= r.reportedDate);
        if (di > 0) movePct = ((sorted[di].close - sorted[di - 1].close) / sorted[di - 1].close) * 100;
      } else {
        let di = -1;
        for (let i = sorted.length - 1; i >= 0; i--) {
          if (sorted[i].date <= r.reportedDate) { di = i; break; }
        }
        if (di >= 0 && di + 1 < sorted.length) {
          movePct = ((sorted[di + 1].close - sorted[di].close) / sorted[di].close) * 100;
        }
      }
    }
    return {
      reportedDate: r.reportedDate,
      fiscalDateEnding: r.fiscalDateEnding,
      epsActual: r.reportedEPS,
      epsEstimate: r.estimatedEPS,
      surprisePct: r.surprisePercentage,
      reportTime: r.reportTime,
      postPrintMovePct: movePct != null && Number.isFinite(movePct) ? movePct : null,
    };
  });
}

export interface HistorySummary {
  avgAbsMovePct: number | null;
  beatCount: number;
  missCount: number;
  quarterCount: number;
}

export function summarizeHistory(rows: ReportHistoryRow[]): HistorySummary {
  const recent = rows.slice(0, SUMMARY_QUARTERS);
  const moves = recent.map((r) => r.postPrintMovePct).filter((m): m is number => m != null);
  let beat = 0, miss = 0;
  for (const r of recent) {
    if (r.epsActual == null || r.epsEstimate == null) continue;
    if (r.epsActual > r.epsEstimate) beat++;
    else if (r.epsActual < r.epsEstimate) miss++;
  }
  return {
    avgAbsMovePct: moves.length
      ? moves.reduce((a, m) => a + Math.abs(m), 0) / moves.length
      : null,
    beatCount: beat,
    missCount: miss,
    quarterCount: recent.length,
  };
}

/** Fetch AV + Yahoo and rewrite the symbol's history cache. Never throws. */
export async function refreshReportHistory(
  db: Database.Database,
  symbol: string,
  deps: { apiKey?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : (process.env.ALPHA_VANTAGE_API_KEY ?? null);
  if (!apiKey) return false;
  try {
    const reports = await fetchAvEarningsHistory(symbol, { apiKey, fetchImpl: deps.fetchImpl });
    if (reports.length === 0) return false;
    const oldest = reports[reports.length - 1].reportedDate;
    const from = new Date(Date.parse(`${oldest}T00:00:00Z`) - 7 * 86400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const closes = await fetchYahooDailyCloses(symbol, from, to, deps.fetchImpl ?? fetch);
    replaceReportHistory(db, symbol, computePostPrintMoves(reports, closes));
    return true;
  } catch (e) {
    console.warn(`[earnings-intel] history refresh failed for ${symbol}:`, e);
    return false;
  }
}
