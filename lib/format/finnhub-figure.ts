/**
 * Parse + render Finnhub-shaped consensus / actual strings.
 *
 * Finnhub stores both consensus and actual as a single string of the form
 *   "EPS 0.70 · Rev 4305870107"
 *   "EPS 0.91"          (revenue missing)
 *   "Rev 4305870107"    (EPS missing)
 *
 * Our manual-actuals POST writes back to the same format so all readers
 * (renderHeadlineTable in the email composer, the EarningsHub on-screen
 * row, future surfaces) can rely on one parser.
 */

import { formatLargeUSD } from "@/lib/format";

export interface ParsedFinnhubFigure {
  eps: number | null;
  revenue: number | null;
}

// Word-bounded so "Revenue guidance withdrawn" (real free text) doesn't
// count as a recognizable "Rev N" token — only an exact "EPS"/"Rev" word
// does. Used by formatFinnhubFigure (below) to decide whether an
// all-null parse is free text (fall back to the raw string) or a
// recognized-but-unusable token (e.g. "Rev 0", "Rev abc" — render absent,
// never the raw token).
const EPS_TOKEN_RE = /\bEPS\b/i;
const REV_TOKEN_RE = /\bRev\b/i;

export function parseFinnhubFigure(s: string | null | undefined): ParsedFinnhubFigure {
  if (!s) return { eps: null, revenue: null };
  const out: ParsedFinnhubFigure = { eps: null, revenue: null };
  const epsMatch = /EPS\s+(-?\d+(?:\.\d+)?)/i.exec(s);
  if (epsMatch) {
    const v = Number(epsMatch[1]);
    out.eps = Number.isFinite(v) ? v : null;
  }
  const revMatch = /Rev\s+([\d.,]+)/i.exec(s);
  if (revMatch) {
    const v = Number(revMatch[1].replace(/,/g, ""));
    // Finnhub emits a literal "Rev 0" as its placeholder for "no revenue
    // figure published" for this print — it is not a real $0 print (QA
    // finding today-earnings--zero-revenue-consensus-renders-dollar-zero).
    // A $0 revenue line carries no information an absent one does not, so
    // the placeholder is nulled out HERE, at the parse layer, rather than
    // only at display time — every analytics consumer (print-watch
    // worksheet bogeys, the earnings email scoreboard, the cockpit stage
    // machine, reporter read-throughs) reads through this function and
    // must agree with what the screen shows. EPS of exactly 0 is a real,
    // legitimate print (a company can genuinely report break-even EPS) and
    // is never nulled.
    out.revenue = Number.isFinite(v) && v !== 0 ? v : null;
  }
  return out;
}

/**
 * Render the parsed figure for human display. EPS gets dollar-scale 2dp,
 * revenue gets `formatLargeUSD` ($4.34B / $245M / $945). Returns separate
 * fields so the UI can lay them out in distinct cells.
 *
 * Falls back to the raw input string ONLY when the input carries no
 * recognizable "EPS"/"Rev" token at all — genuine Finnhub free text like
 * "Pre-announcement only". When a recognizable token parsed to nothing
 * usable (e.g. "Rev 0" — the placeholder nulled above, or "Rev abc" — an
 * unparseable number), every field comes back null so the caller renders
 * its own absent marker; the raw token itself must never reach a screen or
 * email (CLAUDE.md: never render a raw Finnhub token).
 */
export interface FormattedFinnhubFigure {
  eps: string | null;
  revenue: string | null;
  /** Raw input when NO recognizable EPS/Rev token was present at all. */
  fallback: string | null;
}

export function formatFinnhubFigure(s: string | null | undefined): FormattedFinnhubFigure {
  const parsed = parseFinnhubFigure(s);
  if (parsed.eps == null && parsed.revenue == null) {
    const hasRecognizedToken = !!s && (EPS_TOKEN_RE.test(s) || REV_TOKEN_RE.test(s));
    return {
      eps: null,
      revenue: null,
      fallback: !hasRecognizedToken && s && s.trim() ? s.trim() : null,
    };
  }
  return {
    eps:
      parsed.eps != null
        ? `${parsed.eps < 0 ? "-" : ""}$${Math.abs(parsed.eps).toFixed(2)}`
        : null,
    revenue: parsed.revenue != null ? formatLargeUSD(parsed.revenue) : null,
    fallback: null,
  };
}

/**
 * One-liner for compact contexts (mobile, chat, briefing prose).
 *   "$0.91 · $4.34B"   when both present
 *   "$0.91"             EPS only
 *   "$4.34B"            revenue only
 *   raw input           free text, no recognizable EPS/Rev token
 *   ""                  a recognizable token parsed to nothing usable
 *                       (e.g. "Rev 0" placeholder, "Rev abc") — every
 *                       caller must treat an empty string as absent, the
 *                       same as a null field, never render it verbatim.
 */
export function formatFinnhubFigureCompact(s: string | null | undefined): string {
  const f = formatFinnhubFigure(s);
  if (f.fallback) return f.fallback;
  const parts = [f.eps, f.revenue].filter((v): v is string => !!v);
  return parts.join(" · ");
}

/**
 * Merge a manual actuals override into an existing Finnhub-shaped
 * `actual_value` string. Fields the caller doesn't provide (null/undefined)
 * KEEP their stored value — pre-fix, `POST /api/earnings/actuals` rebuilt
 * the whole string from the request body, so saving only EPS silently wiped
 * a previously-captured revenue (audit B18). Returns null when neither
 * field survives the merge (caller should 400).
 *
 * A stored "Rev 0" placeholder parses to a null existing.revenue (see
 * parseFinnhubFigure above) and is therefore DROPPED rather than carried
 * forward when the caller updates only EPS — desirable: the placeholder
 * never carried real information, so there is nothing worth preserving.
 */
export function mergeFinnhubActual(
  existingRaw: string | null | undefined,
  updates: { eps?: number | null; revenue?: number | null }
): string | null {
  const existing = parseFinnhubFigure(existingRaw);
  const eps = updates.eps ?? existing.eps;
  const revenue = updates.revenue ?? existing.revenue;
  const parts: string[] = [];
  if (eps != null && Number.isFinite(eps)) parts.push(`EPS ${eps.toFixed(2)}`);
  if (revenue != null && Number.isFinite(revenue)) parts.push(`Rev ${Math.round(revenue)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
