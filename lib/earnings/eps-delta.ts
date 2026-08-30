import { formatFinnhubFigure } from "@/lib/format/finnhub-figure";

/**
 * Compute beat/miss percent off EPS only — matches what users naturally
 * read off an earnings line. Returns formatted string + a sign hint for
 * coloring. null when either side missing.
 *
 * Moved unchanged from app/dashboard/today/EarningsHub.tsx so WeekAheadView's
 * "actual …" chip can share the same beat/miss logic (QA finding
 * today-week-ahead--actual-chip-always-green-miss-reads-as-beat-regression-3)
 * instead of forking it.
 */
export function epsDelta(
  consensus: string | null,
  actual: string | null,
): { label: string; sign: 1 | -1 | 0 } | null {
  const cons = formatFinnhubFigure(consensus);
  const act = formatFinnhubFigure(actual);
  if (!cons.eps || !act.eps) return null;
  // formatFinnhubFigure returns "$0.91"-style — strip $ to get number
  const c = Number(cons.eps.replace(/[$,]/g, ""));
  const a = Number(act.eps.replace(/[$,]/g, ""));
  if (!Number.isFinite(c) || !Number.isFinite(a) || c === 0) return null;
  const pct = ((a - c) / Math.abs(c)) * 100;
  const sign: 1 | -1 | 0 = Math.abs(pct) < 0.05 ? 0 : pct > 0 ? 1 : -1;
  if (sign === 0) return { label: "in-line", sign };
  return { label: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`, sign };
}

export function deltaToneClass(delta: { sign: 1 | -1 | 0 } | null): string {
  if (delta == null) return "text-ink-faint";
  if (delta.sign === 1) return "text-up";
  if (delta.sign === -1) return "text-down";
  return "text-ink-dim";
}
