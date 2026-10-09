/**
 * Earnings transcript fetch + cache pipeline.
 *
 * Orchestrates the layered fallback chain:
 *   1. Check SQLite cache → return if found
 *   2. If API Ninjas configured → try API Ninjas
 *   3. If Alpha Vantage configured → try Alpha Vantage (free tier)
 *   4. Fall back to EDGAR 8-K press release
 *   5. Cache result and return
 *
 * KEYS ARE FISCAL. The vendor's `quarter` parameter is the company's fiscal
 * quarter, so a row is keyed by the fiscal (year, quarter) the document
 * belongs to. A print's fiscal quarter comes from the Finnhub calendar entry
 * stored on its earnings event (`expectedFiscalQuarterForPrint`). What ties a
 * document to its key is written down once, at the single insert
 * (`upsertTranscript` in lib/mutations/transcripts.ts): a call by what its
 * own text says, a filing by its filing date. Nothing here deletes a row.
 *
 * The Motley Fool scraper was retired from the chain 2026-06-09 (brittle —
 * broke on HTML changes; replaced by Alpha Vantage's official endpoint).
 * Cached motley_fool rows remain valid and are still served from step 1.
 *
 * All results are cached in the earnings_transcripts table with source_key
 * dedup, so subsequent requests for the same transcript are instant.
 */

import type Database from "better-sqlite3";
import type { EarningsTranscript } from "@/lib/types";
import { getCachedTranscript } from "@/lib/queries/transcripts";
import {
  PRINT_FILING_WINDOW_DAYS,
  TranscriptQuarterMismatchError,
  filingDateMatchesPrint,
  statedFiscalQuarterDetail,
  statedFiscalQuarterFromTranscript,
  transcriptQuarterMismatchReason,
  upsertTranscript,
} from "@/lib/mutations/transcripts";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { isFilingRow, kindHeadingLabel } from "@/lib/transcripts/presentation";
import { todayET } from "@/lib/calendar/date-utils";
import {
  isApiNinjasConfigured,
  getEarningsTranscript as getApiNinjasTranscript,
} from "@/lib/apis/api-ninjas";
import {
  isAlphaVantageConfigured,
  getEarningsTranscript as getAlphaVantageTranscript,
} from "@/lib/transcripts/alpha-vantage";
import { getEarnings8KFilings, type Earnings8KFiling } from "@/lib/apis/edgar";

// ─── Types ──────────────────────────────────────────────────────

export interface FetchTranscriptResult {
  transcript: EarningsTranscript;
  fromCache: boolean;
  /**
   * Set only by `fetchLatestTranscript` (the caller named no quarter).
   * true: the document is tied to the issuer's most recent earnings print.
   * false: no earnings date is on file for the issuer, so the calendar
   * default was used and a newer document may exist. A surface must not call
   * a `false` result "the latest".
   */
  latestConfirmed?: boolean;
}

export interface FiscalQuarter {
  year: number;
  quarter: number;
}

export interface FetchTranscriptOptions {
  /**
   * The earnings print this fetch is for. The 8-K is then matched to the
   * print by its filing date.
   */
  eventDate?: string;
  /**
   * The print's fiscal quarter (Finnhub). It becomes the key, and a vendor
   * call is cached only when the call itself names this quarter. With
   * `eventDate` and no fiscal quarter, no vendor call is requested at all.
   */
  expectedFiscalQuarter?: FiscalQuarter;
  /** Do not spend an Alpha Vantage request on this fetch (pacing). */
  skipAlphaVantage?: boolean;
}

export { statedFiscalQuarterFromTranscript, PRINT_FILING_WINDOW_DAYS };

// A vendor-supplied CALL date (API Ninjas only; Alpha Vantage supplies none)
// can sit a few days from the print date: the call, the vendor's posting and
// the calendar's date for the print are not simultaneous.
export const TRANSCRIPT_CALL_DATE_WINDOW_DAYS = 10;

// Cross-source earnings calendar rows for the same print can disagree by a
// day or two; include nearby superseded Finnhub twins when resolving fiscal Q.
export const FISCAL_QUARTER_EVENT_TOLERANCE_DAYS = 3;
export const ALPHA_VANTAGE_DAILY_REQUEST_LIMIT = 25;

// ─── Summary Generation ─────────────────────────────────────────

/**
 * Generate a summary from raw transcript text when the source doesn't
 * provide one (Motley Fool, EDGAR). Extracts key sections:
 * - First ~300 words (usually contains headline metrics)
 * - Paragraphs mentioning guidance/outlook/forecast
 */
export function generateSummary(text: string): string {
  if (!text || text.length < 50) return "";

  const words = text.split(/\s+/);

  // Take first ~300 words
  const intro = words.slice(0, 300).join(" ");

  // Find guidance-related paragraphs
  const paragraphs = text.split(/\n\n+/);
  const guidanceKeywords = /\b(guidance|outlook|expect|forecast|anticipate|project|looking ahead)\b/i;
  const guidanceParagraphs = paragraphs
    .filter((p) => guidanceKeywords.test(p))
    .slice(0, 2)
    .map((p) => {
      const pWords = p.split(/\s+/);
      return pWords.length > 100 ? pWords.slice(0, 100).join(" ") + "..." : p;
    });

  let summary = intro;
  if (intro.split(/\s+/).length >= 300) {
    summary += "...";
  }

  if (guidanceParagraphs.length > 0) {
    const guidanceText = guidanceParagraphs.join(" ");
    // Don't duplicate if guidance is already in the intro
    if (!intro.includes(guidanceText.slice(0, 50))) {
      summary += "\n\n" + guidanceText;
    }
  }

  // Cap at ~200 words for chat context
  const summaryWords = summary.split(/\s+/);
  if (summaryWords.length > 250) {
    summary = summaryWords.slice(0, 250).join(" ") + "...";
  }

  return summary;
}

/**
 * Extract guidance from transcript text.
 */
export function extractGuidance(text: string): string | null {
  if (!text) return null;
  const excerpts = selectTranscriptSections(text).guidance;
  return excerpts.length > 0 ? excerpts.join("\n\n") : null;
}

/**
 * Extract risk factors / challenges from transcript text.
 */
