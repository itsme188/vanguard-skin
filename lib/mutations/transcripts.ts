import type Database from "better-sqlite3";
import type { EarningsTranscript, TranscriptSource } from "@/lib/types";
import { isFilingRow } from "@/lib/transcripts/presentation";

// ─── What a document says about itself ───────────────────────────
//
// `statedFiscalQuarterFromTranscript` reads the OPENING of a call transcript
// or press release and returns the fiscal quarter (and year, when given) the
// document names for itself. It never derives a quarter from a date ("three
// months ended June 30, 2026" stays null): a period-end date is a calendar
// fact, and the fiscal label is the company's own.

export interface StatedFiscalQuarter {
  quarter: 1 | 2 | 3 | 4;
  year: number | null;
}

/**
 * How strongly the opening ties the quarter to THIS document:
 *   self       — the mention sits next to "earnings", "results", "conference
 *                call" and the like ("third quarter 2026 earnings call")
 *   dated      — the mention carries a year but no such neighbour
 *   plain      — a bare mention ("in the first quarter we closed the deal")
 *   comparison — the only mention is a comparison ("versus Q3")
 */
export type StatedQuarterEvidence = "self" | "dated" | "plain" | "comparison";

export interface StatedFiscalQuarterDetail extends StatedFiscalQuarter {
  evidence: StatedQuarterEvidence;
}

const ORDINAL_QUARTERS: Record<string, 1 | 2 | 3 | 4> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
};

// The opening of a call: the operator's instructions, the investor-relations
// introduction and the first lines of prepared remarks. Operator preambles of
// 600 words exist, so 350 words was too short; 1,000 words still ends long
// before the question-and-answer part of a normal 8,000 to 10,000 word call.
export const OPENING_WORD_LIMIT = 1000;

