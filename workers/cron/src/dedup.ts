/**
 * Marker-based dedup between the Mac primary path and Worker cloud fallback.
 *
 * Three markers per day, stored in CRON_KV:
 *
 *   mac-sent-{type}-{YYYY-MM-DD}    — set by Worker after a successful Mac call (30h TTL)
 *   cloud-sent-{type}-{YYYY-MM-DD}  — set by Worker after a successful fallback (30h TTL)
 *   mac-running-{type}-{YYYY-MM-DD} — set by Mac at start of /api/cron/* and cleared in finally (10min TTL)
 *
 * Flow:
 *   1. Worker fires → reads sent markers → skips if either present.
 *   2. Worker calls Mac webhook → on 200, writes `mac-sent-*`.
 *   3. Fallback fires (Session C) → writes `cloud-sent-*`.
 *   4. Mac's /api/cron/* route calls Worker's /internal/marker endpoint first;
 *      if `cloud-sent-*` is present, route returns 200 {skipped:true} without
 *      regenerating. This closes the race where launchd runs catch-up style
 *      after fallback has already delivered.
 *   5. Mac's /api/cron/* route also POSTs /internal/running-marker at entry
 *      (action=set) and at exit (action=clear). Worker re-reads markers right
 *      before firing fallback — if mac-running OR mac-sent appeared during the
 *      primary timeout window, fallback skips. This closes the 8:45→8:57 race
 *      where Mac succeeded slowly during the Worker's primary timeout, Worker
 *      fired fallback anyway, and the user got a thinned-out duplicate.
 *
 * 30h TTL on sent markers covers same-day re-triggers plus generous overnight
 * buffer for timezone/clock skew. 10min TTL on running-marker auto-expires if
 * Mac dies mid-process — long enough to outlive a 5-min Mac pipeline plus a
 * safety margin for clock skew.
 */

import { todayET } from "./dst";

export type JobType = "briefing" | "digest" | "evening";
export type SentBy = "mac" | "cloud";

const SENT_TTL_SECONDS = 30 * 3600; // 30h
const RUNNING_TTL_SECONDS = 10 * 60; // 10 min

function markerKey(sentBy: SentBy, type: JobType, date: string): string {
  return `${sentBy}-sent-${type}-${date}`;
}

function runningKey(type: JobType, date: string): string {
  return `mac-running-${type}-${date}`;
}

export async function readMarkers(
  kv: KVNamespace,
  type: JobType,
  date: string = todayET()
): Promise<{ mac: boolean; cloud: boolean; macRunning: boolean }> {
  const [mac, cloud, macRunning] = await Promise.all([
    kv.get(markerKey("mac", type, date)),
    kv.get(markerKey("cloud", type, date)),
    kv.get(runningKey(type, date)),
  ]);
  return {
    mac: mac !== null,
    cloud: cloud !== null,
    macRunning: macRunning !== null,
  };
}

export async function writeMarker(
  kv: KVNamespace,
  sentBy: SentBy,
  type: JobType,
  date: string = todayET()
): Promise<void> {
  await kv.put(markerKey(sentBy, type, date), new Date().toISOString(), {
    expirationTtl: SENT_TTL_SECONDS,
  });
}

export async function setRunningMarker(
  kv: KVNamespace,
  type: JobType,
  date: string = todayET()
): Promise<void> {
  await kv.put(runningKey(type, date), new Date().toISOString(), {
    expirationTtl: RUNNING_TTL_SECONDS,
  });
}

export async function clearRunningMarker(
  kv: KVNamespace,
  type: JobType,
  date: string = todayET()
): Promise<void> {
  await kv.delete(runningKey(type, date));
}

/** Used by the /internal/marker endpoint the Mac polls. */
export async function getMarkerStatus(
  kv: KVNamespace,
  type: JobType,
  date: string = todayET()
): Promise<{ sentBy: SentBy | null; date: string }> {
  const { mac, cloud } = await readMarkers(kv, type, date);
  // cloud wins ties — if both markers are set, the cloud-sent email definitely
  // went out (Mac marker may have been written after cloud delivery by a race).
  if (cloud) return { sentBy: "cloud", date };
  if (mac) return { sentBy: "mac", date };
  return { sentBy: null, date };
}
