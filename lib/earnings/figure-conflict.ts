/**
 * Chip-and-hold (theme T1, slice 1; owner-delegated ruling 2026-11-01 item 1).
 *
 * When the accepted (verified, promoted) 8-K figure and the vendor feed
 * disagree by more than CONFLICT_THRESHOLD, the print raises a conflict chip
 * and the AUTO-recap is held. The filing is still the number; this only keeps
 * an accepted figure from going straight into a sent recap while the override
 * is unbuilt. The hold lifts when a human sends the recap (the "Send recap
 * now" nudge or the manual send route are never held) or when the figures stop
 * disagreeing (Save actuals / Clear actuals).
 *
 * THE ONE COMPARISON POINT: a promoted event row carries both figures —
 * `actual_value` (stamped by `manual_actuals_at`, the accepted figure) and
 * `vendor_actual_value` (the vendor figure kept at promote or by a later
 * enrichment, migration 096). `getEventById` heals both across the print's
 * twin cluster. Nothing here is stored: the state is derived on every read,
 * so it cannot go stale and needs no schema.
 *
 * FORMULA (pinned by tests/earnings/figure-conflict.test.ts):
 *
 *     disagreement = |accepted − vendor| / max(|accepted|, floor)
 *
 *   - Relative to the ACCEPTED figure, because the filing is the number.
 *   - `floor` keeps a break-even or tiny accepted figure from dividing by
 *     (near) zero: EPS_FLOOR = $0.25 per share, REVENUE_FLOOR = $1,000,000.
 *     Accepted 0.00 vs vendor 0.01 is 4% (a conflict); accepted 0.00 vs vendor
 *     0.00 is 0 (clear). Below the floor the test is effectively an absolute
 *     tolerance of THRESHOLD × floor (half a cent of EPS, $20,000 of revenue).
 *   - Signs need no special case: |−0.10 − 0.10| over max(0.10, 0.25) is 80%.
 *     Negative accepted figures use their magnitude as the base.
 *   - A conflict is STRICTLY GREATER than the threshold; the ratio is rounded
 *     to 6 decimals first so 1.00 vs 1.02 (a float difference of
 *     0.020000000000000018) reads as exactly 2%, not over.
 *   - Only metrics present on BOTH sides are compared. A missing metric is not
 *     a disagreement; if nothing overlaps there is nothing to compare.
 *
 * FAIL-SAFE: `getRecapHold` answers `unchecked` (held) when the check itself
 * throws, so a print whose figures were never compared is never treated as
 * clear. An event with no stamp has no accepted figure to compare (its
 * `actual_value` IS the vendor's), and a stamped event with no kept vendor
 * figure has nothing to disagree with: both are clear, as today.
 *
 * PURE READ: GET routes and server components call this; nothing here writes.
 */
import type Database from "better-sqlite3";
import { parseFinnhubFigure, formatRevenueUSD } from "@/lib/format/finnhub-figure";
import { getEventById } from "@/lib/queries/calendar";

/** Disagreement strictly above this fraction raises the chip and holds the auto-recap. */
export const CONFLICT_THRESHOLD = 0.02;
/** Smallest EPS (dollars per share) used as the base, so a ~zero accepted EPS cannot divide by zero. */
export const EPS_FLOOR = 0.25;
/** Smallest revenue (dollars) used as the base. */
export const REVENUE_FLOOR = 1_000_000;

export type ConflictMetric = "EPS" | "Revenue";

export interface MetricConflict {
  metric: ConflictMetric;
  accepted: number;
  vendor: number;
  /** The rounded disagreement ratio (0.05 = 5%). */
  disagreement: number;
}

/** The ratio, rounded to 6 places so the boundary is exact. */
export function disagreementRatio(accepted: number, vendor: number, floor: number): number {
  const base = Math.max(Math.abs(accepted), floor);
  return Math.round((Math.abs(accepted - vendor) / base) * 1e6) / 1e6;
}

/** Strictly over the threshold. */
export function exceedsThreshold(ratio: number): boolean {
  return ratio > CONFLICT_THRESHOLD;
}

export interface FigurePair {
  /** The accepted figure's stored string; counts only when `manualActualsAt` is set. */
  actualValue: string | null | undefined;
  manualActualsAt: string | null | undefined;
  vendorActualValue: string | null | undefined;
}

