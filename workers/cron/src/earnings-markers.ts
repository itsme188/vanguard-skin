/**
 * Marker-based dedup for earnings preview/recap emails between the Mac
 * primary path and the Worker cloud fallback. Same shape as dedup.ts (the
 * briefing/digest equivalents) but keyed on (phase, eventId) instead of
 * (type, date) — eventId is globally unique across calendar_events so no
 * date scoping needed; phase disambiguates preview vs recap.
 *
 *   mac-sent-earnings-{phase}-{eventId}    — Mac route writes after audit row insert
 *   cloud-sent-earnings-{phase}-{eventId}  — Worker writes after fallback fires
 *   mac-running-earnings-{phase}-{eventId} — Mac route writes at entry, clears in finally
 *
 * Worker fallback flow:
 *   1. Read snapshot. For each earnings event in preview / recap window:
 *      a. Check earningsEmails snapshot rows — Mac may have already audited.
 *      b. Check mac-sent / cloud-sent / mac-running markers — skip if any present.
 *      c. Generate + send. Write cloud-sent.
 *
 * Mac flow:
 *   1. /api/cron/earnings-{preview,recap} entry: GET cloud-sent marker → if
 *      present, skip Mac fire, write audit row noting deferred-to-cloud, return.
 *   2. POST mac-running at start. Compose + send. Insert audit row.
 *   3. POST mac-sent. Clear mac-running.
 */

const SENT_TTL_SECONDS = 30 * 3600; // 30h
const RUNNING_TTL_SECONDS = 10 * 60; // 10 min

export type EarningsPhase = "preview" | "recap";
export type EarningsSentBy = "mac" | "cloud";

export function earningsMarkerKey(
  sentBy: EarningsSentBy,
  phase: EarningsPhase,
  eventId: number,
): string {
  return `${sentBy}-sent-earnings-${phase}-${eventId}`;
}

export function earningsRunningKey(
  phase: EarningsPhase,
  eventId: number,
): string {
  return `mac-running-earnings-${phase}-${eventId}`;
}

export interface EarningsMarkerState {
  mac: boolean;
  cloud: boolean;
  macRunning: boolean;
}

export async function readEarningsMarkers(
  kv: KVNamespace,
  phase: EarningsPhase,
  eventId: number,
): Promise<EarningsMarkerState> {
  const [mac, cloud, macRunning] = await Promise.all([
    kv.get(earningsMarkerKey("mac", phase, eventId)),
    kv.get(earningsMarkerKey("cloud", phase, eventId)),
    kv.get(earningsRunningKey(phase, eventId)),
  ]);
  return {
    mac: mac !== null,
    cloud: cloud !== null,
    macRunning: macRunning !== null,
  };
}

export async function writeEarningsMarker(
  kv: KVNamespace,
  sentBy: EarningsSentBy,
  phase: EarningsPhase,
  eventId: number,
): Promise<void> {
  await kv.put(
    earningsMarkerKey(sentBy, phase, eventId),
    new Date().toISOString(),
    { expirationTtl: SENT_TTL_SECONDS },
  );
}

export async function setEarningsRunningMarker(
  kv: KVNamespace,
  phase: EarningsPhase,
  eventId: number,
): Promise<void> {
  await kv.put(
    earningsRunningKey(phase, eventId),
    new Date().toISOString(),
    { expirationTtl: RUNNING_TTL_SECONDS },
  );
}

export async function clearEarningsRunningMarker(
  kv: KVNamespace,
  phase: EarningsPhase,
  eventId: number,
): Promise<void> {
  await kv.delete(earningsRunningKey(phase, eventId));
}

/**
 * Worker → Mac status check, used by the Mac route to decide whether
 * to skip its primary fire because Worker fallback already delivered.
 */
export async function getEarningsMarkerStatus(
  kv: KVNamespace,
  phase: EarningsPhase,
  eventId: number,
): Promise<{ sentBy: EarningsSentBy | null }> {
  const { mac, cloud } = await readEarningsMarkers(kv, phase, eventId);
  if (cloud) return { sentBy: "cloud" };
  if (mac) return { sentBy: "mac" };
  return { sentBy: null };
}

/**
 * Push-at-print dedup marker (Wave 1 §2). Keyed on eventId only (no phase —
 * the print push fires once per event the moment an actual is captured,
 * regardless of which side — Mac enrichment, Mac reconcile, or Worker
 * cloud-enrich — got there first). 7-day TTL: this marker must outlive the
 * cloud-enriched payload's own TTL, else a Mac that wakes up more than 24h
 * later reconciles a still-present payload and re-pushes a stale print.
 */
const PRINT_PUSH_TTL_SECONDS = 7 * 24 * 3600;

export function printPushKey(eventId: number): string {
  return `print-push-${eventId}`;
}

export async function readPrintPushMarker(
  kv: KVNamespace,
  eventId: number,
): Promise<boolean> {
  return (await kv.get(printPushKey(eventId))) != null;
}

export async function writePrintPushMarker(
  kv: KVNamespace,
  eventId: number,
): Promise<void> {
  await kv.put(printPushKey(eventId), new Date().toISOString(), {
    expirationTtl: PRINT_PUSH_TTL_SECONDS,
  });
}