export function extractRiskFactors(text: string): string | null {
  if (!text) return null;
  const excerpts = selectTranscriptSections(text).risk;
  return excerpts.length > 0 ? excerpts.join("\n\n") : null;
}

// ─── Guidance / risk slicer ──────────────────────────────────────
//
// A keyword slicer, so the sections stay approximate. What it guarantees:
//   - only the part of the call BEFORE the question-and-answer part is read
//     (positional, never the literal words "prepared remarks");
//   - operator and analyst turns are never quoted;
//   - boilerplate is removed one SENTENCE at a time (welcome, safe harbor,
//     8-K cover wording), so real guidance sharing a paragraph with it stays;
//   - an excerpt STARTS at the first sentence that matched, not at the top of
//     the speaker's turn (a vendor turn is one paragraph of a thousand words,
//     and its first 80 words are the greeting);
//   - a question never qualifies a paragraph;
//   - Risk never repeats a passage Guidance already shows, and that is
//     decided BEFORE the top-N cut so a later risk passage takes the slot.

// Verbs are listed with their inflected forms ("expects", "anticipating",
// "reaffirmed"): `\bexpect\b` alone misses "the company expects". A past
// participle counts only when it looks forward ("is expected to"); "better
// than expected" and "as anticipated" describe the quarter just reported.
const GUIDANCE_KEYWORDS =
  /\b(guidance|outlook|expect(?:s|ing)?|forecast(?:s|ing)?|anticipat(?:e|es|ing)|(?:expected|anticipated|forecast(?:ed)?)\s+to|projects|projected|projecting|looking ahead|full[- ]year|next quarter|raising|lowering|reaffirm(?:s|ed|ing)?)\b/i;
const RISK_KEYWORDS =
  /\b(risk|challenge|headwind|decline|pressure|uncertain|concern|difficult|disruption|tariff|impact)\b/i;
const GUIDANCE_LIMIT = 3;
const RISK_LIMIT = 2;
const EXCERPT_WORD_LIMIT = 80;
// A labelled turn this short that ends in a question is someone asking one.
const QUESTION_TURN_MAX_WORDS = 60;

// "Name:" or "Name (Title):" at the start of a turn.
const SPEAKER_PREFIX_RE =
  /^([A-Z][A-Za-z.'’-]*(?:\s+[A-Za-z.'’&-]+){0,5})\s*(?:\(([^)\n]{1,120})\))?:\s+(?=\S)/;
const QUESTIONER_ROLE_RE = /\b(?:analyst|operator|moderator)\b/i;
const QUESTION_LABEL_RE = /^(?:Q|Question)\s*[-:]/i;
// A bare section heading, e.g. a paragraph that is just "Question-and-Answer Session".
const QA_HEADING_RE = /^(?:question[-\s]and[-\s]answer|questions?\s+and\s+answers?|Q\s*&\s*A)(?:\s+session)?[.:]?$/i;
// "We will NOW begin the question-and-answer session": the Q&A is starting.
// The operator's opening line ("after the remarks there will be a
// question-and-answer session") announces it for later and is not a marker.
const QA_STARTING_NOW_RE =
  /\bnow\s+(?:begin|start|open|take|conduct|move|turn|go|ready\s+(?:to\s+take|for)|like\s+to\s+(?:begin|start|open|take))\b[^.!?]{0,80}\b(?:questions?|Q\s*&\s*A)\b|\b(?:first|next)\s+question\b[^.!?]{0,60}\b(?:comes?|is\s+from|will\s+come|coming)\b/i;
const QA_LATER_RE = /\b(?:after|following|then|later|at\s+the\s+(?:end|conclusion)|will\s+be\s+(?:a|an))\b/i;

const BOILERPLATE_SENTENCE_RE =
  /\b(?:welcome\s+to|good\s+(?:morning|afternoon|evening|day)|thank\s+you\s+(?:all\s+)?for\s+(?:joining|standing\s+by)|with\s+me\s+(?:today|on\s+the\s+call)|joining\s+me|turn\s+the\s+(?:call|conference)\s+over|hand\s+the\s+call\s+over|before\s+we\s+begin|today's\s+remarks\s+include|this\s+(?:call|presentation)\s+contains|forward-looking\s+statements?|safe\s+harbor|risks\s+and\s+uncertainties|actual\s+results\s+(?:may|could|might)\s+differ|undertakes?\s+no\s+obligation|SEC|Securities\s+and\s+Exchange\s+Commission|Form\s+(?:8-K|10-K|10-Q)|Exhibit\s+99\.?1?|Item\s+2\.02|registrant|investor\s+relations|webcast|replay|reconciliations?)\b/i;

interface TranscriptTurn {
  /** "Name (Title): " or "" */
  prefix: string;
  speaker: string | null;
  title: string | null;
  body: string;
}

function splitTurns(text: string): TranscriptTurn[] {
  return text
    // A blank line, or a single newline straight before a speaker label.
    .split(/\n\s*\n+|\n(?=[A-Z][A-Za-z.'’-]*(?:[ \t]+[A-Za-z.'’&-]+){0,5}[ \t]*(?:\([^)\n]{1,120}\))?:\s)/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const m = SPEAKER_PREFIX_RE.exec(p);
      if (!m) return { prefix: "", speaker: null, title: null, body: p };
      return {
        prefix: m[0],
        speaker: m[1].trim(),
        title: m[2]?.trim() ?? null,
        body: p.slice(m[0].length).trim(),
      };
    });
}

function isQuestionerTurn(turn: TranscriptTurn): boolean {
  if (QUESTION_LABEL_RE.test(turn.prefix + turn.body)) return true;
  if (turn.speaker && /^(?:operator|analyst|moderator|question)$/i.test(turn.speaker)) return true;
  return !!turn.title && QUESTIONER_ROLE_RE.test(turn.title);
}

function isAnalystTurn(turn: TranscriptTurn): boolean {
  return (
    (!!turn.title && /\banalyst\b/i.test(turn.title)) ||
    (!!turn.speaker && /^analyst$/i.test(turn.speaker))
  );
}

function splitSentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+(?=[A-Z"'(“])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * How many leading turns make up the part of the call before questions.
 * The marker is searched over EVERY turn, before any length filter (a bare
 * "Question-and-answer session" heading is 27 characters).
 */
function turnsBeforeQuestions(turns: TranscriptTurn[]): TranscriptTurn[] {
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    // The first analyst turn, a "Q:" label, or a section heading: everything
    // from here on is Q&A.
    if (isAnalystTurn(turn) || QUESTION_LABEL_RE.test(turn.prefix + turn.body)) {
      return turns.slice(0, i);
    }
    if (QA_HEADING_RE.test(turn.body)) return turns.slice(0, i);
    // A short labelled turn that ends in a question, with no titles to go by.
    if (
      turn.speaker &&
      !turn.title &&
      turn.body.endsWith("?") &&
      turn.body.split(/\s+/).length <= QUESTION_TURN_MAX_WORDS
    ) {
      return turns.slice(0, i);
    }
    // "We will now begin the question-and-answer session", "Our first
    // question comes from ...". The sentence can close an executive's own
    // remarks, so that turn stays in the pool.
    const startsNow = splitSentences(turn.body).some(
      (s) => QA_STARTING_NOW_RE.test(s) && !QA_LATER_RE.test(s),
    );
    if (startsNow) return turns.slice(0, i + 1);
  }
  return turns;
}

interface SectionExcerpt {
  turnIndex: number;
  /** Sentence range [start, end) of the turn that the excerpt covers. */
  start: number;
  end: number;
  text: string;
}

function selectExcerpts(
  turns: { prefix: string; sentences: string[] }[],
  keyword: RegExp,
  limit: number,
  taken: SectionExcerpt[],
): SectionExcerpt[] {
  const out: SectionExcerpt[] = [];
  for (let t = 0; t < turns.length && out.length < limit; t += 1) {
    const { prefix, sentences } = turns[t];
    const blocked = taken.filter((x) => x.turnIndex === t);
    const isBlocked = (i: number) => blocked.some((x) => i >= x.start && i < x.end);
    const start = sentences.findIndex(
      (s, i) => !isBlocked(i) && !s.endsWith("?") && keyword.test(s),
    );
    if (start === -1) continue;

    const words: string[] = [];
    let end = start;
    let truncated = false;
    for (; end < sentences.length && !isBlocked(end); end += 1) {
      const sentenceWords = sentences[end].split(/\s+/);
      if (words.length + sentenceWords.length > EXCERPT_WORD_LIMIT) {
        words.push(...sentenceWords.slice(0, EXCERPT_WORD_LIMIT - words.length));
        truncated = true;
        end += 1;
        break;
      }
      words.push(...sentenceWords);
    }
    // A sentence that opens with its own speaker label carries the speaker.
    const ownLabel = SPEAKER_PREFIX_RE.test(sentences[start]);
    const body = words.join(" ") + (truncated ? "..." : "");
    if (body.length <= 30) continue;
    out.push({ turnIndex: t, start, end, text: (ownLabel ? "" : prefix) + body });
  }
  return out;
}

function selectTranscriptSections(text: string): { guidance: string[]; risk: string[] } {
  const pool = turnsBeforeQuestions(splitTurns(text))
    .filter((turn) => !isQuestionerTurn(turn))
    .map((turn) => ({
      prefix: turn.prefix,
      sentences: splitSentences(turn.body).filter((s) => !BOILERPLATE_SENTENCE_RE.test(s)),
    }));
  const guidance = selectExcerpts(pool, GUIDANCE_KEYWORDS, GUIDANCE_LIMIT, []);
  const risk = selectExcerpts(pool, RISK_KEYWORDS, RISK_LIMIT, guidance);
  return { guidance: guidance.map((x) => x.text), risk: risk.map((x) => x.text) };
}

function parseDateOnly(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T12:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

function daysBetween(a: string, b: string): number | null {
  const aMs = parseDateOnly(a);
  const bMs = parseDateOnly(b);
  if (aMs === null || bMs === null) return null;
  return Math.abs(aMs - bMs) / 86_400_000;
}

function normalizedDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const date = raw.slice(0, 10);
  return parseDateOnly(date) === null ? null : date;
}

/** A vendor-supplied CALL date (API Ninjas only) against the print date. */
function callDateMatchesPrint(date: string | null | undefined, eventDate: string | undefined): boolean {
  if (!eventDate) return true;
  const normalized = normalizedDate(date);
  if (!normalized) return false;
  const diff = daysBetween(normalized, eventDate);
  return diff !== null && diff <= TRANSCRIPT_CALL_DATE_WINDOW_DAYS;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function vendorQuotaKey(vendor: "alpha_vantage", day: string): string {
  return `transcript_vendor_requests:${vendor}:${day}`;
}

function readVendorRequestCount(db: Database.Database, vendor: "alpha_vantage", day: string): number {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(vendorQuotaKey(vendor, day)) as { value: string | null } | undefined;
  const parsed = Number(row?.value ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function trySpendVendorRequest(
  db: Database.Database,
  vendor: "alpha_vantage",
  day: string,
  limit: number,
): boolean {
  const key = vendorQuotaKey(vendor, day);
  const spent = readVendorRequestCount(db, vendor, day);
  if (spent >= limit) return false;
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, String(spent + 1));
  return true;
}

// ─── The print's fiscal quarter ──────────────────────────────────

/**
 * Finnhub's earnings-calendar entry, stored whole under `entry` in
 * `calendar_events.raw_json`. Only real values count: quarter is 1-4 (a
 * numeric string is accepted), year is a number from 2000 to 2099. `null`,
 * `true`, 0 and a two-digit year are all "not stated".
 */
function parseFinnhubQuarter(rawJson: string | null): FiscalQuarter | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as { entry?: { quarter?: unknown; year?: unknown } } | null;
    const rawQuarter = parsed?.entry?.quarter;
    const rawYear = parsed?.entry?.year;
    const quarter =
      typeof rawQuarter === "number"
        ? rawQuarter
        : typeof rawQuarter === "string" && /^[1-4]$/.test(rawQuarter.trim())
          ? Number(rawQuarter.trim())
          : NaN;
    if (quarter !== 1 && quarter !== 2 && quarter !== 3 && quarter !== 4) return null;
    if (typeof rawYear !== "number" || !Number.isInteger(rawYear)) return null;
    if (rawYear < 2000 || rawYear > 2099) return null;
    return { quarter, year: rawYear };
  } catch {
    return null;
  }
}

/**
 * The fiscal quarter and year of an earnings print, from the Finnhub entry
 * stored on an earnings event of the issuer family dated within
 * `FISCAL_QUARTER_EVENT_TOLERANCE_DAYS` of the print. Superseded twins count
 * (the live row for a print is often a Nasdaq or hand-entered row with no
 * entry). When several rows carry an entry: a live row first, then the
 * nearest date, then the lower id. Null when none does; never throws.
 */
export function expectedFiscalQuarterForPrint(
  db: Database.Database,
  symbol: string,
  eventDate: string,
): FiscalQuarter | null {
  const siblings = [...issuerSiblings(symbol)].map((s) => s.toUpperCase());
  if (siblings.length === 0 || parseDateOnly(eventDate) === null) return null;
  const placeholders = siblings.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT raw_json
         FROM calendar_events
        WHERE source = 'finnhub'
          AND UPPER(symbol) IN (${placeholders})
          AND raw_json IS NOT NULL
          AND ABS(julianday(event_date) - julianday(?)) <= ?
        ORDER BY COALESCE(superseded, 0) ASC,
                 ABS(julianday(event_date) - julianday(?)) ASC,
                 id ASC`,
    )
    .all(...siblings, eventDate, FISCAL_QUARTER_EVENT_TOLERANCE_DAYS, eventDate) as Array<{
    raw_json: string | null;
  }>;

  for (const row of rows) {
    const q = parseFinnhubQuarter(row.raw_json);
    if (q) return q;
  }
  return null;
}

export interface LatestPrint extends FiscalQuarter {
  eventDate: string;
}

export interface LatestPrintOnFile {
  eventDate: string;
  /** The print's fiscal quarter (Finnhub), or null when no entry states it. */
  fiscal: FiscalQuarter | null;
}

/**
 * The issuer's most recent earnings print that has happened, whether or not
 * its fiscal quarter is known. Null when no such print is on file.
 */
export function latestPrintOnFile(
  db: Database.Database,
  ticker: string,
): LatestPrintOnFile | null {
  const siblings = [...issuerSiblings(ticker)].map((s) => s.toUpperCase());
  if (siblings.length === 0) return null;
  const placeholders = siblings.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT symbol, event_date
         FROM calendar_events
        WHERE (event_type = 'earnings' OR source = 'finnhub')
          AND COALESCE(superseded, 0) = 0
          AND UPPER(symbol) IN (${placeholders})
          AND actual_value IS NOT NULL
          AND event_date <= ?
        ORDER BY event_date DESC, id ASC
        LIMIT 1`,
    )
    .get(...siblings, todayET()) as { symbol: string; event_date: string } | undefined;
  if (!row) return null;
  return {
    eventDate: row.event_date,
    fiscal: expectedFiscalQuarterForPrint(db, row.symbol, row.event_date),
  };
}