/** Metrics whose accepted and vendor figures disagree past the threshold (empty = clear). */
export function findMetricConflicts(pair: FigurePair): MetricConflict[] {
  if (!pair.manualActualsAt || !pair.actualValue || !pair.vendorActualValue) return [];
  const accepted = parseFinnhubFigure(pair.actualValue);
  const vendor = parseFinnhubFigure(pair.vendorActualValue);
  const out: MetricConflict[] = [];
  if (accepted.eps != null && vendor.eps != null) {
    const ratio = disagreementRatio(accepted.eps, vendor.eps, EPS_FLOOR);
    if (exceedsThreshold(ratio)) {
      out.push({ metric: "EPS", accepted: accepted.eps, vendor: vendor.eps, disagreement: ratio });
    }
  }
  if (accepted.revenue != null && vendor.revenue != null) {
    const ratio = disagreementRatio(accepted.revenue, vendor.revenue, REVENUE_FLOOR);
    if (exceedsThreshold(ratio)) {
      out.push({
        metric: "Revenue",
        accepted: accepted.revenue,
        vendor: vendor.revenue,
        disagreement: ratio,
      });
    }
  }
  return out;
}

export type RecapHold =
  | { held: false }
  | { held: true; kind: "conflict"; conflicts: MetricConflict[]; reason: string }
  | { held: true; kind: "unchecked"; reason: string };

const fmtEps = (n: number) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const fmtMetric = (metric: ConflictMetric, n: number) =>
  metric === "EPS" ? fmtEps(n) : formatRevenueUSD(n);
const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

/** One line per metric: both figures, each with its source. Public market data. */
export function describeConflicts(conflicts: MetricConflict[]): string {
  return conflicts
    .map(
      (c) =>
        `${c.metric}: filing ${fmtMetric(c.metric, c.accepted)} vs vendor ${fmtMetric(c.metric, c.vendor)} (${pct(c.disagreement)} apart)`,
    )
    .join("; ");
}

export const UNCHECKED_REASON =
  "Auto-recap held: the figure check could not run, so the accepted and vendor figures were never compared. Send the recap by hand once you have checked them.";

/** The hold for an event whose conflict list is already known (the state words live here, once). */
export function holdFromConflicts(conflicts: MetricConflict[]): RecapHold {
  if (conflicts.length === 0) return { held: false };
  return {
    held: true,
    kind: "conflict",
    conflicts,
    reason:
      `Auto-recap held: the accepted filing figure and the vendor feed disagree by more than ${pct(CONFLICT_THRESHOLD)}. ` +
      `${describeConflicts(conflicts)}. Send the recap by hand to release it, or fix the actuals.`,
  };
}

/**
 * The hold for one event. Reads the healed event row; a throw while reading or
 * comparing is held-with-reason, never clear. A missing event is clear here so
 * the send path's own refusal (event_not_found) answers it.
 */
export function getRecapHold(db: Database.Database, eventId: number): RecapHold {
  try {
    const event = getEventById(db, eventId);
    if (!event) return { held: false };
    return holdFromConflicts(
      findMetricConflicts({
        actualValue: event.actual_value,
        manualActualsAt: event.manual_actuals_at,
        vendorActualValue: event.vendor_actual_value,
      }),
    );
  } catch (err) {
    console.warn(
      `[figure-conflict] check failed for event ${eventId}:`,
      err instanceof Error ? err.message : err,
    );
    return { held: true, kind: "unchecked", reason: UNCHECKED_REASON };
  }
}

/** What a chip shows for a hold: serializable, so a server page can hand it to a client chip. */
export interface RecapHoldChipView {
  kind: "conflict" | "unchecked";
  label: string;
  /** Full sentence: both figures, each with its source, and the way out. */
  title: string;
}

/** Null when nothing is held. The label names both figures and their sources. */
export function recapHoldChipView(hold: RecapHold): RecapHoldChipView | null {
  if (!hold.held) return null;
  if (hold.kind === "unchecked") {
    return { kind: "unchecked", label: "Recap held · figures not compared", title: hold.reason };
  }
  const detail = hold.conflicts
    .map(
      (c) =>
        `${c.metric} filing ${fmtMetric(c.metric, c.accepted)} vs vendor ${fmtMetric(c.metric, c.vendor)}`,
    )
    .join(" · ");
  return { kind: "conflict", label: `Conflict · ${detail} · recap held`, title: hold.reason };
}
