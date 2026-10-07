/**
 * Armed-events resolver — the Worker's half of "armed as covered"
 * (live print v2 slice A §4.1 cloud, deviations D2 + D5).
 *
 * The problem this closes: coverage in the cloud used to mean held-or-
 * watchlist, computed from a snapshot frozen at 2am. A worksheet the user
 * armed at 9am for a name they do not own was invisible to every Worker
 * fallback, so a Mac that went to sleep before the print produced nothing.
 *
 * The fix has two halves:
 *   1. The nightly snapshot ships `armedEvents` (the full armed list at
 *      snapshot time) plus `armedGeneration` — the Mac's cloud_outbox
 *      MAX(generation) as of that read, i.e. a WATERMARK, not a count.
 *   2. Every later arm/disarm posts the full list again at a higher
 *      generation to POST /internal/armed-events, which lands in KV.
 *
 * `effectiveCalendarEvents` merges the two: the delta wins only when its
 * generation is strictly greater than the snapshot's watermark, so a snapshot
 * written AFTER a delta can never be dragged backwards by that delta's stale
 * copy.
 *
 * HORIZON (Mac-side, R23): the projection publishes LIVE entries only for
 * armed events dated within the last 14 days. An event older than that is
 * absent from the payload — and deliberately NOT tombstoned, because it is
 * still armed; it has simply aged out. Nothing here selects an event that old,
 * so the only visible effect is a payload that stops growing. Because the Mac always sends the FULL list plus tombstones (never a
 * diff), a dropped or replayed POST is harmless — the newest generation the
 * Worker holds is always a complete, self-consistent picture.
 *
 * The Mac stays the source of truth; the read-compare-write here is defence
 * in depth, not a second authority.
 *
 * NOTE ON THE IMPORT CYCLE: `issuerSiblings` lives in fallback-earnings.ts
 * (its parity-pinned home) and fallback-earnings.ts imports this module back.
 * That cycle is safe and deliberate — `issuerSiblings` is a hoisted function
 * declaration and neither module calls the other at module-evaluation time —
 * and it keeps the issuer-family table single-sourced rather than forking it.
 */
import type { ArmedEventEntry, ArmedEventsDelta, CalendarEventRow, Snapshot } from "./state";
import { issuerSiblings } from "./fallback-earnings";

export const ARMED_EVENTS_KV_KEY = "armed-events";

/**
 * The ONLY keys `parseEntry` will ever keep — the Worker half of the
 * parity-pinned data-flow contract. PARITY: this must equal the Mac's
 * `ARMED_EVENT_PROJECTION_KEYS` (lib/earnings/armed-events-projection.ts),
 * asserted by workers/cron/test/armed-events-parity.test.ts.
 *
 * The pin matters because `parseEntry` drops unlisted keys BY DESIGN: without
 * it, a field added on the Mac would be silently discarded in the cloud with
 * both suites green.
 */
