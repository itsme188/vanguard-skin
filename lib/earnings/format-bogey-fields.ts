import { formatLargeUSD } from "@/lib/format";

/**
 * Field-list formatting for an earnings bogey card (Today → Earnings Hub →
 * "Existing bogeys" in BogeysEditModal).
 *
 * QA finding today-earningshub-bogeys--stray-leading-separator-no-eps-consensus:
 * the card used to glue the "·" separator onto the FRONT of each optional
 * field ("· rev $1.44B"), so a bogey with no EPS consensus opened with a
 * dangling bullet, and on narrow viewports — where the Tailwind `space-x-2`
 * margin that supplied the only leading space collapsed — it rendered
 * "EPS 1.55· whisper".
 *
 * The separator is a JOIN concern, not a per-field prefix: build the list of
 * PRESENT fields, then join. A separator can then only ever land between two
 * fields that both rendered.
 *
 * Pure + zero UI imports so it is directly unit-testable (this repo has no
 * React rendering harness).
 */

/** Minimal shape needed off an `EarningsBogey` row. Kept structural so both
 *  the DB row type and any preview/draft object satisfies it. */
export interface BogeyFieldSource {
  eps_consensus: number | null;
  eps_whisper: number | null;
  revenue_consensus_usd: number | null;
  revenue_whisper_usd: number | null;
  /** Absolute percent (±6% → 6). */
  expected_move_pct: number | null;
}

/** The one separator string. Exported so the render site can never re-invent
 *  a glued variant. */
export const BOGEY_FIELD_SEPARATOR = " · ";

/** True only for a real, finite number — 0 is a PRESENT value (a genuine
 *  $0.00 consensus must render), NULL/undefined/NaN are absent. */
function present(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * The bogey's figures, in display order, with absent fields dropped.
 * Never returns an entry containing a separator.
 */
export function formatBogeyFields(b: BogeyFieldSource): string[] {
  const fields: string[] = [];
  if (present(b.eps_consensus)) fields.push(`EPS ${b.eps_consensus.toFixed(2)}`);
  if (present(b.eps_whisper)) fields.push(`whisper ${b.eps_whisper.toFixed(2)}`);
  if (present(b.revenue_consensus_usd)) {
    fields.push(`rev ${formatLargeUSD(b.revenue_consensus_usd)}`);
  }
  if (present(b.revenue_whisper_usd)) {
    fields.push(`rev whisper ${formatLargeUSD(b.revenue_whisper_usd)}`);
  }
  if (present(b.expected_move_pct)) {
    fields.push(`move ±${b.expected_move_pct.toFixed(1)}%`);
  }
  return fields;
}

/** The single rendered line — "" when the bogey carries no figures at all, so
 *  the caller can skip the row entirely rather than render an empty strip. */
export function formatBogeyFieldLine(b: BogeyFieldSource): string {
  return formatBogeyFields(b).join(BOGEY_FIELD_SEPARATOR);
}
