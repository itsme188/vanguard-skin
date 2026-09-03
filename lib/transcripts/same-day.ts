/**
 * Same-day transcript orchestrator (#12 B1).
 *
 * Runs as the LAST step of the earnings email sweep (after `alertBlockedRecaps`
 * — see lib/calendar/email-sweep.ts). For each held/watchlist/armed earnings
 * print whose actuals have landed within the last 36h, kicks off `fetchTranscript`
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
 *   - held, watchlist, or armed (getSymbolStatus — symbol-only consumer,
 *     no event id to key coveredForEvents on, so armed counts too: spec §4.1)
 *   - no cached transcript for the (ticker, filing-reporting year, quarter)
 *     derived from event_date via deriveFilingReportingQuarter — EXCEPT a
 *     cached `edgar_8k` row, which is an UPGRADE candidate (see below)
 *   - transcript_attempted_at is NULL or >=30 min old (pacing — compared via
 *     SQLite datetime() on both sides per repo convention, never raw string
 *     compare)
 *
 * Cached-EDGAR upgrade candidates (thin-8-K fix, 2026-07-19): an EDGAR 8-K
 * row is a press-release excerpt, not a call transcript — and a THIN one
 * (cover page only, exhibit missing — NFLX Q2 was 4,091 chars) is worthless.
 * fetchTranscript already upgrades cached edgar rows via Alpha Vantage on
 * every cache hit, but this orchestrator's own cache check used to `continue`
 * before ever reaching it, so the first EDGAR fetch permanently excluded the
 * event from all future candidate lists. Now a cached edgar row keeps the
 * event a candidate on a SLOWER clock, because AV posts transcripts days
 * after the call: 10-day deadline from release (vs 36h fresh) and 24h pacing
 * (vs 30 min) so a name never costs more than ~1 AV call/day against the
 * 25/day free tier. Fresh candidates win the shared per-tick attempt budget
 * before upgrades. A FAILED upgrade (fetchTranscript echoes the cached edgar
 * row back with fromCache: true) counts as attempted but NOT fetched, and
 * must never re-run the AI desk note over the same edgar text.
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
 * `source_key`. No-ops (no AI call) when the transcript has no text, or
 * (2026-07-23) when it's under `MIN_TRANSCRIPT_CHARS_FOR_AI` — a thin 8-K
 * cover page has nothing to summarize and the AI will say so. Never throws:
 * an AI failure, a thrown error, OR a soft refusal that fails
 * `isValidDeskNote` (store-time validation, 2026-07-23 — a bulleted
 * "please provide the transcript" request survived both stripModelPreamble
 * and the refusal finish-reason guard and shipped in the 7/23 digest)
 * leaves fetchTranscript's own extractive summary in place, and is caught
 * independently of the fetch-failure catch below so a summarize failure is
 * never misreported as a fetch failure.
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
import { todayET, addDays } from "@/lib/calendar/date-utils";

const PACING_MS = 30 * 60 * 1000; // 30 minutes between attempts per event
const DEADLINE_MS = 36 * 60 * 60 * 1000; // 36h same-day-ish window from release
const UPGRADE_PACING_MS = 24 * 60 * 60 * 1000; // cached-EDGAR upgrades: 1 AV try/day
const UPGRADE_DEADLINE_MS = 10 * 24 * 60 * 60 * 1000; // …for up to 10 days from release
const DEFAULT_MAX_ATTEMPTS = 2;

const SUMMARY_PROMPT_CHAR_CAP = 50_000;
const SUMMARY_MAX_OUTPUT_TOKENS = 900;

/**
 * A desk note the prompt actually asked for carries at least one of the
 * mandated bold section labels. A soft refusal (model asking for its inputs
 * — the 2026-07-22 CSX leak) carries none, and typically asks the operator
 * to "please provide" content. stripModelPreamble can't catch this: the
 * refusal opened with a `- ` list marker (valid markdown), and the refusal
 * finish-reason guard can't either (finishReason was "stop").
 */
const DESK_NOTE_SECTION_RE = /\*\*(Guidance|Tone|Surprises|Key quotes)\*\*/i;
const DESK_NOTE_REFUSAL_RE =
  /please provide|provide the transcript|i(?:'|’)ll produce the|as specified[.,]?\s*$/im;

export function looksLikeDeskNoteRefusal(text: string): boolean {
  return DESK_NOTE_REFUSAL_RE.test(text);
}

export function isValidDeskNote(text: string): boolean {
  if (!text) return false;
  if (!DESK_NOTE_SECTION_RE.test(text)) return false;
  if (looksLikeDeskNoteRefusal(text)) return false;
  return true;
}

/** Below this, an 8-K is a bare cover page (observed thin covers: 3,774 and
 * 4,091 chars) — there is nothing for the AI to summarize, so don't ask. */
export const MIN_TRANSCRIPT_CHARS_FOR_AI = 5000;

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
  if (!transcript.transcript || transcript.transcript.length < MIN_TRANSCRIPT_CHARS_FOR_AI) {
    console.log(
      `[transcripts] Skipping AI desk note for ${transcript.ticker} Q${transcript.quarter}: transcript too thin (${transcript.transcript?.length ?? 0} chars)`,
    );
    return;
  }
  const text = transcript.transcript;

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
    if (!summary || !isValidDeskNote(summary)) {
      console.warn(
        `[transcripts] AI desk note for ${transcript.ticker} Q${transcript.quarter} rejected (not desk-note shaped) — extractive summary kept`,
      );
      return;
    }

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
  transcript_attempted_at: string | null;
}

