/**
 * Cluster-scoped manual-actuals acceptance.
 *
 * `saveManualActuals` (lib/earnings/actuals.ts) stamps
 * `calendar_events.manual_actuals_at` on ONE row — the row the user was
 * looking at. But one print carries several rows: finnhub + nasdaq (+ manual)
 * twins, of which `reconcileEarningsDates` marks all but one `superseded = 1`.
 * Which twin is canonical can change AFTER the acceptance — a late vendor
 * agreement, a date confirmation, deleting a manual row — and the stamp does
 * not move with it.
 *
 * Live defect (QA finding
 * today-week-ahead--accepted-actuals-vanish-after-superseded-twin-flip): RBRK
 * 2026-08-27 had the acceptance on the finnhub twin, then the nasdaq twin
 * became canonical carrying the SAME actual_value but no stamp. Every read
 * surface runs `actualsAreImplausible(consensus, actual, manualActualsAt)`,
 * which only bypasses the scrape guard on the RENDERED row's own stamp — so a
 * print the desk had deliberately accepted rendered as nothing at all: no
 * figure, no warning glyph, no explanation.
 *
 * An acceptance is a statement about the PRINT (issuer family + event date +
 * the accepted figure), not about whichever row happened to be canonical when
 * the user clicked save. This module resolves the stamp at READ time across
 * the whole twin cluster, so already-stranded acceptances heal without a
 * live-DB data repair.
 *
 * The figure is part of the key ON PURPOSE. If the canonical twin carries a
 * DIFFERENT actual_value than the accepted one, the user never vouched for
 * the number on screen and the scrape guard must still apply — the guard is
 * never weakened, only pointed at the right row.
 *
 * Cluster key: `issuerSiblings(symbol)` × exact `event_date` × `actual_value`,
 * `event_type = 'earnings'`. The family key matches
 * lib/calendar/reconcile-earnings-dates.ts (the pass that CREATES the twins);
 * `lib/queries/bogey-event-match.ts` keys on the bare uppercase symbol
 * instead, but that map answers a different question ("which live row does
 * this uploaded sheet attach to"), and it also filters superseded rows out —
 * here the stamp usually lives ON the superseded row, so this lookup
 * deliberately reads across both. Proximity clustering (reconcile's ±14 days)
 * is deliberately NOT used: an acceptance names one print date.
 */
import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";

/** The fields this lookup needs — every calendar_events read shape has them. */
export interface ClusterActualsRow {
  symbol?: string | null;
  event_date?: string | null;
  event_type?: string | null;
  actual_value?: string | null;
  manual_actuals_at?: string | null;
  /**
   * The vendor figure kept beside a hand-entered actual (migration 096).
   * Healed only on a read shape that selected the column (see
   * {@link applyClusterManualActuals}).
   */
  vendor_actual_value?: string | null;
}

interface StampRow {
  sym: string;
  event_date: string;
  actual_value: string;
  stamp: string;
  vendor: string | null;
}

const SEP = "\u0000";

function keyOf(symbol: string, eventDate: string, actual: string): string {
  return `${symbol.toUpperCase()}${SEP}${eventDate}${SEP}${actual}`;
}

/** A row has a usable cluster key (issuer family × event date × figure). */
function hasClusterKey(row: ClusterActualsRow): boolean {
  return (
    (row.event_type == null || row.event_type === "earnings") &&
    !!row.actual_value &&
    !!row.symbol &&
    !!row.event_date
  );
}

/** A row only needs healing when it shows an actual it has no stamp for. */
function needsCluster(row: ClusterActualsRow): boolean {
  return !row.manual_actuals_at && hasClusterKey(row);
}

/**
 * A row can borrow the print's kept vendor figure when its read shape carries
 * the column and its own is empty. A shape that never selected the column is
 * left without one.
 */
function lacksKeptVendorFigure(row: ClusterActualsRow): boolean {
  return "vendor_actual_value" in row && !row.vendor_actual_value && hasClusterKey(row);
}

/**
 * Resolve the manual-acceptance stamp for a set of rows IN PLACE, rewriting
 * `manual_actuals_at` to the cluster-wide value where the row's own is NULL.
 * Rows that already carry a stamp, carry no actual, or are not earnings are
 * untouched (a NULL stays NULL — never becomes undefined).
 *
 * The kept vendor figure (`vendor_actual_value`, migration 096) is resolved
 * the same way and under the same key: a row that reads as hand-entered (its
 * own stamp or the cluster's) and keeps no vendor figure of its own reads the
 * one kept by a stamped twin showing the SAME figure (the latest-stamped twin
 * that kept one). The recap scoreboard's vendor footnote therefore does not
 * depend on which twin of the print is read, on the Mac or in the nightly
 * snapshot the Worker reads. The row's own kept figure always wins, and only
 * a read shape that selected the column is given a value.
 *
 * One query per call regardless of row count.
 */
