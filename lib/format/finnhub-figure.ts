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
    out.revenue = Number.isFinite(v) ? v : null;
  }
  return out;
}

/**
 * Render the parsed figure for human display. EPS gets dollar-scale 2dp,
 * revenue gets `formatLargeUSD` ($4.34B / $245M / $945). Returns separate
 * fields so the UI can lay them out in distinct cells. Falls back to the
 * raw input string when nothing parsed (Finnhub occasionally emits free
 * text like "Pre-announcement only").
 */
export interface FormattedFinnhubFigure {
  eps: string | null;
  revenue: string | null;
  /** Raw input when neither EPS nor Revenue parsed — surface verbatim. */
  fallback: string | null;
}

export function formatFinnhubFigure(s: string | null | undefined): FormattedFinnhubFigure {
  const parsed = parseFinnhubFigure(s);
  // Finnhub emits a literal "Rev 0" as a placeholder for "no revenue
  // consensus/actual published" — it is not a real $0 print (QA finding
  // today-earnings--zero-revenue-consensus-renders-dollar-zero). Treat it the
  // same way a genuinely absent revenue is already treated below (null
  // field). EPS of exactly 0 is a real, legitimate value and stays untouched.
  const revenue = parsed.revenue === 0 ? null : parsed.revenue;
  if (parsed.eps == null && revenue == null) {
    return {
      eps: null,
      revenue: null,
      fallback: s && s.trim() ? s.trim() : null,
    };
  }
  return {
    eps:
      parsed.eps != null
        ? `${parsed.eps < 0 ? "-" : ""}$${Math.abs(parsed.eps).toFixed(2)}`
        : null,
    revenue: revenue != null ? formatLargeUSD(revenue) : null,
    fallback: null,
  };
}

/**
 * One-liner for compact contexts (mobile, chat, briefing prose).
 *   "$0.91 · $4.34B"   when both present
 *   "$0.91"             EPS only
 *   "$4.34B"            revenue only
 *   raw input           neither parsed
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
