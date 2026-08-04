/**
 * Earnings wire-time tracking (spec 2026-08-04): observed print times per
 * (symbol, quarter) + the per-symbol release-time resolution cascade.
 *
 * "Bounded" observation = an empty probe existed <=30 min before the first
 * sighting, so the true wire time lies in a tight interval. Unbounded
 * observations (Mac woke late) prove only "at or before first_seen_at" and
 * are excluded from calibration except the pull-down rule (an early
 * sighting is proof regardless of bounding).
 *
 * All reads tolerate missing tables (minimal test DBs) — precedent:
 * calendar_event_suppressions.
 */
import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";

export const BOUNDED_MAX_GAP_MS = 30 * 60 * 1000;
export const OBSERVATION_LOOKBACK_DAYS = 400; // ~4 quarters + slack

export interface WireObservationRow {
  id: number;
  symbol: string;
  event_date: string;
  event_id: number | null;
  first_seen_at: string; // ISO UTC
  last_empty_probe_at: string | null; // ISO UTC
  source: string;
}

export interface RecordObservationInput {
  symbol: string;
  eventDate: string;
  eventId: number | null;
  firstSeenAt: string; // ISO UTC
  lastEmptyProbeAt: string | null;
  source?: "finnhub_probe" | "web_verified" | "manual";
}

/** Insert a first sighting. Returns false on duplicate or missing table. */
export function recordWireObservation(
  db: Database.Database,
  input: RecordObservationInput,
): boolean {
  try {
    const res = db
      .prepare(
        `INSERT INTO earnings_wire_observations
           (symbol, event_date, event_id, first_seen_at, last_empty_probe_at, source)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, event_date, source) DO NOTHING`,
      )
      .run(
        input.symbol.trim().toUpperCase(),
        input.eventDate,
        input.eventId,
        input.firstSeenAt,
        input.lastEmptyProbeAt,
        input.source ?? "finnhub_probe",
      );
    return res.changes > 0;
  } catch {
    return false;
  }
}

export function isBoundedObservation(
  firstSeenAt: string,
  lastEmptyProbeAt: string | null,
): boolean {
  if (!lastEmptyProbeAt) return false;
  const seen = Date.parse(firstSeenAt);
  const empty = Date.parse(lastEmptyProbeAt);
  if (!Number.isFinite(seen) || !Number.isFinite(empty)) return false;
  const gap = seen - empty;
  return gap >= 0 && gap <= BOUNDED_MAX_GAP_MS;
}

/** Stamp the latest came-up-empty probe instant on the event row. */
export function stampEmptyProbe(
  db: Database.Database,
  eventId: number,
  at: Date,
): void {
  try {
    db.prepare(
      `UPDATE calendar_events SET wire_probe_empty_at = ? WHERE id = ?`,
    ).run(at.toISOString(), eventId);
  } catch {
    // column absent in a minimal test DB — observation stays unbounded
  }
}

/** All observations for the symbol's issuer family since sinceDate. */
export function getObservationsForFamily(
  db: Database.Database,
  symbol: string,
  sinceDate: string,
): WireObservationRow[] {
  try {
    const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
    const ph = family.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, symbol, event_date, event_id, first_seen_at, last_empty_probe_at, source
         FROM earnings_wire_observations
         WHERE symbol IN (${ph}) AND event_date >= ?
         ORDER BY event_date DESC`,
      )
      .all(...family, sinceDate) as WireObservationRow[];
  } catch {
    return [];
  }
}