export function applyClusterManualActuals<T extends ClusterActualsRow>(
  db: Database.Database,
  rows: T[],
): T[] {
  const candidates = rows.filter((r) => needsCluster(r) || lacksKeptVendorFigure(r));
  if (candidates.length === 0) return rows;

  const dates = Array.from(new Set(candidates.map((r) => r.event_date as string)));
  const placeholders = dates.map(() => "?").join(",");
  const stamped = db
    .prepare(
      `SELECT UPPER(symbol) AS sym, event_date, actual_value,
              manual_actuals_at AS stamp, vendor_actual_value AS vendor
         FROM calendar_events
        WHERE event_type = 'earnings'
          AND manual_actuals_at IS NOT NULL
          AND actual_value IS NOT NULL
          AND symbol IS NOT NULL
          AND event_date IN (${placeholders})
        ORDER BY manual_actuals_at ASC, id ASC`,
    )
    .all(...dates) as StampRow[];
  if (stamped.length === 0) return rows;

  // Oldest stamp first, so the last write per key is the latest stamp, and
  // the kept vendor figure is the one from the latest-stamped twin that has one.
  const byKey = new Map<string, string>();
  const vendorByKey = new Map<string, { stamp: string; vendor: string }>();
  for (const s of stamped) {
    const key = keyOf(s.sym, s.event_date, s.actual_value);
    byKey.set(key, s.stamp);
    if (s.vendor) vendorByKey.set(key, { stamp: s.stamp, vendor: s.vendor });
  }

  for (const row of candidates) {
    let best: string | null = null;
    let kept: { stamp: string; vendor: string } | null = null;
    for (const sibling of issuerSiblings(row.symbol as string)) {
      const key = keyOf(sibling, row.event_date as string, row.actual_value as string);
      const hit = byKey.get(key);
      if (hit != null && (best == null || hit > best)) best = hit;
      const v = vendorByKey.get(key);
      if (v != null && (kept == null || v.stamp > kept.stamp)) kept = v;
    }
    if (best != null && !row.manual_actuals_at) row.manual_actuals_at = best;
    // Only beside a figure that reads as hand-entered, and never over the
    // row's own kept figure.
    if (kept != null && row.manual_actuals_at && lacksKeptVendorFigure(row)) {
      row.vendor_actual_value = kept.vendor;
    }
  }
  return rows;
}

/**
 * Single-row form of {@link applyClusterManualActuals} — returns the stamp the
 * row should be read with (its own when set, otherwise the cluster's, else
 * null). Does not mutate.
 */
export function clusterManualActualsAt(
  db: Database.Database,
  row: ClusterActualsRow,
): string | null {
  if (row.manual_actuals_at) return row.manual_actuals_at;
  const probe: ClusterActualsRow = { ...row };
  applyClusterManualActuals(db, [probe]);
  return probe.manual_actuals_at ?? null;
}

/**
 * Convenience for the many `SELECT * FROM calendar_events WHERE id = ?`
 * fetches that feed a plausibility decision: heals the row's stamp in place
 * and passes it (or null/undefined) straight through.
 */
export function withClusterManualActuals<T extends ClusterActualsRow>(
  db: Database.Database,
  row: T | null | undefined,
): T | null {
  if (!row) return null;
  applyClusterManualActuals(db, [row]);
  return row;
}

/**
 * Every event id in the print's twin cluster that currently carries a
 * manual-acceptance stamp of its own — the WRITE side of
 * {@link clusterManualActualsAt}. `clearManualActuals` (lib/earnings/actuals.ts)
 * uses this so "Clear" undoes the acceptance wherever it lives (the
 * addressed row, a superseded twin, or both) instead of leaving a stamp
 * stranded on a sibling twin that carries the same accepted figure — which
 * would just heal itself back into view on the next read.
 *
 * Same cluster key as the read side: `issuerSiblings(symbol)` × exact
 * `event_date` × `actual_value`, `event_type = 'earnings'`. Returns an empty
 * array (never throws) when the row has no usable cluster key — the caller
 * is expected to fall back to clearing the addressed row's own id in that
 * case.
 */
export function clusterStampedEventIds(
  db: Database.Database,
  row: ClusterActualsRow & { id: number },
): number[] {
  if (!hasClusterKey(row)) return [];
  const siblings = issuerSiblings(row.symbol as string).map((s) => s.toUpperCase());
  const placeholders = siblings.map(() => "?").join(",");
  const found = db
    .prepare(
      `SELECT id FROM calendar_events
        WHERE event_type = 'earnings'
          AND UPPER(symbol) IN (${placeholders})
          AND event_date = ?
          AND actual_value = ?
          AND manual_actuals_at IS NOT NULL`,
    )
    .all(...siblings, row.event_date as string, row.actual_value as string) as {
    id: number;
  }[];
  return found.map((r) => r.id);
}