const QUARTER_TOKEN_RE =
  /(?<![\w'])(?:(first|second|third|fourth)[-\s]+quarter|([1-4])(?:st|nd|rd|th)[-\s]+quarter|Q([1-4])(?![\dA-Za-z])|([1-4])Q(?![A-Za-z]))/gi;

// "fourth quarter AND FULL YEAR fiscal 2026", "third quarter and nine months 2026".
const CONNECTOR = String.raw`(?:\s+and\s+(?:the\s+)?(?:full[-\s]year|fiscal[-\s]year|year[-\s]end|year[-\s]to[-\s]date|annual|(?:six|nine|twelve)[-\s]months?|first[-\s]half))?`;
const LINK = String.raw`(?:\s+(?:of|for))?(?:\s+(?:the|our|its))?`;

// A year is four digits (2000-2099) ...
const AFTER_YEAR4_RE = new RegExp(
  String.raw`^${CONNECTOR}${LINK}(?:\s+(?:fiscal(?:\s+year)?|FY))?\s*'?(20\d{2})(?!\d)`,
  "i",
);
// ... or an explicit two-digit fiscal form (FY26, FY'26, fiscal '26) ...
const AFTER_YEAR2_FISCAL_RE = new RegExp(
  String.raw`^${CONNECTOR}${LINK}\s+(?:FY\s*'?|fiscal(?:\s+year)?\s*')(\d{2})(?!\d)`,
  "i",
);
// ... or the compact analyst form glued to a Q token (2Q26, Q3'26). Nothing
// else: "third quarter 10 a.m." carries no year.
const AFTER_YEAR2_COMPACT_RE = /^(?:\s?')?(\d{2})(?!\d)/;
// Year in front: "fiscal 2026 third quarter", "FY26 Q2", "2026 third quarter".
// A bare year straight after a day of the month ("June 30, 2026 third ...")
// belongs to the date, not to the quarter.
const BEFORE_YEAR_RE =
  /(?:(?:fiscal(?:\s+year)?|FY)\s*'?(20\d{2})|(?:FY\s*'?|fiscal(?:\s+year)?\s*')(\d{2})|(?<!\d,\s)(?<![\d.,$'])(20\d{2}))(?:'s)?\s+(?:fiscal\s+)?$/i;
const LEADING_FISCAL_RE = /fiscal\s+$/i;

const CONTEXT_AFTER_RE = /\b(?:earnings|results|conference\s+call|call|webcast)\b/i;
const CONTEXT_BEFORE_RE =
  /\b(?:earnings|results|conference\s+call|call|webcast|reports?|reported|reporting|announces?|announced|announcing)\b/i;
const COMPARISON_BEFORE_RE =
  /(?:\bcompared\s+(?:with|to)|\bversus|\bvs\.?|\bfrom\s+(?:the|our|last)|\bthan\s+(?:in\s+)?(?:the|our|last)|\byear[-\s]ago|\bprior(?:[-\s]year)?(?:'s)?|\bprevious(?:\s+year(?:'s)?)?|\bpreceding|\blast\s+year(?:'s)?)\s+(?:(?:the|our|its)\s+)?(?:same\s+)?$/i;
const COMPARISON_AFTER_RE =
  /^\s+(?:(?:of|in)\s+)?(?:the\s+)?(?:(?:last|prior|previous|preceding)\s+(?:fiscal\s+)?year|(?:a|one)\s+year\s+ago)/i;
const CLAUSE_BREAK_RE = /[.;!?,:]/;

const RANK: Record<StatedQuarterEvidence, number> = {
  comparison: 0,
  plain: 1,
  dated: 2,
  self: 3,
};

function twoDigitYear(raw: string): number {
  return 2000 + Number(raw);
}

function firstWords(text: string, count: number): string {
  return text.trim().split(/\s+/).slice(0, count).join(" ");
}

function lastWords(text: string, count: number): string {
  const words = text.trim().split(/\s+/);
  return words.slice(Math.max(0, words.length - count)).join(" ");
}

/**
 * The fiscal quarter a document states for itself, with the strength of the
 * evidence. Every quarter mention in the opening is scored and the best one
 * wins (earliest on a tie):
 *   1. a mention next to "earnings" / "conference call" / "results";
 *   2. failing that, a mention that carries a year;
 *   3. failing that, a bare mention;
 *   4. a comparison ("compared with", "versus", "from the", "year-ago",
 *      "prior") never wins over any other mention.
 */
export function statedFiscalQuarterDetail(
  transcript: string | null | undefined,
): StatedFiscalQuarterDetail | null {
  if (!transcript) return null;
  const opening = transcript
    .split(/\s+/)
    .slice(0, OPENING_WORD_LIMIT)
    .join(" ")
    .replace(/[‘’]/g, "'");

  let best: StatedFiscalQuarterDetail | null = null;
  for (const m of opening.matchAll(QUARTER_TOKEN_RE)) {
    const tokenStart = m.index ?? 0;
    const tokenEnd = tokenStart + m[0].length;
    const quarter = (
      m[1] ? ORDINAL_QUARTERS[m[1].toLowerCase()] : Number(m[2] ?? m[3] ?? m[4])
    ) as 1 | 2 | 3 | 4;
    const isCompactToken = !!(m[3] ?? m[4]);

    const before = opening.slice(Math.max(0, tokenStart - 80), tokenStart);
    const after = opening.slice(tokenEnd, tokenEnd + 80);

    let year: number | null = null;
    let start = tokenStart;
    let end = tokenEnd;

    const after4 = AFTER_YEAR4_RE.exec(after);
    const after2 = after4 ? null : AFTER_YEAR2_FISCAL_RE.exec(after);
    const afterCompact =
      after4 || after2 || !isCompactToken ? null : AFTER_YEAR2_COMPACT_RE.exec(after);
    if (after4) {
      year = Number(after4[1]);
      end = tokenEnd + after4[0].length;
    } else if (after2) {
      year = twoDigitYear(after2[1]);
      end = tokenEnd + after2[0].length;
    } else if (afterCompact) {
      year = twoDigitYear(afterCompact[1]);
      end = tokenEnd + afterCompact[0].length;
    } else {
      const beforeYear = BEFORE_YEAR_RE.exec(before);
      if (beforeYear) {
        year = beforeYear[1]
          ? Number(beforeYear[1])
          : beforeYear[2]
            ? twoDigitYear(beforeYear[2])
            : Number(beforeYear[3]);
        start = tokenStart - (before.length - beforeYear.index);
      }
    }
    if (start === tokenStart) {
      const leadingFiscal = LEADING_FISCAL_RE.exec(before);
      if (leadingFiscal) start = tokenStart - (before.length - leadingFiscal.index);
    }

    const head = opening.slice(Math.max(0, start - 70), start);
    const tail = opening.slice(end, end + 70);
    const isComparison = COMPARISON_BEFORE_RE.test(head) || COMPARISON_AFTER_RE.test(tail);

    const tailClause = tail.split(CLAUSE_BREAK_RE)[0] ?? "";
    const headClauses = head.split(CLAUSE_BREAK_RE);
    const headClause = headClauses[headClauses.length - 1] ?? "";
    const hasContext =
      CONTEXT_AFTER_RE.test(firstWords(tailClause, 5)) ||
      CONTEXT_BEFORE_RE.test(lastWords(headClause, 6));

    const evidence: StatedQuarterEvidence = isComparison
      ? "comparison"
      : hasContext
        ? "self"
        : year !== null
          ? "dated"
          : "plain";

    if (!best || RANK[evidence] > RANK[best.evidence]) {
      best = { quarter, year, evidence };
    }
  }
  return best;
}

export function statedFiscalQuarterFromTranscript(
  transcript: string | null | undefined,
): StatedFiscalQuarter | null {
  const detail = statedFiscalQuarterDetail(transcript);
  return detail ? { quarter: detail.quarter, year: detail.year } : null;
}

export class TranscriptQuarterMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptQuarterMismatchError";
  }
}

function describeStated(stated: StatedFiscalQuarter): string {
  return `Q${stated.quarter}${stated.year ? ` ${stated.year}` : ""}`;
}

/**
 * Why a document may NOT be stored under (year, quarter), or null when it may.
 *
 * Default (a writer handed an explicit key): a document that states a quarter
 * must state the key's quarter, and the key's year when it states a year. A
 * document that states nothing passes.
 *
 * `requireStatedQuarter` (the caller is fetching the call for a known print):
 * silence is not enough. The document must name the key's quarter itself, by
 * a self-identifying or year-carrying mention. Weak evidence can block a
 * write; only strong evidence can admit one.
 */
export function transcriptQuarterMismatchReason(params: {
  ticker: string;
  year: number;
  quarter: number;
  source: TranscriptSource;
  transcript?: string | null;
  requireStatedQuarter?: boolean;
}): string | null {
  const key = `Q${params.quarter} ${params.year}`;
  const stated = statedFiscalQuarterDetail(params.transcript);
  if (!stated) {
    return params.requireStatedQuarter
      ? `expected ${key} but the opening states no fiscal quarter`
      : null;
  }
  if (
    stated.quarter !== params.quarter ||
    (stated.year !== null && stated.year !== params.year)
  ) {
    return `stated ${describeStated(stated)} but key is ${key}`;
  }
  if (
    params.requireStatedQuarter &&
    (stated.evidence === "plain" || stated.evidence === "comparison")
  ) {
    return `expected ${key} but the opening only mentions ${describeStated(stated)} in passing`;
  }
  return null;
}

// An earnings press release reaches EDGAR on the print date or within a day
// or two (a Friday-evening print can be filed the following Monday, +3), and
// vendor calendars place one print a day apart. Four days covers both and is
// far short of the ~90 days between two quarterly releases.
export const PRINT_FILING_WINDOW_DAYS = 4;

function dateOnlyMs(date: string | null | undefined): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  const ms = Date.parse(`${date.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** True when a filing date sits inside the print's filing window. */
export function filingDateMatchesPrint(
  filingDate: string | null | undefined,
  printEventDate: string | null | undefined,
): boolean {
  const filed = dateOnlyMs(filingDate);
  const print = dateOnlyMs(printEventDate);
  if (filed === null || print === null) return false;
  return Math.abs(filed - print) / 86_400_000 <= PRINT_FILING_WINDOW_DAYS;
}

export interface UpsertTranscriptParams {
  security_id?: number | null;
  ticker: string;
  year: number;
  quarter: number;
  call_date?: string | null;
  source: TranscriptSource;
  transcript?: string | null;
  summary?: string | null;
  guidance?: string | null;
  risk_factors?: string | null;
  sentiment_score?: number | null;
  sentiment_label?: string | null;
  participants?: string | null; // JSON string
  accession_number?: string | null;
  filing_url?: string | null;
  source_key: string;
  /** See `transcriptQuarterMismatchReason`: the text must name the key's quarter. */
  require_stated_quarter?: boolean;
  /**
   * FILINGS ONLY. The earnings print this press release was selected for.
   * Checked here against `call_date` (the filing date), never trusted blind.
   */
  print_event_date?: string | null;
}

/**
 * Insert or replace a cached transcript. The ONLY insert into
 * `earnings_transcripts`, so the key rule lives here and no writer can skip it.
 *
 * THE KEY RULE (what ties a document to the (year, quarter) it is stored under)
 *
 * A row's key is a FISCAL (year, quarter). Two kinds of document reach this
 * function, and each has exactly one kind of evidence:
 *
 * 1. A CALL (every source that is not a filing). A vendor's response carries
 *    no call date, so the only evidence is the text. A call is never stored
 *    under a key its own text contradicts. When the caller is fetching the
 *    call for a known print (`require_stated_quarter`), the text must
 *    positively name that quarter; silence is a rejection.
 *
 * 2. A FILING (the 8-K press release). It has a real FILING DATE. When the
 *    caller names the print (`print_event_date`) and the filing date sits
 *    inside the print's filing window, the date is the evidence that this is
 *    the print's press release, and the row is stored under the key requested
 *    for the print even if the release's own label differs (the difference is
 *    logged). Without that date evidence a filing is held to rule 1: it is
 *    never stored under a key its own text contradicts.
 *
 * Re-writing a row that is already stored (same source_key, same key, same
 * text) is not a new keying decision: only derived columns change (the AI
 * desk note over the extractive summary), so the check is not repeated.
 *
 * Uses source_key for dedup: re-fetching the same transcript is an update.
 */
export function upsertTranscript(
  db: Database.Database,
  params: UpsertTranscriptParams
): EarningsTranscript {
  const mismatch = transcriptQuarterMismatchReason({
    ticker: params.ticker,
    year: params.year,
    quarter: params.quarter,
    source: params.source,
    transcript: params.transcript,
    requireStatedQuarter: params.require_stated_quarter,
  });
  if (mismatch) {
    const label = `${params.source} ${params.ticker.toUpperCase()} ${params.year}Q${params.quarter}`;
    const stored = db
      .prepare(
        "SELECT year, quarter, transcript FROM earnings_transcripts WHERE source_key = ?",
      )
      .get(params.source_key) as
      | { year: number; quarter: number; transcript: string | null }
      | undefined;
    const rewriteOfStoredRow =
      !!stored &&
      stored.year === params.year &&
      stored.quarter === params.quarter &&
      (stored.transcript ?? null) === (params.transcript ?? null);
    const filingMatchedByDate =
      isFilingRow(params) && filingDateMatchesPrint(params.call_date, params.print_event_date);

    if (filingMatchedByDate) {
      console.log(
        `[transcripts] stored ${label} by filing date ${params.call_date} for the ${params.print_event_date} print; the release's own label differs (${mismatch})`,
      );
    } else if (!rewriteOfStoredRow) {
      const message = `[transcripts] rejected ${label}: ${mismatch}`;
      console.warn(message);
      throw new TranscriptQuarterMismatchError(message);
    }
  }

  db.prepare(
    `INSERT INTO earnings_transcripts (
       security_id, ticker, year, quarter, call_date, source,
       transcript, summary, guidance, risk_factors,
       sentiment_score, sentiment_label, participants,
       accession_number, filing_url, source_key, fetched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(source_key) DO UPDATE SET
       transcript = excluded.transcript,
       summary = excluded.summary,
       guidance = excluded.guidance,
       risk_factors = excluded.risk_factors,
       call_date = COALESCE(excluded.call_date, earnings_transcripts.call_date),
       accession_number = COALESCE(excluded.accession_number, earnings_transcripts.accession_number),
       filing_url = COALESCE(excluded.filing_url, earnings_transcripts.filing_url),
       sentiment_score = excluded.sentiment_score,
       sentiment_label = excluded.sentiment_label,
       participants = excluded.participants,
       fetched_at = datetime('now')`
  ).run(
    params.security_id ?? null,
    params.ticker.toUpperCase(),
    params.year,
    params.quarter,
    params.call_date ?? null,
    params.source,
    params.transcript ?? null,
    params.summary ?? null,
    params.guidance ?? null,
    params.risk_factors ?? null,
    params.sentiment_score ?? null,
    params.sentiment_label ?? null,
    params.participants ?? null,
    params.accession_number ?? null,
    params.filing_url ?? null,
    params.source_key
  );

  return db
    .prepare("SELECT * FROM earnings_transcripts WHERE source_key = ?")
    .get(params.source_key) as EarningsTranscript;
}
