// The document-to-event gate (v1 spec §4.4), moved out of the watcher so the
// delivery store (Task 8) and the merge handler (Task 13) can evaluate it
// without importing the watcher. Pure: no db, no I/O.
import crypto from "node:crypto";
import type { PrintWatchDocKind } from "./types";

/** Bump when the gate's rules change: a stored `gate_fingerprint` built under
 *  an older version differs and the next delivery re-evaluates the verdict. */
export const GATE_VERSION = 2;

export interface DocGateContext {
  symbol: string;
  issuerName: string | null;
  eventDate: string;
  /**
   * Which source produced the bytes. Only `ir-page` changes the verdict (fix
   * wave, finding A): an IR newsroom article is the one input whose ARRIVAL
   * carries no period evidence at all — EDGAR filings passed an acceptance-
   * window filter and DJ items came from a windowed news query for this
   * conId, but a newsroom feed serves last quarter's release from the same
   * URL space, matching the same title regex, forever. Omitted (or any other
   * kind) keeps the historical, generous behaviour.
   */
  kind?: PrintWatchDocKind;
}

export type DocGateVerdict = { ok: true } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// document-to-event gate (Codex #1)
// ---------------------------------------------------------------------------

const CORPORATE_SUFFIXES =
  /\b(incorporated|inc|corporation|corp|company|co|holdings|holding|group|plc|ltd|limited|sa|nv|ag|technologies|systems)\b\.?/gi;

const QUARTER_WORD_RE = /\b(first|second|third|fourth)\s+quarter\b|\bq[1-4]\b/i;
const FISCAL_YEAR_RE = /\bfiscal(\s+year)?\s+20\d\d\b|\bfy\s?20\d\d\b/i;
const ORDINALS = ["", "first", "second", "third", "fourth"];

/** Company name reduced to its distinctive head ("NVIDIA Corporation" ->
 *  "nvidia"). Returns null when nothing distinctive survives, so a name like
 *  "Holdings Inc" can never match every document on earth. */
function issuerNeedle(issuerName: string | null): string | null {
  if (!issuerName) return null;
  const stripped = issuerName
    .replace(/[,.]/g, " ")
    .replace(CORPORATE_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return stripped.length >= 3 ? stripped : null;
}

/** Calendar quarter of the event date, plus the preceding one: a print on
 *  2026-08-26 is nearly always ABOUT the quarter that just ended. */
function candidateQuarters(eventDate: string): Array<{ q: number; year: number }> {
  const [y, m] = eventDate.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return [];
  const q = Math.floor((m - 1) / 3) + 1;
  const prev = q === 1 ? { q: 4, year: y - 1 } : { q: q - 1, year: y };
  return [{ q, year: y }, prev];
}

/**
 * The gate a document must pass before a single one of its numbers is allowed
 * near a contract line: it must NAME this issuer (ticker or company head) and
 * state a plausible fiscal period.
 *
 * The period rule is deliberately generous on the FISCAL side (the CRWD
 * lesson: a release printed in June 2026 legitimately says "First Quarter
 * Fiscal Year 2027", which matches no calendar-quarter token at all). Once the
 * symbol itself appears, any "fiscal 20xx" + quarter-word pairing counts. The
 * narrow guards that keep this honest live upstream: EDGAR filings already
 * passed the acceptance-window filter, and DJ items came from a windowed news
 * query for this conId.
 *
 * EXCEPT for `ir-page` documents (fix wave, finding A). A newsroom feed has no
 * upstream guard at all: last quarter's results announcement sits in it
 * permanently and matches the same title regex, so the loose branch would wave
 * through a months-old article and green LAST quarter's numbers as tonight's
 * print. An IR page must therefore match one of the strict expected-quarter
 * branches derived from the event date; the any-fiscal-year fallback is not
 * available to it.
 */
export function validateDocForEvent(text: string, ctx: DocGateContext): DocGateVerdict {
  const lower = text.toLowerCase();

  // Dots survive (BRK.B) but are escaped — an unescaped "." would make the
  // ticker a wildcard and match half the document.
  const symbolPattern = ctx.symbol.replace(/[^A-Za-z0-9.]/g, "").replace(/\./g, "\\.");
  const symbolRe = new RegExp(`\\b${symbolPattern}\\b`, "i");
  const symbolMatched = symbolRe.test(text);
  const needle = issuerNeedle(ctx.issuerName);
  const issuerMatched = needle !== null && lower.includes(needle);

  if (!symbolMatched && !issuerMatched) {
    return { ok: false, reason: `issuer not named (${ctx.symbol})` };
  }

  for (const { q, year } of candidateQuarters(ctx.eventDate)) {
    if (new RegExp(`\\bq${q}\\b[^\\n]{0,24}${year}`, "i").test(lower)) return { ok: true };
    if (new RegExp(`${year}[^\\n]{0,24}\\bq${q}\\b`, "i").test(lower)) return { ok: true };
    // The ordinal branch carries the same year requirement as the Qn branches
    // (review round 1, minor #6) — "second quarter" on its own appears in
    // prior-year comparatives and in last year's release just as readily.
    if (lower.includes(`${ORDINALS[q]} quarter`) && new RegExp(`\\b${year}\\b`).test(lower)) {
      return { ok: true };
    }
  }

  if (ctx.kind === "ir-page") {
    return {
      ok: false,
      reason: "IR page does not name this event's quarter (an older newsroom post?)",
    };
  }

  if (symbolMatched && FISCAL_YEAR_RE.test(lower) && QUARTER_WORD_RE.test(lower)) {
    return { ok: true };
  }

  return { ok: false, reason: "no fiscal-period token for this event" };
}

export function gateFingerprint(
  ctx: Pick<DocGateContext, "symbol" | "issuerName" | "eventDate">,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([GATE_VERSION, ctx.symbol.toUpperCase(), ctx.issuerName ?? null, ctx.eventDate]))
    .digest("hex");
}

export function contentVerdict(text: string, ctx: DocGateContext): DocGateVerdict {
  return validateDocForEvent(text, { symbol: ctx.symbol, issuerName: ctx.issuerName, eventDate: ctx.eventDate });
}

export function roadVerdict(kind: PrintWatchDocKind, text: string, ctx: DocGateContext): DocGateVerdict {
  if (kind !== "ir-page") return { ok: true };
  return validateDocForEvent(text, { symbol: ctx.symbol, issuerName: ctx.issuerName, eventDate: ctx.eventDate, kind });
}