/**
 * The issuer's most recent earnings print that has happened, with its fiscal
 * quarter. Null when there is no such print or its fiscal quarter is unknown
 * (`latestPrintOnFile` tells those two apart).
 */
export function latestPrintFiscalQuarter(
  db: Database.Database,
  ticker: string,
): LatestPrint | null {
  const print = latestPrintOnFile(db, ticker);
  return print?.fiscal ? { ...print.fiscal, eventDate: print.eventDate } : null;
}

/**
 * The cached 8-K press release for a print, found by its FILING DATE (stored
 * in `call_date`) whatever key it sits under. A filing cached while the
 * print's fiscal quarter was unknown is keyed by its own stated quarter or by
 * the calendar, so a lookup by key alone can miss it.
 */
export function getCachedFilingForPrint(
  db: Database.Database,
  ticker: string,
  eventDate: string,
): EarningsTranscript | null {
  if (parseDateOnly(eventDate) === null) return null;
  const rows = db
    .prepare(
      `SELECT * FROM earnings_transcripts
        WHERE UPPER(ticker) = UPPER(?)
          AND call_date IS NOT NULL
          AND ABS(julianday(substr(call_date, 1, 10)) - julianday(?)) <= ?
        ORDER BY ABS(julianday(substr(call_date, 1, 10)) - julianday(?)) ASC, id DESC`,
    )
    .all(ticker, eventDate, PRINT_FILING_WINDOW_DAYS, eventDate) as EarningsTranscript[];
  return rows.find((row) => isFilingRow(row)) ?? null;
}

/**
 * Determine the most recent earnings quarter for a date.
 * Companies typically report within 6 weeks of quarter end.
 */
export function getMostRecentQuarter(date: Date = new Date()): {
  year: number;
  quarter: number;
} {
  const month = date.getMonth() + 1; // 1-indexed
  const year = date.getFullYear();

  // Q4 reports come Jan-Feb, Q1 reports come Apr-May, etc.
  // So look back ~2 months to find which quarter was most recently reported
  if (month <= 2) return { year: year - 1, quarter: 3 }; // Q3 of prior year
  if (month <= 5) return { year: year - 1, quarter: 4 }; // Q4 of prior year
  if (month <= 8) return { year, quarter: 1 }; // Q1
  if (month <= 11) return { year, quarter: 2 }; // Q2
  return { year, quarter: 3 }; // Q3
}

/**
 * Derive the CALENDAR quarter being reported in an earnings 8-K from its
 * filing date. Companies on calendar fiscal years file Q1 8-Ks in Apr-Jun,
 * Q2 in Jul-Sep, Q3 in Oct-Dec, and Q4 in Jan-Mar of the following year.
 *
 * This is a fallback key only. A company whose fiscal year is not the
 * calendar year labels the same release differently, so the filing path
 * never uses this to decide WHICH filing belongs to a print (the filing date
 * does that) and uses it as the key only when neither the print's Finnhub
 * entry nor the release itself states a fiscal quarter.
 */
