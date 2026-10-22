// EDGAR discovery for the armed-print filing summary (spec §4 "Finding the
// filings", R11). No db access in this module.
//
// This is its OWN code, stricter than print-watch's EDGAR road
// (`lib/print-watch/edgar-adapter.ts`), which only looks at 8-K / 6-K EX-99
// exhibits inside the release window. Here:
//
//   - every document group of a filing's `-index-headers.html` is read (main
//     document and every exhibit), not only EX-99;
//   - the `<ITEMS>` lines are read so the earnings 8-K (Item 2.02) can be told
//     from any other 8-K;
//   - a header fetch failure is REPORTED per filing, never dropped (R11: every
//     filing records its own fetch result; a failed fetch makes the run
//     incomplete), where print-watch silently retries on the next poll.
//
// ACCEPTANCE TIME. The submissions JSON's `acceptanceDateTime` is unreliable
// (see the "ACCEPTANCE-TIME QUIRK" note in edgar-adapter.ts). The JSON is used
// here only as a cheap PREFILTER: a filing survives when EITHER reading (the
// literal UTC instant, or the Eastern wall-clock reading) falls on the event
// day in America/New_York. The header's `<ACCEPTANCE-DATETIME>` (always
// Eastern) is what the caller decides on — the 20:00 cutoff and the companion
// ordering belong to the caller. A header without it gives
// `acceptanceMs: null`, and the caller lists that filing as "time
// unconfirmed" (never run automatically).
//
// Request pacing is the caller's: it passes a throttled fetch (the
// acquisition scheduler's low-priority SEC lane). Every request carries the
// SEC fair-access User-Agent and goes through the shared hardened fetch.

import {
  EDGAR_HEADER_ACCEPTANCE_RE,
  SEC_USER_AGENT,
  fetchSubmissionsRecent,
  parseEdgarAcceptanceDateTime,
} from "@/lib/print-watch/edgar-adapter";
import { CONTENT_TYPE_MARKUP, hardenedFetchText, type FetchLike } from "@/lib/print-watch/hardened-fetch";
import { todayET } from "@/lib/calendar/date-utils";

export type { FetchLike };

const SEC_WWW_HOST = "www.sec.gov";

/** Per-document cap (R11): 10-Qs are large. Larger is skipped with a reason. */
export const FILING_DOCUMENT_MAX_BYTES = 16 * 1024 * 1024;
export const OVER_DOCUMENT_CAP_REASON = "over 16 MB";

export type FilerKind = "domestic" | "foreign";
export type FilingClass = "earnings" | "companion" | "ignored";

export interface FilingDocument {
  /** The EDGAR document type, e.g. `8-K`, `EX-99.1`, `EX-101.SCH`, `GRAPHIC`. */
  type: string;
  sequence: number;
  fileName: string;
  description: string | null;
}

export interface FilingHeader {
  /** True-UTC ms from the header's Eastern `<ACCEPTANCE-DATETIME>`, or null
   *  when the header lacks it (the caller marks the time unconfirmed). */
  acceptanceMs: number | null;
  /** Every `<ITEMS>` line, in header order, once each (e.g. `2.02`, `9.01`). */
  items: string[];
  documents: FilingDocument[];
}

export interface DayFiling {
  accession: string;
  form: string;
  header: FilingHeader | null;
  /** Why the header could not be fetched; null when it was. */
  headerError: string | null;
}

/** Undo the entity escaping EDGAR applies to the SGML inside the header's
 *  `<PRE>`. `&amp;` goes last so `&amp;lt;` stays a literal `&lt;`. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The value of an SGML `<TAG>value` line inside one document block. */
