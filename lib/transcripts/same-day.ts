/**
 * Same-day transcript orchestrator (#12 B1).
 *
 * Runs as the LAST step of the earnings email sweep (after `alertBlockedRecaps`
 * — see lib/calendar/email-sweep.ts). For each held/watchlist earnings print
 * whose actuals have landed within the last 36h, kicks off `fetchTranscript`
 * (lib/transcripts/fetch.ts) so a transcript is warm in cache by the time the
 * user or the recap composer wants one, without waiting for someone to open
 * the chat tool and trigger a cold fetch.
 *
 * Candidate criteria (all must hold):
 *   - calendar_events row is an earnings print (event_type='earnings' OR
 *     source='finnhub'), not superseded, has a symbol + release_time
 *   - actual_value IS NOT NULL (the print has happened)
 *   - release instant is within the last 36h (composeReleaseInstant — JS
 *     window filter, release_time is ET wall-clock, see enrichment-runner's
 *     header note on why this can't be a SQL datetime() comparison)
 *   - family-deduped (dedupeByFamily below — mirrors
 *     lib/earnings/wrap.ts::dedupeByFamily / enrichment-runner's
 *     dedupeCrossSourceRows, neither of which is exported)
 *   - held or watchlist (getSymbolStatus)
 *   - no cached transcript for the (ticker, filing-reporting year, quarter)
 *     derived from event_date via deriveFilingReportingQuarter
 *   - transcript_attempted_at is NULL or >=30 min old (pacing — compared via
 *     SQLite datetime() on both sides per repo convention, never raw string
 *     compare)
 *
 * `transcript_attempted_at` is stamped BEFORE the fetchTranscript call so a
 * hung fetch can't hot-loop the sweep on the next tick. A cache hit is not an
 * "attempt" — it doesn't stamp and doesn't count toward maxAttempts. Never
 * throws: a fetchTranscript failure is caught per-candidate so the rest of
 * the sweep (and any remaining candidates this tick) proceeds.
 *
 * AI desk-note summary (#12 B2): once a candidate's transcript is
 * successfully fetched (i.e. `result` is non-null), `summarizeTranscript`
 * regenerates a structured desk note (guidance / tone / surprises / key
 * quotes) via the `transcriptSummary` feature key and stores it over the
 * cached row's `summary` column — every other column is echoed back
 * unchanged since `upsertTranscript` is a full-replace UPSERT keyed on
 * `source_key`. No-ops (no AI call) when the transcript has no text. Never
 * throws: an AI failure/refusal leaves fetchTranscript's own extractive
 * summary in place, and is caught independently of the fetch-failure catch
 * below so a summarize failure is never misreported as a fetch failure.
 */

import type Database from "better-sqlite3";
import { fetchTranscript, deriveFilingReportingQuarter } from "@/lib/transcripts/fetch";
import { stripModelPreamble } from "@/lib/ai/strip-preamble";
import { getCachedTranscript } from "@/lib/queries/transcripts";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { generateTextForFeature } from "@/lib/ai/generate";
import { upsertTranscript } from "@/lib/mutations/transcripts";
import type { EarningsTranscript } from "@/lib/types";

const PACING_MS = 30 * 60 * 1000; // 30 minutes between attempts per event
const DEADLINE_MS = 36 * 60 * 60 * 1000; // 36h same-day-ish window from release
const DEFAULT_MAX_ATTEMPTS = 2;

const SUMMARY_PROMPT_CHAR_CAP = 50_000;
const SUMMARY_MAX_OUTPUT_TOKENS = 900;

function buildSummaryPrompt(transcriptText: string): string {
  const text = transcriptText.slice(0, SUMMARY_PROMPT_CHAR_CAP);
  return `You are writing a structured desk note from an earnings call transcript, for a portfolio manager who already knows the company and just needs the highlights. Cover, in this order:

- **Guidance**: what management said about forward guidance (raised / inline / lowered / not given — and the specifics if any were given)
- **Tone**: management's overall tone on the call (confident, cautious, defensive, evasive, etc.)
- **Surprises**: anything that surprised relative to expectations, positive or negative
- **Key quotes**: 2-3 short direct quotes from the call that best support the above

Plain markdown (short headers + bullets), no preamble, no closing commentary, nothing about the transcript itself — just the desk note. Keep the entire note to 300 words or fewer.

Transcript:
${text}`;
}

/**
 * Regenerate the AI desk-note summary for a freshly-fetched transcript and
 * store it over the cached row (see file header for the contract). Pure
 * side effect on the DB; never throws.
 */
