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
  if (parsed.eps == null && parsed.revenue == null) {
    return {
      eps: null,
      revenue: null,
      fallback: s && s.trim() ? s.trim() : null,
    };
  }
  return {
    eps: parsed.eps != null ? `$${parsed.eps.toFixed(2)}` : null,
    revenue: parsed.revenue != null ? formatLargeUSD(parsed.revenue) : null,
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