export function deriveFilingReportingQuarter(filingDate: string): {
  year: number;
  quarter: number;
} {
  // Parse YYYY-MM-DD as UTC noon to dodge DST + timezone edge cases.
  const d = new Date(filingDate + "T12:00:00Z");
  const m = d.getUTCMonth() + 1;
  const y = d.getUTCFullYear();
  if (m <= 3) return { year: y - 1, quarter: 4 };
  if (m <= 6) return { year: y, quarter: 1 };
  if (m <= 9) return { year: y, quarter: 2 };
  return { year: y, quarter: 3 };
}

// ─── Resolve Security ID ────────────────────────────────────────

function resolveSecurityId(
  db: Database.Database,
  ticker: string
): number | null {
  const row = db
    .prepare("SELECT id FROM securities WHERE UPPER(symbol) = UPPER(?) LIMIT 1")
    .get(ticker) as { id: number } | undefined;
  return row?.id ?? null;
}

// ─── Vendor call (Alpha Vantage) ────────────────────────────────

/**
 * Fetch + cache an Alpha Vantage transcript. Shared by the chain's vendor
 * step and the cached-filing upgrade path.
 *
 * `rejected` is true when the vendor answered with a call that may not be
 * stored under the requested key. With `requireStatedQuarter` (the request is
 * for a known print) the call must itself name that fiscal quarter; a call
 * that names another quarter, or none, is rejected. Nothing is cached and the
 * caller goes on to the filing path.
 */
async function tryAlphaVantage(
  db: Database.Database,
  securityId: number | null,
  upperTicker: string,
  year: number,
  quarter: number,
  opts: { skip?: boolean; requireStatedQuarter: boolean },
): Promise<{ transcript: EarningsTranscript | null; rejected: boolean }> {
  if (opts.skip || !isAlphaVantageConfigured()) return { transcript: null, rejected: false };
  const quotaDay = todayET();
  if (!trySpendVendorRequest(db, "alpha_vantage", quotaDay, ALPHA_VANTAGE_DAILY_REQUEST_LIMIT)) {
    console.warn(
      `[transcripts] alpha_vantage daily request limit reached for ${quotaDay}; skipping ${upperTicker} ${year}Q${quarter}`,
    );
    return { transcript: null, rejected: false };
  }
  const result = await getAlphaVantageTranscript(upperTicker, year, quarter);
  if (!result || !result.transcript) return { transcript: null, rejected: false };
  const mismatch = transcriptQuarterMismatchReason({
    ticker: upperTicker,
    year,
    quarter,
    source: "alpha_vantage",
    transcript: result.transcript,
    requireStatedQuarter: opts.requireStatedQuarter,
  });
  if (mismatch) {
    console.warn(
      `[transcripts] rejected alpha_vantage ${upperTicker} ${year}Q${quarter}: ${mismatch}; nothing cached, going on to the 8-K filing`,
    );
    return { transcript: null, rejected: true };
  }
  try {
    const transcript = upsertTranscript(db, {
      security_id: securityId,
      ticker: upperTicker,
      year,
      quarter,
      call_date: null,
      source: "alpha_vantage",
      transcript: result.transcript,
      summary: generateSummary(result.transcript),
      guidance: extractGuidance(result.transcript),
      risk_factors: extractRiskFactors(result.transcript),
      sentiment_score: result.overall_sentiment,
      sentiment_label:
        result.overall_sentiment !== null
          ? result.overall_sentiment > 0.2
            ? "bullish"
            : result.overall_sentiment < -0.2
              ? "bearish"
              : "neutral"
          : null,
      participants:
        result.participants.length > 0
          ? JSON.stringify(result.participants)
          : null,
      source_key: `alpha_vantage:${upperTicker}:${year}:${quarter}`,
      require_stated_quarter: opts.requireStatedQuarter,
    });
    return { transcript, rejected: false };
  } catch (err) {
    // upsertTranscript logs its own rejection; anything else is logged here.
    if (!(err instanceof TranscriptQuarterMismatchError)) {
      console.warn(
        `[transcripts] could not store alpha_vantage ${upperTicker} ${year}Q${quarter}: ${errorText(err)}`,
      );
    }
    return { transcript: null, rejected: true };
  }
}

// ─── 8-K press release (EDGAR) ──────────────────────────────────
//
// WHICH FILING, AND UNDER WHICH KEY
//
// A filing has what a vendor call lacks: a real date. So the two questions
// are answered separately.
//
// The request names a print (`eventDate`):
//   WHICH  the earnings 8-K whose FILING DATE is nearest the print date,
//          inside `PRINT_FILING_WINDOW_DAYS`. The calendar quarter of the
//          filing date plays no part: a company whose fiscal year is offset
//          files its "fiscal fourth quarter" release in a month the calendar
//          calls the third quarter.
//   KEY    1. the print's fiscal quarter from Finnhub, when known. That is
//             the key the same-day sweep checks and asks the vendor for, so
//             the filing and the later call land on one card.
//          2. else the fiscal quarter the release itself states, when it
//             states one with a year.
//          3. else the calendar-derived key the caller asked for (the release
//             states nothing, or a quarter with no year that agrees with it).
//          A release that states a quarter with no year that DISAGREES with
//          the calendar key has no usable key (the fiscal year is unknown and
//          the calendar label is known to be wrong): nothing is stored, one
//          line is logged.
//
// The request names only a key (the card's Refresh, the chat tool with an
// explicit quarter, the upgrade script): there is no print date to match, so
// the filing must agree with the key in its own words, or, saying nothing
// contrary, by the calendar quarter of its filing date. It is never stored
// under a key its text contradicts.

type FilingChoice =
  | { filing: Earnings8KFiling; key: FiscalQuarter }
  | { reason: string };

function isStrongStatement(
  stated: ReturnType<typeof statedFiscalQuarterDetail>,
): stated is NonNullable<ReturnType<typeof statedFiscalQuarterDetail>> {
  return !!stated && (stated.evidence === "self" || stated.evidence === "dated");
}

