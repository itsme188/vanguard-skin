/**
 * The armed-events projection: the ONLY thing the Cloudflare Worker ever
 * learns about armed earnings worksheets (live print v2, slice A §4.1).
 *
 * The Mac stays the source of truth. Every mutation that changes which events
 * are armed — or changes an armed event's shape — writes one `cloud_outbox`
 * row carrying the FULL current list plus tombstones (never a diff), and a
 * drain posts those rows to the Worker in generation order. Deviation D2: the
 * Mac never touches KV directly, it POSTs to the Worker's internal endpoint.
 *
 * Full-list-plus-tombstones (rather than a delta) is what makes a dropped or
 * replayed row harmless: the Worker applies the newest generation it has seen
 * and ignores anything older, so it converges on the Mac's state no matter how
 * many rows it missed.
 */
import type Database from "better-sqlite3";
import { addDays } from "@/lib/calendar/date-utils";

export const ARMED_EVENTS_KIND = "armed-events";

/**
 * [R23] LIVE entries are limited to a 14-day lookback: an armed event whose
 * event_date is older than today - LIVE_LOOKBACK_DAYS drops out of the
 * projection entirely. It is NOT tombstoned — nothing in the Worker selects a
 * 15-day-old event, and a tombstone would only be re-carried for two more days
 * for nothing. This is what stops the payload growing without bound as
 * never-disarmed worksheets accumulate.
 */
const LIVE_LOOKBACK_DAYS = 14;
/** Tombstones are carried while event_date >= today - TOMBSTONE_LOOKBACK_DAYS (D7). */
const TOMBSTONE_LOOKBACK_DAYS = 2;
/** ...and, independently, while the removal itself is younger than this (D7). */
const TOMBSTONE_RETENTION_MS = 48 * 3_600_000;

export interface ArmedEventProjection {
  eventId: number;
  symbol: string;
  eventDate: string;
  eventTime: string | null;
  releaseTime: string | null;
  sourceKey: string;
  source: string;
  consensusValue: string | null;
  expectedImpact: string | null;
  securityId: number | null;
  /** Vendor EPS from the event's 'finnhub' bogey row, basis unspecified (D1). */
  epsConsensusVendor: number | null;
  removed?: true;
  /** ISO instant the tombstone was first written (D7 48-hour retention). */
  removedAt?: string;
}

export interface ArmedEventsPayload {
  generation: number;
  entries: ArmedEventProjection[];
}

/** The exact key set the projection may carry — asserted by the data-flow
 *  contract test and used by the Worker's strict parser. */
export const ARMED_EVENT_PROJECTION_KEYS = [
  "eventId",
  "symbol",
  "eventDate",
  "eventTime",
  "releaseTime",
  "sourceKey",
  "source",
  "consensusValue",
  "expectedImpact",
  "securityId",
  "epsConsensusVendor",
  "removed",
  "removedAt",
] as const;

interface ArmedRow {
  eventId: number;
  symbol: string;
  eventDate: string;
  eventTime: string | null;
  releaseTime: string | null;
  sourceKey: string;
  source: string;
  consensusValue: string | null;
  expectedImpact: string | null;
  securityId: number | null;
  epsConsensusVendor: number | null;
}