function sgmlField(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>[ \\t]*([^\\r\\n<]*)`).exec(block);
  if (!m) return null;
  const value = decodeEntities(m[1]).trim();
  return value === "" ? null : value;
}

const RAW_ACCEPTANCE_RE = /<ACCEPTANCE-DATETIME>\s*(\d{14})/;

function acceptanceFrom(html: string): number | null {
  const m = EDGAR_HEADER_ACCEPTANCE_RE.exec(html) ?? RAW_ACCEPTANCE_RE.exec(html);
  if (!m) return null;
  const d = m[1];
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}`;
  const ms = parseEdgarAcceptanceDateTime(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Read a filing's `-index-headers.html`: the Eastern acceptance time, every
 * `<ITEMS>` line (EDGAR puts them raw in the leading HTML comment; escaped
 * ones are read too) and every `<DOCUMENT>` group's
 * `<TYPE>`/`<SEQUENCE>`/`<FILENAME>`/`<DESCRIPTION>`. The submission's own
 * header `<TYPE>` sits outside any document group and is not a document.
 * A group without a type or file name cannot be fetched and is left out.
 */
export function parseFilingHeader(html: string): FilingHeader {
  const acceptanceMs = acceptanceFrom(html);
  // Unescape the angle brackets once so the raw comment and the escaped
  // <PRE> read the same way; field values are entity-decoded separately.
  const text = html.replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  const items: string[] = [];
  const itemRe = /<ITEMS>[ \t]*([^\s<]+)/g;
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(text)) !== null) {
    if (!items.includes(im[1])) items.push(im[1]);
  }

  const documents: FilingDocument[] = [];
  const blockRe = /<DOCUMENT>([\s\S]*?)<\/DOCUMENT>/g;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(text)) !== null) {
    const block = bm[1];
    const type = sgmlField(block, "TYPE");
    const fileName = sgmlField(block, "FILENAME");
    if (!type || !fileName) continue;
    const seq = Number(sgmlField(block, "SEQUENCE"));
    documents.push({
      type,
      sequence: Number.isInteger(seq) && seq > 0 ? seq : documents.length + 1,
      fileName,
      description: sgmlField(block, "DESCRIPTION"),
    });
  }

  return { acceptanceMs, items, documents };
}

/** Companion allow list (Global Constraints). `424B*` is matched by prefix. */
const COMPANION_FORMS = new Set([
  "PRE 14A",
  "DEF 14A",
  "PRE 14C",
  "DEF 14C",
  "8-K",
  "8-K/A",
  "10-Q",
  "10-K",
  "S-3",
  "S-3ASR",
  "S-8",
  "SC TO-I",
]);
/** Added to the allow list for a 6-K filer only. */
const FOREIGN_COMPANION_FORMS = new Set(["6-K", "F-3"]);

function normalizeForm(form: string): string {
  return form.trim().toUpperCase().replace(/\s+/g, " ");
}

function isAllowListed(form: string, filerKind: FilerKind): boolean {
  if (COMPANION_FORMS.has(form)) return true;
  if (/^424B[0-9A-Z]*$/.test(form)) return true;
  return filerKind === "foreign" && FOREIGN_COMPANION_FORMS.has(form);
}

/**
 * Whether a filing is the earnings filing, a companion, or ignored.
 *
 *  - Domestic earnings: an `8-K` carrying Item `2.02`.
 *  - Foreign (6-K filer) earnings: a `6-K` with an `EX-99*` document.
 *  - Companion: any other allow-listed form (an `8-K` without 2.02, an
 *    `8-K/A`, a later `6-K` without EX-99 …). Whether it came AFTER the
 *    earnings filing and before 20:00 is the caller's decision, on the
 *    header acceptance time.
 *  - Ignored: Forms 3, 4, 5, 144 and everything else off the list.
 */
export function classifyFiling(
  form: string,
  items: string[],
  documents: ReadonlyArray<Pick<FilingDocument, "type">>,
  filerKind: FilerKind,
): FilingClass {
  const f = normalizeForm(form);
  if (filerKind === "domestic" && f === "8-K" && items.some((i) => i.trim() === "2.02")) {
    return "earnings";
  }
  if (filerKind === "foreign" && f === "6-K" && documents.some((d) => /^EX-99/i.test(d.type.trim()))) {
    return "earnings";
  }
  return isAllowListed(f, filerKind) ? "companion" : "ignored";
}

const SKIPPED_TYPES = new Set(["GRAPHIC", "ZIP", "XML", "JSON"]);
const SKIPPED_EXTENSIONS = /\.(jpg|jpeg|png|gif|xsd|xml|json|zip)$/i;

/**
 * Why a document is not fetched (graphics, XBRL parts, zips, data files), or
 * null when it is a document to read.
 */
export function shouldSkipDocument(type: string, fileName: string): string | null {
  const t = type.trim().toUpperCase();
  if (SKIPPED_TYPES.has(t)) return `skipped: ${t} document`;
  if (/^EX-101\./.test(t)) return `skipped: XBRL part (${t})`;
  const ext = SKIPPED_EXTENSIONS.exec(fileName.trim());
  if (ext) return `skipped: .${ext[1].toLowerCase()} file`;
  return null;
}