function chooseFilingForPrint(
  filings: Earnings8KFiling[],
  printDate: string,
  expected: FiscalQuarter | null,
  requested: FiscalQuarter,
): FilingChoice {
  const inWindow = filings
    .filter((f) => filingDateMatchesPrint(f.filingDate, printDate))
    .map((f, index) => ({ f, index, gap: daysBetween(f.filingDate.slice(0, 10), printDate) ?? 0 }))
    .sort((a, b) => a.gap - b.gap || a.index - b.index);
  const filing = inWindow[0]?.f;
  if (!filing) {
    return {
      reason: `no earnings 8-K filed within ${PRINT_FILING_WINDOW_DAYS} days of the ${printDate} print (${filings.length} recent checked)`,
    };
  }
  if (expected) return { filing, key: expected };

  const stated = statedFiscalQuarterDetail(filing.pressReleaseText);
  if (isStrongStatement(stated)) {
    if (stated.year !== null) return { filing, key: { year: stated.year, quarter: stated.quarter } };
    if (stated.quarter !== requested.quarter) {
      return {
        reason: `the release filed ${filing.filingDate} states Q${stated.quarter} with no year, the print has no Finnhub fiscal quarter, and the calendar key Q${requested.quarter} ${requested.year} disagrees: no key to store it under`,
      };
    }
  }
  return { filing, key: requested };
}

function chooseFilingForKey(filings: Earnings8KFiling[], key: FiscalQuarter): FilingChoice {
  const byStatement = filings.find((f) => {
    const stated = statedFiscalQuarterDetail(f.pressReleaseText);
    return isStrongStatement(stated) && stated.year === key.year && stated.quarter === key.quarter;
  });
  if (byStatement) return { filing: byStatement, key };

  const byCalendar = filings.find((f) => {
    const q = deriveFilingReportingQuarter(f.filingDate);
    return (
      q.year === key.year &&
      q.quarter === key.quarter &&
      transcriptQuarterMismatchReason({
        ticker: "",
        year: key.year,
        quarter: key.quarter,
        source: "edgar_8k",
        transcript: f.pressReleaseText,
      }) === null
    );
  });
  if (byCalendar) return { filing: byCalendar, key };

  return {
    reason: `none of ${filings.length} recent earnings 8-Ks states Q${key.quarter} ${key.year} or was filed for it`,
  };
}

async function fetchFiling(
  db: Database.Database,
  securityId: number | null,
  upperTicker: string,
  requested: FiscalQuarter,
  printDate: string | null,
  expected: FiscalQuarter | null,
): Promise<FetchTranscriptResult | null> {
  const label = `${upperTicker} ${requested.year}Q${requested.quarter}`;
  let filings: Earnings8KFiling[];
  try {
    // Full text so cached rows carry the complete body; the chat-tool layer
    // decides whether to hand the model an excerpt or the whole thing.
    filings = await getEarnings8KFilings(upperTicker, { limit: 4, fullText: true });
  } catch (err) {
    console.warn(`[transcripts] EDGAR lookup failed for ${label}: ${errorText(err)}`);
    return null;
  }

  const choice = printDate
    ? chooseFilingForPrint(filings, printDate, expected, requested)
    : chooseFilingForKey(filings, requested);
  if ("reason" in choice) {
    console.log(`[transcripts] no 8-K filing stored for ${label}: ${choice.reason}`);
    return null;
  }
  const { filing, key } = choice;
  const sourceKey = `edgar_8k:${filing.accessionNumber}`;

  // Already cached with this exact text: nothing new to write (and no reason
  // to overwrite an AI desk note with the extractive summary again).
  const stored = db
    .prepare("SELECT * FROM earnings_transcripts WHERE source_key = ?")
    .get(sourceKey) as EarningsTranscript | undefined;
  if (stored && stored.transcript === filing.pressReleaseText) {
    return { transcript: stored, fromCache: true };
  }

  try {
    const transcript = upsertTranscript(db, {
      security_id: securityId,
      ticker: upperTicker,
      year: key.year,
      quarter: key.quarter,
      call_date: filing.filingDate,
      source: "edgar_8k",
      transcript: filing.pressReleaseText,
      summary: generateSummary(filing.pressReleaseText),
      guidance: extractGuidance(filing.pressReleaseText),
      risk_factors: extractRiskFactors(filing.pressReleaseText),
      sentiment_score: null,
      sentiment_label: null,
      participants: null,
      accession_number: filing.accessionNumber,
      filing_url: filing.filingUrl,
      source_key: sourceKey,
      print_event_date: printDate,
    });
    return { transcript, fromCache: false };
  } catch (err) {
    if (!(err instanceof TranscriptQuarterMismatchError)) {
      console.warn(`[transcripts] could not store the 8-K filing for ${label}: ${errorText(err)}`);
    }
    return null;
  }
}

// ─── Main Fetch Pipeline ────────────────────────────────────────

/**
 * Fetch an earnings transcript, checking cache first then external sources.
 *
 * Fallback chain: Cache → API Ninjas → Alpha Vantage → EDGAR 8-K
 *
 * Three kinds of request:
 *
 * - A print with a known fiscal quarter (`eventDate` + `expectedFiscalQuarter`):
 *   the vendor is asked for that fiscal key and its call is cached only when
 *   the call itself names that quarter. Every rejection goes on to the
 *   filing, which is matched to the print by filing date.
 * - A print whose fiscal quarter is unknown (`eventDate` alone): no call can
 *   be verified, so no vendor is asked and no cached call is consulted. Only
 *   the filing path runs.
 * - An explicit (year, quarter) with no print: every source is tried and each
 *   result must not contradict the key (see `upsertTranscript`).
 *
 * @param year Earnings year (defaults to the calendar-recent quarter)
 * @param quarter Quarter 1-4 (defaults to the calendar-recent quarter)
 */