/** MAX(generation) of kind 'armed-events' in cloud_outbox, 0 when none. */
export function readArmedGeneration(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(generation), 0) AS g FROM cloud_outbox WHERE kind = ?`)
    .get(ARMED_EVENTS_KIND) as { g: number };
  return row.g;
}

/** Entries of the newest 'armed-events' payload — the tombstone carry-forward
 *  source. A payload that fails to parse is treated as "no previous state"
 *  rather than throwing: a corrupt row must never wedge every future arm. */
export function readPreviousArmedEntries(db: Database.Database): ArmedEventProjection[] {
  const row = db
    .prepare(
      `SELECT payload_json FROM cloud_outbox WHERE kind = ? ORDER BY generation DESC LIMIT 1`,
    )
    .get(ARMED_EVENTS_KIND) as { payload_json: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.payload_json) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? (parsed.entries as ArmedEventProjection[]) : [];
  } catch {
    return [];
  }
}

/**
 * Full current armed list (+ tombstones carried from the previous payload, D7).
 * Pure read — no writes, safe to call outside a transaction.
 *
 * [R23] Live entries are limited to a 14-day lookback (`event_date >= today -
 * 14`). An armed event that ages past that horizon simply leaves the list; it
 * is deliberately NOT tombstoned, because a tombstone is a statement that the
 * event is no longer armed and this one still is. The sweep-tick reconcile
 * (R8) mints the first post-horizon generation naturally — the entries differ.
 *
 * D7 retention: a tombstone survives while its event is still recent
 * (event_date >= today - 2 ET days) OR while the removal itself is younger
 * than 48 hours. Both rules matter — a disarm the evening before a print must
 * reach a Worker that has been offline all day, and a removal of a
 * long-past event must still be published once.
 */
export function buildArmedEventsEntries(
  db: Database.Database,
  opts: { today: string; nowMs?: number },
): ArmedEventProjection[] {
  const nowMs = opts.nowMs ?? Date.now();
  const armed = db
    .prepare(
      `SELECT f.event_id AS eventId, ce.symbol, ce.event_date AS eventDate, ce.event_time AS eventTime,
              ce.release_time AS releaseTime, ce.source_key AS sourceKey, ce.source, ce.consensus_value AS consensusValue,
              ce.expected_impact AS expectedImpact, ce.security_id AS securityId,
              (SELECT b.eps_consensus_vendor FROM earnings_bogeys b
                WHERE b.event_id = ce.id AND b.source = 'finnhub' ORDER BY b.id LIMIT 1) AS epsConsensusVendor
         FROM earnings_worksheet_flags f
         JOIN calendar_events ce ON ce.id = f.event_id
        WHERE ce.event_type = 'earnings' AND ce.symbol IS NOT NULL AND COALESCE(ce.superseded, 0) = 0
        ORDER BY ce.event_date, f.event_id`,
    )
    .all() as ArmedRow[];

  // [R23] Two different sets. `armedIds` is EVERY still-armed event, horizon or
  // not, and it is what suppresses a tombstone: an event that merely aged out
  // has not been removed, so publishing a removal for it would be a lie the
  // Worker would then carry for 48 hours. `live` is what actually ships.
  const armedIds = new Set(armed.map((r) => r.eventId));
  const liveCutoff = addDays(opts.today, -LIVE_LOOKBACK_DAYS);
  const live = armed.filter((r) => r.eventDate >= liveCutoff);
  const cutoff = addDays(opts.today, -TOMBSTONE_LOOKBACK_DAYS);
  const tombstones: ArmedEventProjection[] = [];
  for (const prev of readPreviousArmedEntries(db)) {
    if (armedIds.has(prev.eventId)) continue; // armed again, or aged out → not removed
    // First tombstone for this event: stamp now. Carried ones keep their stamp.
    const removedAt = prev.removedAt ?? new Date(nowMs).toISOString();
    const fresh = nowMs - Date.parse(removedAt) < TOMBSTONE_RETENTION_MS;
    if (prev.eventDate < cutoff && !fresh) continue; // aged out on BOTH rules (D7)
    tombstones.push({ ...prev, removed: true, removedAt });
  }
  return [...live.map((r) => ({ ...r })), ...tombstones];
}

/** D10: two entry lists are "the same projection" when they serialise
 *  identically ignoring `removedAt` — a carried tombstone re-stamped by a
 *  later pass is not a change the Worker needs to hear about. */
export function sameProjection(a: ArmedEventProjection[], b: ArmedEventProjection[]): boolean {
  const norm = (xs: ArmedEventProjection[]) =>
    JSON.stringify(
      xs.map(({ removedAt, ...rest }) => {
        void removedAt;
        return rest;
      }),
    );
  return norm(a) === norm(b);
}