/** A filer is foreign when its recent forms include `6-K` or `20-F` and no
 *  `10-Q`. */
export function inferFilerKind(forms: readonly string[]): FilerKind {
  const set = new Set(forms.map(normalizeForm));
  if (set.has("10-Q")) return "domestic";
  return set.has("6-K") || set.has("20-F") ? "foreign" : "domestic";
}

function filingBase(cik: string, accession: string): string {
  const cikNum = String(Number(cik));
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession.replace(/-/g, "")}`;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function onEasternDay(ms: number, eventDate: string): boolean {
  return Number.isFinite(ms) && todayET(new Date(ms)) === eventDate;
}

/**
 * The submissions list's filings that may have been accepted on `eventDate`
 * (Eastern), each with its header read, plus the filer kind inferred from the
 * same list (one submissions fetch serves both).
 *
 * Throws only when the submissions fetch itself fails (the caller maps that to
 * `sec_unreachable`) or on an abort. A header fetch failure is reported on its
 * own entry and the other filings still return.
 */
export async function readDayFilings(
  cik: string,
  eventDate: string,
  fetchFn: FetchLike,
): Promise<{ filerKind: FilerKind; filings: DayFiling[] }> {
  const recent = await fetchSubmissionsRecent(cik, fetchFn);
  const filerKind = inferFilerKind(recent.form);
  const filings: DayFiling[] = [];

  for (let i = 0; i < recent.accessionNumber.length; i += 1) {
    const raw = recent.acceptanceDateTime[i];
    const literalUtc = Date.parse(raw);
    const easternWall = parseEdgarAcceptanceDateTime(raw);
    if (!onEasternDay(literalUtc, eventDate) && !onEasternDay(easternWall, eventDate)) continue;

    const accession = recent.accessionNumber[i];
    const form = recent.form[i];
    try {
      const html = await hardenedFetchText(
        `${filingBase(cik, accession)}/${accession}-index-headers.html`,
        fetchFn,
        {
          host: SEC_WWW_HOST,
          label: "EDGAR index-headers",
          contentType: CONTENT_TYPE_MARKUP,
          headers: { "User-Agent": SEC_USER_AGENT },
        },
      );
      filings.push({ accession, form, header: parseFilingHeader(html), headerError: null });
    } catch (err) {
      if (isAbort(err)) throw err;
      filings.push({
        accession,
        form,
        header: null,
        headerError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { filerKind, filings };
}

/** `readDayFilings` without the filer kind (the contract shape). */
export async function listDayFilings(
  cik: string,
  eventDate: string,
  fetchFn: FetchLike,
): Promise<DayFiling[]> {
  return (await readDayFilings(cik, eventDate, fetchFn)).filings;
}

/** A plain file name inside the filing folder: no path, no scheme. */
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Fetch one document of a filing as markup, capped at 16 MB. Never throws
 * except on an abort: every failure comes back as `{ok:false, reason}` so the
 * caller can put it in the coverage list (R11).
 */
export async function fetchFilingDocument(
  cik: string,
  accession: string,
  fileName: string,
  fetchFn: FetchLike,
): Promise<{ ok: true; html: string; bytes: number } | { ok: false; reason: string }> {
  if (!SAFE_FILE_NAME.test(fileName) || fileName.includes("..")) {
    return { ok: false, reason: "not a plain file name in the filing" };
  }
  try {
    const html = await hardenedFetchText(`${filingBase(cik, accession)}/${fileName}`, fetchFn, {
      host: SEC_WWW_HOST,
      label: "EDGAR filing document",
      contentType: CONTENT_TYPE_MARKUP,
      headers: { "User-Agent": SEC_USER_AGENT },
      maxBytes: FILING_DOCUMENT_MAX_BYTES,
    });
    return { ok: true, html, bytes: Buffer.byteLength(html, "utf8") };
  } catch (err) {
    if (isAbort(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // hardenedFetchText names its byte cap in both the content-length
    // precheck and the streamed read.
    if (message.includes(`${FILING_DOCUMENT_MAX_BYTES}-byte cap`)) {
      return { ok: false, reason: OVER_DOCUMENT_CAP_REASON };
    }
    return { ok: false, reason: message };
  }
}
