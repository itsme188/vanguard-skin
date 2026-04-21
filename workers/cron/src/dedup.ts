/**
 * Marker-based dedup between the Mac primary path and Worker cloud fallback.
 *
 * Two markers per day, stored in CRON_KV with 30h TTL:
 *
 *   mac-sent-{type}-{YYYY-MM-DD}   — set by Worker after a successful Mac call
 *   cloud-sent-{type}-{YYYY-MM-DD} — set by Worker after a successful fallback
 *
 * Flow:
 *   1. Worker fires → reads `mac-sent-*` + `cloud-sent-*` → skips if either present.
 *   2. Worker calls Mac webhook → on 200, writes `mac-sent-*`.
 *   3. Fallback fires (Session C) → writes `cloud-sent-*`.
 *   4. Mac's /api/cron/* route calls Worker's /internal/marker endpoint first;
 *      if `cloud-sent-*` is present, route returns 200 {skipped:true} without
 *      regenerating. This closes the race where launchd runs catch-up style
 *      after fallback has already delivered.
 *
 * 30h TTL covers same-day re-triggers plus a generous overnight buffer for
 * timezone/clock skew between Mac and Worker.
 */

import { todayET } from "./dst";

export type JobType = "briefing" | "digest";
export type SentBy = "mac" | "cloud";

const TTL_SECONDS = 30 * 3600; // 30h

function markerKey(sentBy: SentBy, type: JobType, date: string): string {
  return `${sentBy}-sent-${type}-${date}`;
}

export async function readMarkers(
  kv: KVNamespace,
  type: JobType,
  date: string = todayET()
): Promise<{ mac: boolean; cloud: boolean }> {
  const [mac, cloud] = await Promise.all([
    kv.get(markerKey("mac", type, date)),
    kv.get(markerKey("cloud", type, date)),
  ]);
  return { mac: mac !== null, cloud: cloud !== null };
}

export async function writeMarker(
  kv: KVNamespace,
  sentBy: SentBy,
  type: JobType,
  date: string = todayET()
): Promise<void> {
  await kv.put(markerKey(sentBy, type, date), new Date().toISOString(), {
    expirationTtl: TTL_SECONDS,
  });
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