export const ARMED_EVENT_ENTRY_KEYS = [
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

/** Hard caps on what one POST may carry (see applyArmedEventsDelta, [C-19]). */
export const ARMED_EVENTS_MAX_ENTRIES = 500;
export const ARMED_EVENTS_MAX_SUPERSEDED_IDS = 2000;
export const ARMED_EVENTS_MAX_REMOVED_IDS = ARMED_EVENTS_MAX_SUPERSEDED_IDS;
export const ARMED_EVENTS_MAX_BODY_BYTES = 256 * 1024;

export interface EffectiveCalendar {
  /**
   * Snapshot calendar rows in their original order, followed by any rows the
   * armed projection contributed that the snapshot did not already have.
   * Snapshot order is preserved deliberately: with no additions the consumers
   * see byte-identical input to today's, so this merge can never reorder an
   * existing cloud run.
   */
  events: CalendarEventRow[];
  armedEventIds: Set<number>;
  source: "snapshot" | "snapshot+delta" | "degraded-v10";
}

/**
 * The calendar columns the armed projection genuinely OWNS — the ones it reads
 * straight off `calendar_events` on the Mac, so its copy is authoritative and
 * may overwrite a snapshot row.
 *
 * Everything else on a snapshot row is deliberately NOT here.
 * `consensus_estimate` in particular is a different column with a different
 * lifecycle from `consensus_value` (Finnhub sync-time vs enrichment-time):
 * blanking it would kill `effectiveConsensusRaw`'s last fallback in
 * fallback-earnings, empty the `cons` column in todays-reporters, and hand a
 * null consensus to calendar-enrich's actual-fetch context. `title` matters
 * too — slot inference reads "(Before Market Open)" / "(After Market Close)"
 * out of it when `release_time` is null, which a synthesized title would lose.
 * `enriched_at` / `actual_value` / `reaction_snapshot` gate the recap roads.
 */
function projectionOwnedFields(e: ArmedEventEntry): Partial<CalendarEventRow> {
  return {
    event_date: e.eventDate,
    event_time: e.eventTime,
    release_time: e.releaseTime,
    symbol: e.symbol,
    security_id: e.securityId,
    expected_impact: e.expectedImpact,
    source: e.source,
    source_key: e.sourceKey,
    consensus_value: e.consensusValue,
  };
}

/**
 * A projection entry rendered as a WHOLE calendar row — used only when the
 * snapshot has no row for this event at all (an event armed after the 2am
 * snapshot). `title` is synthesised and `consensus_estimate` is filled from the
 * projection because a delta-only row has no other source for either; that is
 * safe precisely because there is no snapshot row to overwrite.
 *
 * Everything the Worker has no business seeing (notes, reads, callouts,
 * document text) is absent by construction.
 */
function projectionToRow(e: ArmedEventEntry): CalendarEventRow {
  return {
    id: e.eventId,
    event_type: "earnings",
    title: `${e.symbol} earnings`,
    description: null,
    consensus_estimate: e.consensusValue,
    previous_value: null,
    raw_json: null,
    superseded: 0,
    ...projectionOwnedFields(e),
  } as CalendarEventRow;
}

/**
 * The effective calendar collection + the set of armed event ids.
 *
 * A ≤v10 snapshot (or a v11 one missing its watermark) degrades to exactly
 * today's behaviour: the snapshot's own rows, nothing armed, delta ignored.
 * Never assume the delta is recent enough for a consumer's own window: the
 * Mac's horizon is 14 days wide (R23), far wider than any window here. Date
 * windowing stays each consumer's own job, applied to `events` exactly as it
 * is applied today.
 */
export function effectiveCalendarEvents(
  snapshot: Snapshot,
  delta: ArmedEventsDelta | null,
): EffectiveCalendar {
  const snapshotEvents = snapshot.calendarEvents ?? [];
  const snapshotIds = new Set(snapshotEvents.map((e) => e.id));
  const byId = new Map<number, CalendarEventRow>();
  for (const e of snapshotEvents) byId.set(e.id, e);

  if ((snapshot.schemaVersion ?? 0) < 11 || snapshot.armedGeneration == null) {
    return { events: [...byId.values()], armedEventIds: new Set(), source: "degraded-v10" };
  }

  const armed = new Set<number>();
  // Insertion-ordered ids the projection contributed on top of the snapshot.
  const added: number[] = [];
  const upsert = (e: ArmedEventEntry) => {
    const existing = byId.get(e.eventId);
    if (!existing) {
      // No row in the snapshot at all → synthesize the whole thing.
      if (!snapshotIds.has(e.eventId) && !added.includes(e.eventId)) added.push(e.eventId);
      byId.set(e.eventId, projectionToRow(e));
      return;
    }
    // A real snapshot row exists: overwrite ONLY what the projection owns and
    // leave every snapshot-only column (consensus_estimate, title, raw_json,
    // enriched_at, actual_value, superseded, ...) exactly as it was.
    byId.set(e.eventId, { ...existing, ...projectionOwnedFields(e) });
  };

  for (const e of snapshot.armedEvents ?? []) {
    // The Mac payload carries D7 tombstones alongside live rows — a tombstone
    // is a statement that the event is NOT armed, never a row to add.
    if (e.removed) continue;
    armed.add(e.eventId);
    // Same merge as the delta path: an event present in BOTH the snapshot's
    // calendar and its armed list must resolve identically either way.
    upsert(e);
  }

  let source: EffectiveCalendar["source"] = "snapshot";
  if (delta && delta.generation > snapshot.armedGeneration) {
    source = "snapshot+delta";
    for (const e of delta.entries) {
      if (e.removed) {
        armed.delete(e.eventId);
        // A delta-only event that is now disarmed leaves the collection; a
        // snapshot row stays (the calendar still knows about the print — it
        // is simply no longer armed).
        if (!snapshotIds.has(e.eventId)) {
          byId.delete(e.eventId);
          const at = added.indexOf(e.eventId);
          if (at >= 0) added.splice(at, 1);
        }
        continue;
      }
      armed.add(e.eventId);
      upsert(e);
    }
    const removedIds = (delta.removedEventIds ?? []).map((r) => r.id);
    for (const id of [...(delta.supersededEventIds ?? []), ...removedIds]) {
      const existing = byId.get(id);
      if (!existing) continue;
      byId.set(id, { ...existing, superseded: 1 });
      armed.delete(id);
    }
  }

  const events = [
    ...snapshotEvents.map((e) => byId.get(e.id) ?? e),
    ...added
      .map((id) => byId.get(id))
      .filter((e): e is CalendarEventRow => e != null)
      .sort((a, b) => a.event_date.localeCompare(b.event_date) || a.id - b.id),
  ];
  return { events, armedEventIds: armed, source };
}

/**
 * Cloud coverage for one event: armed (an event fact, per slice A) OR the
 * classic family-aware held/watchlist test. Armed is checked first and by
 * EVENT ID — arming is a property of the print, not of the symbol.
 */
export function isCoveredInCloud(
  snapshot: Snapshot,
  eff: EffectiveCalendar,
  event: { id: number; symbol: string | null },
): boolean {
  if (eff.armedEventIds.has(event.id)) return true;
  if (!event.symbol) return false;
  const held = new Set((snapshot.heldSymbols ?? []).map((s) => s.toUpperCase()));
  const watch = new Set((snapshot.watchlistSymbols ?? []).map((s) => s.toUpperCase()));
  return issuerSiblings(event.symbol).some(
    (s) => held.has(s.toUpperCase()) || watch.has(s.toUpperCase()),
  );
}

/** The stored delta, or null when absent/corrupt — a bad KV value must never
 *  throw a whole cron tick, it just means "no delta". */
export async function readArmedEventsDelta(kv: KVNamespace): Promise<ArmedEventsDelta | null> {
  const raw = await kv.get(ARMED_EVENTS_KV_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      generation?: unknown;
      entries?: unknown;
      supersededEventIds?: unknown;
      removedEventIds?: unknown;
    };
    if (typeof parsed.generation !== "number" || !Array.isArray(parsed.entries)) return null;
    const supersededEventIds =
      parsed.supersededEventIds === undefined || !Array.isArray(parsed.supersededEventIds)
        ? []
        : parsed.supersededEventIds.filter((id): id is number => Number.isInteger(id) && id > 0);
    return {
      generation: parsed.generation,
      entries: parsed.entries as ArmedEventEntry[],
      supersededEventIds,
      removedEventIds: readRemovedEventIds(parsed.removedEventIds),
    };
  } catch {
    return null;
  }
}