/** Parse a SQLite datetime('now') stamp ("YYYY-MM-DD HH:MM:SS", UTC) to ms. */
function parseUtcStamp(stamp: string): number | null {
  const ms = Date.parse(stamp.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? null : ms;
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
  // recently attempted. event_date range covers the 10-day UPGRADE deadline
  // with a day of slack for ET/UTC date-boundary drift; the 30-min pacing
  // cutoff here is the LOOSE (fresh) bound — upgrade candidates apply their
  // stricter 24h pacing in JS below, where the cache lookup tells the two
  // classes apart. Final release-instant window check also happens in JS —
  // release_time is ET wall-clock.
  const today = todayET(now);
  const rangeStart = addDays(today, -(Math.ceil(UPGRADE_DEADLINE_MS / 86_400_000) + 1));
  const pacingCutoff = new Date(nowMs - PACING_MS).toISOString().replace("T", " ").slice(0, 19);

  const rows = db
    .prepare(
      `SELECT id, symbol, event_date, release_time, source, transcript_attempted_at
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
    .all(rangeStart, today, pacingCutoff) as CandidateRow[];

  const withAge = rows.flatMap((row) => {
    const releaseInstant = composeReleaseInstant(row.event_date, row.release_time!);
    if (!releaseInstant) return [];
    const ageMs = nowMs - releaseInstant.getTime();
    return ageMs >= 0 && ageMs <= UPGRADE_DEADLINE_MS ? [{ row, ageMs }] : [];
  });

  const deduped = dedupeByFamily(withAge.map((c) => c.row));
  const ageByRow = new Map(withAge.map((c) => [c.row, c.ageMs]));
  if (deduped.length === 0) return { attempted: 0, fetched: 0 };

  const symbols = Array.from(
    new Set(deduped.map((r) => r.symbol!.toUpperCase())),
  );
  const status = getSymbolStatus(db, symbols);
  // Symbol-only consumer (no event id to key on) — armed is DISPLAY-ONLY
  // everywhere else, but a same-day transcript fetch has no event-scoped
  // decision to make, so it counts armed like held/watchlist (spec §4.1).
  const covered = deduped.filter((r) => {
    const st = status[r.symbol!.toUpperCase()];
    return st === "held" || st === "watchlist" || st === "armed";
  });

  // Classify each candidate by cache state. A cached NON-edgar transcript is
  // terminal (real call transcript — nothing to do, no attempt). A cached
  // edgar_8k row makes this an UPGRADE candidate: eligible on the slower
  // 10-day/24h clock. No cache at all is a FRESH candidate on the original
  // 36h/30-min clock.
  const candidates = covered.flatMap((row) => {
    const symbol = row.symbol!.toUpperCase();
    const { year, quarter } = deriveFilingReportingQuarter(row.event_date);
    const cached = getCachedTranscript(db, symbol, year, quarter);
    const ageMs = ageByRow.get(row)!;

    if (cached && cached.source !== "edgar_8k") return [];
    if (!cached) {
      // Fresh: the wider SQL window means the 36h deadline moves here.
      if (ageMs > DEADLINE_MS) return [];
    } else {
      // Upgrade: 24h pacing (the SQL cutoff only enforced 30 min).
      const lastMs = row.transcript_attempted_at
        ? parseUtcStamp(row.transcript_attempted_at)
        : null;
      if (lastMs !== null && nowMs - lastMs < UPGRADE_PACING_MS) return [];
    }
    return [{ row, symbol, year, quarter, isUpgrade: !!cached }];
  });

  // Fresh candidates spend the shared attempt budget first — a same-day
  // transcript beats a days-old upgrade retry. Stable sort keeps the SQL
  // recency order within each class.
  candidates.sort((a, b) => Number(a.isUpgrade) - Number(b.isUpgrade));

  const stampAttempted = db.prepare(
    `UPDATE calendar_events SET transcript_attempted_at = datetime('now') WHERE id = ?`,
  );

  let attempted = 0;
  let fetched = 0;

  for (const { row, symbol, year, quarter } of candidates) {
    if (attempted >= maxAttempts) break;

    // Stamp BEFORE the fetch attempt so a hung fetchTranscript call can't
    // hot-loop the next sweep tick.
    stampAttempted.run(row.id);
    attempted += 1;

    try {
      const result = await fetchTranscript(db, symbol, year, quarter);
      // fromCache: true means a FAILED upgrade (fetchTranscript echoed the
      // cached edgar row back) — not a fetch, and re-summarizing the same
      // edgar text would burn an AI call per attempt.
      if (result && !result.fromCache) {
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
