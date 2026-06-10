/**
 * Marker-based dedup between the Mac primary path and Worker cloud fallback.
 *
 * Four markers per day, stored in CRON_KV:
 *
 *   mac-sent-{type}-{YYYY-MM-DD}        — set by Worker after a successful Mac call,
 *                                         OR by Mac itself via /internal/mac-sent after a
 *                                         successful launchd-driven send (30h TTL)
 *   cloud-sent-{type}-{YYYY-MM-DD}      — set by Worker after a successful fallback (30h TTL)
 *   cloud-attempting-{type}-{YYYY-MM-DD} — set by Worker BEFORE the fallback runs and
 *                                         cleared on success/error (10min TTL). Prevents
 *                                         the next 15-min tick from re-entering an in-flight
 *                                         fallback and double-sending the email.
 *   mac-running-{type}-{YYYY-MM-DD}     — set by Mac at start of /api/cron/* and cleared
 *                                         in finally (10min TTL)
 *
 * Flow:
 *   1. Worker fires → reads sent markers → skips if either sent marker present
 *      OR cloud-attempting (in-flight) present.
 *   2. Worker calls Mac webhook → on 200, writes `mac-sent-*`.
 *   3. Fallback fires (Session C) → writes `cloud-attempting-*` BEFORE the heavy
 *      Gmail+Claude+Resend work, then `cloud-sent-*` on success. The attempting
 *      marker auto-expires (10 min TTL) if the invocation dies mid-fallback, so
 *      the next 15-min tick can retry without coordination state leaking.
 *   4. Mac's /api/cron/* route calls Worker's /internal/marker endpoint first;
 *      if `cloud-sent-*` OR `cloud-attempting-*` is present, route returns 200
 *      {skipped:true} without regenerating. The attempting marker is treated as
 *      "cloud claimed it" so the Mac doesn't race a fallback that's mid-flight.
 *   5. Mac's /api/cron/* route also POSTs /internal/running-marker at entry
 *      (action=set) and at exit (action=clear). Worker re-reads markers right
 *      before firing fallback — if mac-running OR mac-sent appeared during the
 *      primary timeout window, fallback skips. This closes the 8:45→8:57 race
 *      where Mac succeeded slowly during the Worker's primary timeout, Worker
 *      fired fallback anyway, and the user got a thinned-out duplicate.
 *   6. Mac POSTs /internal/mac-sent after a successful launchd send so the
 *      Worker's catch-up retry path can tell "Mac already shipped this" from
 *      "nothing shipped, retry needed." Without this, catch-up retries would
 *      fire duplicates every weekday Mac is awake-and-launchd-succeeds.
 *
 * 30h TTL on sent markers covers same-day re-triggers plus generous overnight
 * buffer for timezone/clock skew. 10min TTL on running-marker auto-expires if
 * Mac dies mid-process — long enough to outlive a 5-min Mac pipeline plus a
 * safety margin for clock skew. 10min TTL on cloud-attempting expires inside
 * a 15-min cron interval, so a killed invocation lets the next tick retry.
 */

import { todayET } from "./dst";

export type JobType = "briefing" | "digest" | "evening";
export type SentBy = "mac" | "cloud";

const SENT_TTL_SECONDS = 30 * 3600; // 30h
const RUNNING_TTL_SECONDS = 10 * 60; // 10 min
const ATTEMPTING_TTL_SECONDS = 10 * 60; // 10 min — outlives a typical 5-min fallback,
                                        // expires inside the 15-min cron interval so a
                                        // killed invocation lets the next tick retry.

function markerKey(sentBy: SentBy, type: JobType, date: string): string {
  return `${sentBy}-sent-${type}-${date}`;
}

function runningKey(type: JobType, date: string): string {
  return `mac-running-${type}-${date}`;
}

function attemptingKey(type: JobType, date: string): string {
  return `cloud-attempting-${type}-${date}`;
}

export async function readMarkers(
  kv: KVNamespace,
  type: JobType,
  date: string = todayET()
): Promise<{ mac: boolean; cloud: boolean; macRunning: boolean; cloudAttempting: boolean }> {
  const [mac, cloud, macRunning, cloudAttempting] = await Promise.all([
    kv.get(markerKey("mac", type, date)),
    kv.get(markerKey("cloud", type, date)),
    kv.get(runningKey(type, date)),
    kv.get(attemptingKey(type, date)),
  ]);
  return {
    mac: mac !== null,
    cloud: cloud !== null,
    macRunning: macRunning !== null,
    cloudAttempting: cloudAttempting !== null,
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

export async function setAttemptingMarker(
  kv: KVNamespace,
  type: JobType,
  date: string = todayET()
): Promise<void> {
  await kv.put(attemptingKey(type, date), new Date().toISOString(), {
    expirationTtl: ATTEMPTING_TTL_SECONDS,
  });
}

export async function clearAttemptingMarker(
  kv: KVNamespace,
  type: JobType,
  date: string = todayET()
): Promise<void> {
  await kv.delete(attemptingKey(type, date));
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

/** Used by the /internal/marker endpoint the Mac polls. */
export async function getMarkerStatus(
  kv: KVNamespace,
  type: JobType,
  date: string = todayET()
): Promise<{ sentBy: SentBy | null; date: string; sentAt: string | null }> {
  // Read VALUES (not just existence): writeMarker / setAttemptingMarker have
  // always stored new Date().toISOString(), which is exactly the send/start
  // timestamp the Mac needs to advance its local last_digest_sent_at when it
  // skips with "cloud already sent" (stale-window fix, 2026-06-09).
  const [mac, cloud, attempting] = await Promise.all([
    kv.get(markerKey("mac", type, date)),
    kv.get(markerKey("cloud", type, date)),
    kv.get(attemptingKey(type, date)),
  ]);
  const iso = (v: string | null): string | null =>
    v !== null && ISO_RE.test(v) ? v : null;

  // cloud wins ties — if both markers are set, the cloud-sent email definitely
  // went out (Mac marker may have been written after cloud delivery by a race).
  if (cloud !== null) return { sentBy: "cloud", date, sentAt: iso(cloud) };
  // cloud-attempting means a fallback is mid-flight RIGHT NOW. Its timestamp is
  // BEFORE the fallback's Gmail fetch, so it is a safe (conservative) sentAt.
  if (attempting !== null)
    return { sentBy: "cloud", date, sentAt: iso(attempting) };
  if (mac !== null) return { sentBy: "mac", date, sentAt: iso(mac) };
  return { sentBy: null, date, sentAt: null };
}