type ArmedEventEntryKey = (typeof ARMED_EVENT_ENTRY_KEYS)[number];

/** How one allowlisted key is read off an untrusted POST body. */
type ArmedEventFieldRule =
  /** Must be an integer, or the whole entry is rejected. */
  | { kind: "required-int" }
  /** Must be a string, or the whole entry is rejected. Truncated to `max`. */
  | { kind: "required-string"; max: number; upper?: boolean }
  /** A string truncated to `max`, else null. */
  | { kind: "nullable-string"; max: number }
  /** A finite number, else null. */
  | { kind: "nullable-number" }
  /** D7 tombstone marker: kept only when literally `true`, otherwise absent. */
  | { kind: "tombstone-flag" }
  /** Kept only on a tombstone, and only when a string. Truncated to `max`. */
  | { kind: "tombstone-string"; max: number };

/**
 * One parse rule per allowlisted key — the ONLY place a field's handling is
 * written down. `parseEntry` walks `ARMED_EVENT_ENTRY_KEYS` and looks each key
 * up here, so the parser body cannot drift from the pinned key set:
 *
 *   - the mapped type makes a key added to `ARMED_EVENT_ENTRY_KEYS` without a
 *     rule a COMPILE error (and a rule for an unlisted key likewise);
 *   - `parseEntry` throws at run time on a key with no rule, and the parity
 *     test asserts the two key sets are equal, for the suites that do not
 *     type-check.
 *
 * Before this table the body hand-listed every field, so a key added to all
 * three declared lists and forgotten here was dropped in the cloud with every
 * suite green.
 */