export async function fetchTranscript(
  db: Database.Database,
  ticker: string,
  year?: number,
  quarter?: number,
  options: FetchTranscriptOptions = {},
): Promise<FetchTranscriptResult | null> {
  const upperTicker = ticker.toUpperCase();
  const printDate = options.eventDate ?? null;
  const expected = options.expectedFiscalQuarter ?? null;

  if (expected) {
    year = expected.year;
    quarter = expected.quarter;
  }
  // Default to most recent quarter if not specified
  if (!year || !quarter) {
    const recent = getMostRecentQuarter();
    year = year || recent.year;
    quarter = quarter || recent.quarter;
  }
  const requested: FiscalQuarter = { year, quarter };
  const securityId = resolveSecurityId(db, upperTicker);

  if (printDate && !expected) {
    const cachedFiling = getCachedFilingForPrint(db, upperTicker, printDate);
    if (cachedFiling) return { transcript: cachedFiling, fromCache: true };
    return fetchFiling(db, securityId, upperTicker, requested, printDate, null);
  }

  const requireStatedQuarter = !!expected;

  // 1. Check cache
  const cached = getCachedTranscript(db, upperTicker, year, quarter);
  if (cached && !isFilingRow(cached)) return { transcript: cached, fromCache: true };

  // A filing is a press release, not a call. A quarter cached from EDGAR
  // (before Alpha Vantage was configured, while it was down, or because the
  // vendor had not posted the call yet) must not block the call forever: try
  // a one-shot upgrade. A vendor miss leaves the cached filing in place; the
  // higher source priority in getCachedTranscript means a successful upgrade
  // wins from then on.
  const cachedFiling =
    cached ?? (printDate ? getCachedFilingForPrint(db, upperTicker, printDate) : null);
  if (cachedFiling) {
    const upgraded = await tryAlphaVantage(
      db,
      cachedFiling.security_id ?? securityId,
      upperTicker,
      year,
      quarter,
      { skip: options.skipAlphaVantage, requireStatedQuarter },
    );
    if (upgraded.transcript) return { transcript: upgraded.transcript, fromCache: false };
    return { transcript: cachedFiling, fromCache: true };
  }

  // 2. Try API Ninjas (if configured — paid tier)
  if (isApiNinjasConfigured()) {
    try {
      const result = await getApiNinjasTranscript(upperTicker, year, quarter);
      if (result && result.transcript) {
        const callDate = result.date ? result.date.slice(0, 10) : null;
        const mismatch = !callDateMatchesPrint(callDate, options.eventDate)
          ? `call date ${callDate ?? "missing"} is not within ${TRANSCRIPT_CALL_DATE_WINDOW_DAYS} days of the ${options.eventDate} print`
          : transcriptQuarterMismatchReason({
              ticker: upperTicker,
              year,
              quarter,
              source: "api_ninjas",
              transcript: result.transcript,
              requireStatedQuarter,
            });
        if (mismatch) {
          console.warn(
            `[transcripts] rejected api_ninjas ${upperTicker} ${year}Q${quarter}: ${mismatch}; nothing cached, going on to the next source`,
          );
        } else {
          const transcript = upsertTranscript(db, {
            security_id: securityId,
            ticker: upperTicker,
            year,
            quarter,
            call_date: callDate,
            source: "api_ninjas",
            transcript: result.transcript,
            summary: result.summary || generateSummary(result.transcript),
            guidance: result.guidance || extractGuidance(result.transcript),
            risk_factors: result.risk_factors || extractRiskFactors(result.transcript),
            sentiment_score: result.overall_sentiment ?? null,
            sentiment_label: result.overall_sentiment
              ? result.overall_sentiment > 0.2
                ? "bullish"
                : result.overall_sentiment < -0.2
                  ? "bearish"
                  : "neutral"
              : null,
            participants: result.participants
              ? JSON.stringify(result.participants)
              : null,
            source_key: `api_ninjas:${upperTicker}:${year}:${quarter}`,
            require_stated_quarter: requireStatedQuarter,
          });
          return { transcript, fromCache: false };
        }
      }
    } catch (err) {
      if (!(err instanceof TranscriptQuarterMismatchError)) {
        console.warn(
          `[transcripts] api_ninjas failed for ${upperTicker} ${year}Q${quarter}: ${errorText(err)}; going on to the next source`,
        );
      }
    }
  }

  // 3. Try Alpha Vantage (if configured — free tier, 25 req/day). The client
  // passes year+quarter through as Alpha Vantage's FISCAL YYYYQN param and
  // never throws.
  {
    const vendor = await tryAlphaVantage(db, securityId, upperTicker, year, quarter, {
      skip: options.skipAlphaVantage,
      requireStatedQuarter,
    });
    if (vendor.transcript) return { transcript: vendor.transcript, fromCache: false };
  }

  // 4. Fall back to the EDGAR 8-K press release.
  return fetchFiling(db, securityId, upperTicker, requested, printDate, expected);
}

/**
 * The latest document when the caller names no quarter (the fetch button,
 * the chat tool). The ONE default for "the latest". Three cases:
 *
 * - The most recent print's fiscal quarter is known: the request is made by
 *   that FISCAL quarter and tied to the print's date.
 * - The most recent print is on file but no Finnhub entry states its fiscal
 *   quarter: only the print's 8-K press release is fetched, matched by filing
 *   date. No vendor is asked by calendar quarter: for a company whose fiscal
 *   year is not the calendar year that request returns an OLDER fiscal
 *   quarter's call, truthfully keyed, and it used to come back as "the
 *   latest" (2026-10-08). Null when the print has no 8-K in its window.
 * - No print is on file at all: the calendar default is all there is. The
 *   result carries `latestConfirmed: false` so no surface calls it the latest.
 */
export async function fetchLatestTranscript(
  db: Database.Database,
  ticker: string,
): Promise<FetchTranscriptResult | null> {
  const print = latestPrintOnFile(db, ticker);
  if (!print) {
    const result = await fetchTranscript(db, ticker);
    return result ? { ...result, latestConfirmed: false } : null;
  }
  // With no fiscal quarter the key is the same calendar fallback the same-day
  // sweep uses for such a print; `fetchTranscript` then runs the filing path
  // only.
  const key = print.fiscal ?? deriveFilingReportingQuarter(print.eventDate);
  const result = await fetchTranscript(db, ticker, key.year, key.quarter, {
    eventDate: print.eventDate,
    ...(print.fiscal ? { expectedFiscalQuarter: print.fiscal } : {}),
  });
  return result ? { ...result, latestConfirmed: true } : null;
}

/**
 * Detect whether a cached edgar_8k entry pre-dates the full-text upgrade
 * (Theme E2 — 2026-04-22). Old caches are <=5100 chars; new ones cap at
 * 60K. If the caller asks for full text and the cached body is suspiciously
 * short, the filing is fetched again and the row is replaced in place.
 */
