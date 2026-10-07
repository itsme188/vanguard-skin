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
export const LIVE_LOOKBACK_DAYS = 14;
/** Worker top-level id-list cap; parity-pinned to workers/cron/src/armed-events.ts. */
export const ARMED_EVENTS_MAX_ID_LIST = 2000;
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
  supersededEventIds: number[];
  removedEventIds: RemovedEventId[];
}

export interface RemovedEventId {
  id: number;
  eventDate: string;
  /** ISO instant the deletion was first written. */
  removedAt: string;
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

/** Superseded ids from the newest payload. Older two-key payloads read as []. */
export function readPreviousSupersededEventIds(db: Database.Database): number[] {
  const row = db
    .prepare(
      `SELECT payload_json FROM cloud_outbox WHERE kind = ? ORDER BY generation DESC LIMIT 1`,
    )
    .get(ARMED_EVENTS_KIND) as { payload_json: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.payload_json) as { supersededEventIds?: unknown };
    return Array.isArray(parsed.supersededEventIds)
      ? parsed.supersededEventIds.filter((id): id is number => Number.isInteger(id))
      : [];
  } catch {
    return [];
  }
}

/** Deleted earnings ids from the newest payload. Older payloads read as []. */
export function readPreviousRemovedEventIds(db: Database.Database): RemovedEventId[] {
  const row = db
    .prepare(
      `SELECT payload_json FROM cloud_outbox WHERE kind = ? ORDER BY generation DESC LIMIT 1`,
    )
    .get(ARMED_EVENTS_KIND) as { payload_json: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.payload_json) as { removedEventIds?: unknown };
    return Array.isArray(parsed.removedEventIds)
      ? parsed.removedEventIds.filter((item): item is RemovedEventId => {
          const r = item as Partial<RemovedEventId>;
          return (
            Number.isInteger(r.id) &&
            typeof r.eventDate === "string" &&
            typeof r.removedAt === "string"
          );
        })
      : [];
  } catch {
    return [];
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days between two YYYY-MM-DD dates, sign dropped. An unreadable date
 *  ranks last (it can never be a row the cloud is about to act on). */
function dayDistance(a: string, b: string): number {
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.abs(ms) / 86_400_000 : Number.POSITIVE_INFINITY;
}

/**
 * Keep at most ARMED_EVENTS_MAX_ID_LIST rows, the ones NEAREST today first.
 * The Worker only ever acts on prints around today, so when the list is over
 * the cap a far-future id is the one to lose — keeping the latest calendar
 * dates would let next quarter's rows crowd out yesterday's. Ties go to the
 * later date, then the higher id, so the cut is deterministic.
 */
function capNearestToToday<T extends { id: number; eventDate: string }>(
  list: T[],
  today: string,
  label: string,
): T[] {
  if (list.length <= ARMED_EVENTS_MAX_ID_LIST) return list;
  const kept = [...list]
    .sort(
      (a, b) =>
        dayDistance(a.eventDate, today) - dayDistance(b.eventDate, today) ||
        b.eventDate.localeCompare(a.eventDate) ||
        b.id - a.id,
    )
    .slice(0, ARMED_EVENTS_MAX_ID_LIST);
  console.warn(`[armed-events] dropped ${list.length - kept.length} ${label} over cap`);
  return kept.sort((a, b) => a.id - b.id);
}

/**
 * Earnings rows the Worker must treat as replaced even when they are not armed.
 * The window is intentionally lower-bounded only so the payload cannot grow
 * without limit, while a future replacement still reaches the cloud.
 */
export function buildSupersededEventIds(
  db: Database.Database,
  opts: { today: string },
): number[] {
  const cutoff = addDays(opts.today, -LIVE_LOOKBACK_DAYS);
  const rows = db
    .prepare(
      `SELECT DISTINCT id, event_date AS eventDate
         FROM calendar_events
        WHERE event_type = 'earnings'
          AND COALESCE(superseded, 0) <> 0
          AND event_date >= ?
        ORDER BY id ASC`,
    )
    .all(cutoff) as Array<{ id: number; eventDate: string }>;
  return capNearestToToday(rows, opts.today, "superseded event ids").map((r) => r.id);
}

/**
 * Deleted earnings ids the Worker must suppress one-way. There is no table
 * tonight, so these are carried from the previous payload just like D7 armed
 * tombstones. `calendar_events.id` is AUTOINCREMENT, so a removed id cannot
 * later refer to a recreated row.
 */
export function buildRemovedEventIds(
  db: Database.Database,
  opts: { today: string; nowMs?: number; removedEvents?: Array<{ id: number; eventDate: string }> },
): RemovedEventId[] {
  const nowMs = opts.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const cutoff = addDays(opts.today, -LIVE_LOOKBACK_DAYS);
  const byId = new Map<number, RemovedEventId>();
  for (const prev of readPreviousRemovedEventIds(db)) {
    byId.set(prev.id, prev);
  }
  for (const removed of opts.removedEvents ?? []) {
    if (!Number.isInteger(removed.id) || removed.id <= 0) continue;
    // The Worker rejects the WHOLE payload on a date that is not YYYY-MM-DD,
    // so a malformed stored date must never reach the list.
    if (typeof removed.eventDate !== "string" || !ISO_DATE_RE.test(removed.eventDate)) continue;
    byId.set(removed.id, byId.get(removed.id) ?? { ...removed, removedAt: now });
  }
  const retained = [...byId.values()].filter((r) => {
    const fresh = nowMs - Date.parse(r.removedAt) < TOMBSTONE_RETENTION_MS;
    return r.eventDate >= cutoff || fresh;
  });
  return capNearestToToday(retained, opts.today, "removed event ids");
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

export function sameSupersededEventIds(a: number[], b: number[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function sameRemovedEventIds(a: RemovedEventId[], b: RemovedEventId[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