export const ARMED_EVENT_ENTRY_FIELDS: { readonly [K in ArmedEventEntryKey]: ArmedEventFieldRule } = {
  eventId: { kind: "required-int" },
  symbol: { kind: "required-string", max: 16, upper: true },
  eventDate: { kind: "required-string", max: 10 },
  eventTime: { kind: "nullable-string", max: 200 },
  releaseTime: { kind: "nullable-string", max: 200 },
  sourceKey: { kind: "required-string", max: 200 },
  source: { kind: "required-string", max: 32 },
  consensusValue: { kind: "nullable-string", max: 200 },
  expectedImpact: { kind: "nullable-string", max: 200 },
  securityId: { kind: "nullable-number" },
  epsConsensusVendor: { kind: "nullable-number" },
  removed: { kind: "tombstone-flag" },
  removedAt: { kind: "tombstone-string", max: 40 },
};

const isRequiredRule = (rule: ArmedEventFieldRule): boolean =>
  rule.kind === "required-int" || rule.kind === "required-string";

/**
 * [C-19] Strict, allowlisted parse — the KV value can only ever hold the
 * projection shape. Unknown keys are DROPPED rather than stored: the endpoint
 * is reachable by anything holding the cron secret, and this is the one place
 * that guarantees the Worker never persists (and so never renders) prose the
 * data-flow contract excludes.
 *
 * Driven entirely by the pinned key list and its rule table above — it names
 * no field itself.
 */
function parseEntry(raw: unknown): ArmedEventEntry {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rules: Record<string, ArmedEventFieldRule | undefined> = ARMED_EVENT_ENTRY_FIELDS;
  const out: Record<string, unknown> = {};
  const missing = (): never => {
    const required = ARMED_EVENT_ENTRY_KEYS.filter((k) => isRequiredRule(ARMED_EVENT_ENTRY_FIELDS[k]));
    throw new Error(`armed-events: entry missing ${required.join("/")}`);
  };
  // A tombstone is declared by its flag alone; the fields that ride on it are
  // kept only when that flag is literally true.
  const tombstone = ARMED_EVENT_ENTRY_KEYS.some(
    (k) => ARMED_EVENT_ENTRY_FIELDS[k].kind === "tombstone-flag" && r[k] === true,
  );
  for (const key of ARMED_EVENT_ENTRY_KEYS) {
    const rule = rules[key];
    if (!rule) throw new Error(`armed-events: no parse rule for allowlisted key "${key}"`);
    const v = r[key];
    switch (rule.kind) {
      case "required-int":
        if (!Number.isInteger(v)) missing();
        out[key] = v;
        break;
      case "required-string": {
        if (typeof v !== "string") return missing();
        const text = v.slice(0, rule.max);
        out[key] = rule.upper ? text.toUpperCase() : text;
        break;
      }
      case "nullable-string":
        out[key] = typeof v === "string" ? v.slice(0, rule.max) : null;
        break;
      case "nullable-number":
        out[key] = typeof v === "number" && Number.isFinite(v) ? v : null;
        break;
      case "tombstone-flag":
        if (v === true) out[key] = true;
        break;
      case "tombstone-string":
        if (tombstone && typeof v === "string") out[key] = v.slice(0, rule.max);
        break;
    }
  }
  // Built key by key from the allowlist, so every other key is dropped.
  return out as unknown as ArmedEventEntry;
}