function isLegacyShortEdgar8k(t: EarningsTranscript): boolean {
  if (!isFilingRow(t)) return false;
  return !!t.transcript && t.transcript.length <= 5200;
}

/**
 * Fetch the full text of a legacy truncated filing row and replace the row's
 * body IN PLACE. Fetch first, replace only on success: the cached row is
 * never removed, so a failed or rejected re-fetch leaves it exactly as it was.
 */
async function refreshLegacyFiling(
  db: Database.Database,
  row: EarningsTranscript,
): Promise<EarningsTranscript | null> {
  const label = `${row.ticker} ${row.year}Q${row.quarter}`;
  let filings: Earnings8KFiling[];
  try {
    filings = await getEarnings8KFilings(row.ticker, { limit: 4, fullText: true });
  } catch (err) {
    console.warn(`[transcripts] full-text refresh failed for ${label}: ${errorText(err)}; cached row kept`);
    return null;
  }
  const sameFiling = row.accession_number
    ? filings.find((f) => f.accessionNumber === row.accession_number)
    : undefined;
  const choice = sameFiling
    ? { filing: sameFiling }
    : chooseFilingForKey(filings, { year: row.year, quarter: row.quarter });
  if ("reason" in choice) {
    console.log(`[transcripts] full-text refresh found nothing for ${label}: ${choice.reason}; cached row kept`);
    return null;
  }
  const { filing } = choice;
  if (filing.pressReleaseText.length <= (row.transcript?.length ?? 0)) {
    console.log(`[transcripts] full-text refresh for ${label} returned no longer body; cached row kept`);
    return null;
  }
  try {
    return upsertTranscript(db, {
      security_id: row.security_id,
      ticker: row.ticker,
      year: row.year,
      quarter: row.quarter,
      call_date: filing.filingDate,
      source: row.source,
      transcript: filing.pressReleaseText,
      summary: generateSummary(filing.pressReleaseText),
      guidance: extractGuidance(filing.pressReleaseText),
      risk_factors: extractRiskFactors(filing.pressReleaseText),
      sentiment_score: null,
      sentiment_label: null,
      participants: null,
      accession_number: filing.accessionNumber,
      filing_url: filing.filingUrl,
      source_key: row.source_key,
    });
  } catch (err) {
    if (!(err instanceof TranscriptQuarterMismatchError)) {
      console.warn(`[transcripts] full-text refresh could not store ${label}: ${errorText(err)}; cached row kept`);
    }
    return null;
  }
}

/**
 * Get transcript for the chat tool — returns structured data
 * optimized for Claude's context window.
 *
 * With no quarter named, the default is the issuer's latest print
 * (`fetchLatestTranscript`), the same default the fetch button uses. When no
 * earnings date is on file the calendar default is used and the result says
 * so (`latest_confirmed: false`, `latest_note`).
 *
 * @param fullText when true, returns the complete transcript body in the
 *   `excerpt` field (field name kept for back-compat). Default false keeps
 *   the ~1000-word excerpt that list views rely on. If the cached entry
 *   was produced pre-E2 with the 5000-char EDGAR truncation, the filing is
 *   fetched again and the row replaced on success; when that fails the
 *   cached short body is returned with `truncated: true`.
 */
export async function getTranscriptForChat(
  db: Database.Database,
  ticker: string,
  year?: number,
  quarter?: number,
  options: { fullText?: boolean } = {},
): Promise<{
  ticker: string;
  year: number;
  quarter: number;
  call_date: string | null;
  source: string;
  summary: string | null;
  guidance: string | null;
  risk_factors: string | null;
  sentiment: { label: string; score: number } | null;
  excerpt: string | null;
  transcript_length_words: number;
  has_full_transcript: boolean;
  truncated: boolean;
  /**
   * Only when no quarter was named. true: tied to the issuer's most recent
   * earnings print. false: no earnings date is on file, so this may not be
   * the most recent document (`latest_note` says so in plain words). null:
   * the caller named the quarter, so no claim about "latest" is made.
   */
  latest_confirmed: boolean | null;
  latest_note: string | null;
} | null> {
  let result =
    !year || !quarter
      ? await fetchLatestTranscript(db, ticker)
      : await fetchTranscript(db, ticker, year, quarter);
  if (!result) return null;
  const latestConfirmed = result.latestConfirmed ?? null;

  const fullText = !!options.fullText;
  let legacyBodyKept = false;

  // Cache upgrade: re-fetch legacy EDGAR rows when the caller wants full text.
  if (fullText && result.fromCache && isLegacyShortEdgar8k(result.transcript)) {
    const refreshed = await refreshLegacyFiling(db, result.transcript);
    if (refreshed) {
      result = { transcript: refreshed, fromCache: false };
    } else {
      // The cached row survives. Its body is the pre-E2 truncation, so it is
      // returned flagged as truncated rather than passed off as full text.
      legacyBodyKept = true;
    }
  }

  const t = result.transcript;

  let excerpt: string | null = null;
  let truncated = false;
  if (t.transcript) {
    if (fullText) {
      excerpt = t.transcript;
      truncated = legacyBodyKept;
    } else {
      const words = t.transcript.split(/\s+/);
      if (words.length > 1000) {
        excerpt = words.slice(0, 1000).join(" ") + "...";
        truncated = true;
      } else {
        excerpt = t.transcript;
      }
    }
  }

  return {
    ticker: t.ticker,
    year: t.year,
    quarter: t.quarter,
    call_date: t.call_date,
    source: t.source,
    summary: t.summary,
    guidance: t.guidance,
    risk_factors: t.risk_factors,
    sentiment:
      t.sentiment_label && t.sentiment_score !== null
        ? { label: t.sentiment_label, score: t.sentiment_score }
        : null,
    excerpt,
    transcript_length_words: t.transcript
      ? t.transcript.split(/\s+/).length
      : 0,
    has_full_transcript: !!t.transcript && t.transcript.length > 100,
    truncated,
    latest_confirmed: latestConfirmed,
    latest_note:
      latestConfirmed === false
        ? `This ${kindHeadingLabel(t)} is for fiscal Q${t.quarter} ${t.year}. No earnings date is on file for ${t.ticker}, so it could not be confirmed as the most recent one; a newer one may exist.`
        : null,
  };
}
