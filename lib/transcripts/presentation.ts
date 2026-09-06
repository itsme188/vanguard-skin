/**
 * Presentation rules for `earnings_transcripts` rows — the single source for
 * "what IS this row, and is its summary worth showing?".
 *
 * Two facts about the table drive every render surface:
 *
 * 1. KIND. `source = 'edgar_8k'` rows are the SEC Form 8-K earnings PRESS
 *    RELEASE (lib/transcripts/fetch.ts stores `matchingFiling.pressReleaseText`),
 *    not a conference-call transcript: no Q&A, no operator, no management
 *    dialogue. Every other source (api_ninjas / alpha_vantage / motley_fool)
 *    is a real call transcript. A surface must never call an 8-K row a call —
 *    lib/chat/validate.ts has warned the chat tool about this for months, and
 *    the wording here matches it.
 *
 * 2. DESK NOTE. The `summary` column holds one of two very different things:
 *      - a real AI desk note (Guidance / Tone / Surprises / Key quotes),
 *        written by `summarizeTranscript` (lib/transcripts/same-day.ts) for
 *        ANY source whose text clears `MIN_TRANSCRIPT_CHARS_FOR_AI` (5,000
 *        chars) — a FAT 8-K press release therefore carries a genuine desk
 *        note, and the morning digest already renders it;
 *      - a mechanical extractive excerpt (`generateSummary`,
 *        lib/transcripts/fetch.ts) — the first ~300 words of the document
 *        plus keyword-matched paragraphs. On a THIN 8-K cover page (observed:
 *        3,774 and 4,091 chars) that excerpt is filing boilerplate
 *        ("Item 2.02 Results of Operations…") and says nothing.
 *
 *    The row shape available to the render surfaces (TranscriptSummaryEntry)
 *    does NOT carry the transcript length, so the desk-note test reads the
 *    summary itself — using the same rule as the STORE-time gate
 *    `isValidDeskNote` (lib/transcripts/same-day.ts): a desk note carries at
 *    least one of the mandated bold section labels and is not a soft refusal.
 *    That gate decides whether an AI note is ever written over the extractive
 *    summary, so agreeing with it IS the definition. The rule is duplicated
 *    (not imported) because this module must stay dependency-free — it is
 *    imported by "use client" components, and same-day.ts pulls in
 *    better-sqlite3. `tests/transcripts/presentation.test.ts` pins the two
 *    implementations together; if `isValidDeskNote` moves, that test fails.
 *
 * Pure functions only: no DB, no I/O, no React. Presentation only — nothing
 * here changes fetching, storage, source ranking, or the AI pipeline.
 */

export type TranscriptKind = "call" | "filing";

/** The minimum row shape every helper needs. */
export interface TranscriptKindRow {
  source: string;
}

/** Rows whose `summary` may or may not be an AI desk note. */
export interface TranscriptSummaryRow {
  source?: string;
  summary?: string | null;
}

/**
 * Sources that are SEC filings rather than call transcripts. Keyed on the
 * stored `source` token, compared case-insensitively.
 */
const FILING_SOURCES = new Set(["edgar_8k"]);

/** Mirror of `DESK_NOTE_SECTION_RE` in lib/transcripts/same-day.ts. */
const DESK_NOTE_SECTION_RE = /\*\*(Guidance|Tone|Surprises|Key quotes)\*\*/i;

/** Mirror of `DESK_NOTE_REFUSAL_RE` in lib/transcripts/same-day.ts. */
const DESK_NOTE_REFUSAL_RE =
  /please provide|provide the transcript|i(?:'|’)ll produce the|as specified[.,]?\s*$/im;

/** Short badge label per known source. */
const SOURCE_LABELS: Record<string, string> = {
  edgar_8k: "8-K",
  motley_fool: "MF",
  api_ninjas: "API",
  alpha_vantage: "AV",
};

/** Is this row an SEC filing (8-K press release) or a call transcript? */
export function transcriptKind(row: TranscriptKindRow): TranscriptKind {
  return FILING_SOURCES.has((row.source ?? "").trim().toLowerCase()) ? "filing" : "call";
}

/** Convenience predicate — `transcriptKind(row) === "filing"`. */
export function isFilingRow(row: TranscriptKindRow): boolean {
  return transcriptKind(row) === "filing";
}

/**
 * True when `summary` is a real AI desk note (safe to render as analysis),
 * false when it is the mechanical extractive excerpt of the source document
 * (or missing). See the module header for why this mirrors `isValidDeskNote`.
 */
export function hasDeskNote(row: TranscriptSummaryRow): boolean {
  const summary = row.summary?.trim();
  if (!summary) return false;
  if (!DESK_NOTE_SECTION_RE.test(summary)) return false;
  if (DESK_NOTE_REFUSAL_RE.test(summary)) return false;
  return true;
}

/** Badge/chip noun: "8-K filing" or "transcript". Never the raw source. */
export function kindLabel(row: TranscriptKindRow): string {
  return transcriptKind(row) === "filing" ? "8-K filing" : "transcript";
}

/**
 * Heading noun for prose surfaces (emails, section headers): "8-K press
 * release" or "call". Reads correctly after "From the …" and after
 * "Q3 2026 …".
 */
export function kindHeadingLabel(row: TranscriptKindRow): string {
  return transcriptKind(row) === "filing" ? "8-K press release" : "call";
}

/**
 * Short display label for the row's provider. Unknown sources are humanized
 * (underscores to spaces, upper-cased) rather than printed as the raw stored
 * token, so a new provider id never leaks into the UI verbatim.
 */
export function sourceLabel(row: TranscriptKindRow): string {
  const raw = (row.source ?? "").trim();
  if (!raw) return "UNKNOWN";
  const known = SOURCE_LABELS[raw.toLowerCase()];
  if (known) return known;
  return raw.replace(/[_-]+/g, " ").trim().toUpperCase();
}

/**
 * "2 transcripts, 1 filing" — a group header that counts calls and filings
 * separately instead of calling an 8-K press release a transcript. Empty
 * string for an empty list, so callers can render nothing.
 */
export function transcriptCountLabel(rows: TranscriptKindRow[]): string {
  const filings = rows.filter((r) => transcriptKind(r) === "filing").length;
  const calls = rows.length - filings;
  const parts: string[] = [];
  if (calls > 0) parts.push(`${calls} transcript${calls === 1 ? "" : "s"}`);
  if (filings > 0) parts.push(`${filings} filing${filings === 1 ? "" : "s"}`);
  return parts.join(", ");
}