export async function summarizeTranscript(
  db: Database.Database,
  transcript: EarningsTranscript,
): Promise<void> {
  const text = transcript.transcript;
  if (!text || text.trim().length === 0) return;

  try {
    const res = await generateTextForFeature("transcriptSummary", {
      prompt: buildSummaryPrompt(text),
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    });
    // Guard against the known Sonnet failure mode of a leaked preamble
    // ("Good, now I have enough to write the desk note...") ahead of the
    // structured markdown — this summary is user-facing (rendered in the
    // morning digest, #12 B3), so strip at STORE time. Mirrors the
    // stripModelPreamble post-processor in lib/digest/send-earnings-email.ts.
    const summary = stripModelPreamble(res.text.trim());
    if (!summary) return;

    upsertTranscript(db, {
      security_id: transcript.security_id,
      ticker: transcript.ticker,
      year: transcript.year,
      quarter: transcript.quarter,
      call_date: transcript.call_date,
      source: transcript.source,
      transcript: transcript.transcript,
      summary,
      // Structured-output fields other than summary are deliberately left
      // untouched (brief B2 #3) — the model's prose is stored whole in
      // `summary` rather than parsed back apart into guidance/risk_factors.
      guidance: transcript.guidance,
      risk_factors: transcript.risk_factors,
      sentiment_score: transcript.sentiment_score,
      sentiment_label: transcript.sentiment_label,
      participants: transcript.participants,
      accession_number: transcript.accession_number,
      filing_url: transcript.filing_url,
      source_key: transcript.source_key,
    });
  } catch (err) {
    console.warn(
      `[same-day-transcripts] AI summary failed for ${transcript.ticker} ${transcript.year}Q${transcript.quarter} (extractive summary kept):`,
      err instanceof Error ? err.message : err,
    );
  }
}

interface CandidateRow {
  id: number;
  symbol: string | null;
  event_date: string;
  release_time: string | null;
  source: string;
}

/**
 * Collapse cross-source / dual-class duplicate rows for the same print down
 * to one survivor, so a GOOG row and a GOOGL row (or a finnhub + nasdaq row
 * for the same symbol) don't each burn a fetch attempt for what's really one
 * transcript. Same rank/tie-break rule as the sibling dedupers this mirrors:
 * finnhub wins, ties broken by lowest event id.
 */
function dedupeByFamily(rows: CandidateRow[]): CandidateRow[] {
  const rank = (r: CandidateRow) => (r.source === "finnhub" ? 0 : 1);
  const keyOf = (r: CandidateRow) =>
    [...issuerSiblings(r.symbol ?? "")].map((s) => s.toUpperCase()).sort().join(",");
  const winners = new Map<string, CandidateRow>();
  for (const row of rows) {
    const key = keyOf(row);
    const cur = winners.get(key);
    if (!cur || rank(row) < rank(cur) || (rank(row) === rank(cur) && row.id < cur.id)) {
      winners.set(key, row);
    }
  }
  return rows.filter((row) => winners.get(keyOf(row)) === row);
}

export interface FetchSameDayTranscriptsResult {
  attempted: number;
  fetched: number;
}

export async function fetchSameDayTranscripts(
  db: Database.Database,
  opts: { now?: Date; maxAttempts?: number } = {},
): Promise<FetchSameDayTranscriptsResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  // Cheap SQL pre-filter: earnings rows with actuals, not superseded, not
  // recently attempted. event_date range mirrors enrichment-runner's
  // findCandidates (3-day lookback covers the 36h deadline with slack for
  // ET/UTC date-boundary drift). Final release-instant window check happens
  // in JS below — release_time is ET wall-clock.
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const threeDaysAgo = new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const pacingCutoff = new Date(nowMs - PACING_MS).toISOString().replace("T", " ").slice(0, 19);

  const rows = db
    .prepare(
      `SELECT id, symbol, event_date, release_time, source
         FROM calendar_events
        WHERE (event_type = 'earnings' OR source = 'finnhub')
          AND COALESCE(superseded, 0) = 0
          AND actual_value IS NOT NULL
          AND symbol IS NOT NULL
          AND release_time IS NOT NULL
          AND event_date BETWEEN ? AND ?
          AND (transcript_attempted_at IS NULL
               OR datetime(transcript_attempted_at) <= datetime(?))
        ORDER BY event_date DESC, release_time DESC`,
    )
    .all(threeDaysAgo, today, pacingCutoff) as CandidateRow[];

  const inWindow = rows.filter((row) => {
    const releaseInstant = composeReleaseInstant(row.event_date, row.release_time!);
    if (!releaseInstant) return false;
    const ageMs = nowMs - releaseInstant.getTime();
    return ageMs >= 0 && ageMs <= DEADLINE_MS;
  });

  const deduped = dedupeByFamily(inWindow);
  if (deduped.length === 0) return { attempted: 0, fetched: 0 };

  const symbols = Array.from(
    new Set(deduped.map((r) => r.symbol!.toUpperCase())),
  );
  const status = getSymbolStatus(db, symbols);
  const covered = deduped.filter((r) => {
    const st = status[r.symbol!.toUpperCase()];
    return st === "held" || st === "watchlist";
  });

  const stampAttempted = db.prepare(
    `UPDATE calendar_events SET transcript_attempted_at = datetime('now') WHERE id = ?`,
  );

  let attempted = 0;
  let fetched = 0;

  for (const row of covered) {
    if (attempted >= maxAttempts) break;

    const symbol = row.symbol!.toUpperCase();
    const { year, quarter } = deriveFilingReportingQuarter(row.event_date);

    // A cache hit is not an attempt — don't stamp, don't burn the budget.
    const cached = getCachedTranscript(db, symbol, year, quarter);
    if (cached) continue;

    // Stamp BEFORE the fetch attempt so a hung fetchTranscript call can't
    // hot-loop the next sweep tick.
    stampAttempted.run(row.id);
    attempted += 1;

    try {
      const result = await fetchTranscript(db, symbol, year, quarter);
      if (result) {
        fetched += 1;
        await summarizeTranscript(db, result.transcript);
      }
    } catch (err) {
      console.warn(
        `[same-day-transcripts] fetch failed for event ${row.id} (${symbol} ${year}Q${quarter}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { attempted, fetched };
}