function parseSupersededEventIds(raw: unknown): number[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("armed-events: supersededEventIds must be an array");
  }
  if (raw.length > ARMED_EVENTS_MAX_SUPERSEDED_IDS) {
    throw new Error(
      `armed-events: too many superseded ids (${raw.length} > ${ARMED_EVENTS_MAX_SUPERSEDED_IDS})`,
    );
  }
  const ids = raw.map((id) => {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("armed-events: supersededEventIds must contain positive integers");
    }
    return id as number;
  });
  return [...new Set(ids)].sort((a, b) => a - b);
}

function readRemovedEventIds(raw: unknown): Array<{ id: number; eventDate: string; removedAt: string }> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: Array<{ id: number; eventDate: string; removedAt: string }> = [];
  for (const item of raw) {
    const r = item as { id?: unknown; eventDate?: unknown; removedAt?: unknown };
    if (!Number.isInteger(r.id) || (r.id as number) <= 0) continue;
    if (typeof r.eventDate !== "string" || typeof r.removedAt !== "string") continue;
    if (seen.has(r.id as number)) continue;
    seen.add(r.id as number);
    out.push({
      id: r.id as number,
      eventDate: r.eventDate.slice(0, 10),
      removedAt: r.removedAt.slice(0, 40),
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

function parseRemovedEventIds(raw: unknown): Array<{ id: number; eventDate: string; removedAt: string }> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("armed-events: removedEventIds must be an array");
  }
  if (raw.length > ARMED_EVENTS_MAX_REMOVED_IDS) {
    throw new Error(
      `armed-events: too many removed ids (${raw.length} > ${ARMED_EVENTS_MAX_REMOVED_IDS})`,
    );
  }
  for (const item of raw) {
    const r = item as { id?: unknown; eventDate?: unknown; removedAt?: unknown };
    if (!Number.isInteger(r.id) || (r.id as number) <= 0) {
      throw new Error("armed-events: removedEventIds must contain positive integer ids");
    }
    if (typeof r.eventDate !== "string" || typeof r.removedAt !== "string") {
      throw new Error("armed-events: removedEventIds entries need eventDate and removedAt strings");
    }
  }
  return readRemovedEventIds(raw);
}

/**
 * Read-compare-write: applies only when `body.generation` is strictly greater
 * than the generation already stored. A replayed or out-of-order POST is a
 * no-op that reports the generation that stands.
 */
export async function applyArmedEventsDelta(
  kv: KVNamespace,
  body: unknown,
): Promise<{ applied: boolean; generation: number }> {
  const b =
    body as
      | { generation?: unknown; entries?: unknown; supersededEventIds?: unknown; removedEventIds?: unknown }
      | null;
  if (
    !b ||
    typeof b.generation !== "number" ||
    !Number.isInteger(b.generation) ||
    !Array.isArray(b.entries)
  ) {
    throw new Error("armed-events: body needs integer generation and entries[]");
  }
  if (b.entries.length > ARMED_EVENTS_MAX_ENTRIES) {
    throw new Error(
      `armed-events: too many entries (${b.entries.length} > ${ARMED_EVENTS_MAX_ENTRIES})`,
    );
  }
  const entries = b.entries.map(parseEntry);
  const supersededEventIds = parseSupersededEventIds(b.supersededEventIds);
  const removedEventIds = parseRemovedEventIds(b.removedEventIds);
  const current = await readArmedEventsDelta(kv);
  const held = current?.generation ?? 0;
  if (b.generation <= held) return { applied: false, generation: held };
  await kv.put(
    ARMED_EVENTS_KV_KEY,
    JSON.stringify({ generation: b.generation, entries, supersededEventIds, removedEventIds }),
  );
  return { applied: true, generation: b.generation };
}
