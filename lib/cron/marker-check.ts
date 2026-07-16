/**
 * Mac-side check against the Worker's cross-session marker store.
 *
 * The Cloudflare Worker (workers/cron/) writes `cloud-sent-*` markers to KV
 * after it successfully delivers a fallback email. Before the Mac regenerates
 * + sends the same email (via launchd catch-up, for example), it should ask
 * the Worker whether the cloud already delivered.
 *
 * Graceful-degradation principles:
 *   - If WORKER_MARKER_URL is unset, return `null` — the Mac just runs normally.
 *   - If the Worker is unreachable / timing out, return `null` — never block the
 *     Mac's delivery on a Worker RTT. Occasional duplicate is cheaper than a miss.
 *   - If the Worker returns `sentBy: "cloud"`, return "cloud" so the caller can
 *     skip regeneration.
 *   - If the Worker returns `sentBy: "mac"`, that's a same-day repeat — caller
 *     may still choose to skip.
 */

import type Database from "better-sqlite3";
import {
  getLastDigestSentAt,
  setLastDigestSentAt,
} from "@/lib/digest/daily-digest";
import { todayET, addDays } from "@/lib/calendar/date-utils";

export type MarkerSentBy = "mac" | "cloud" | null;

export interface MarkerCheckResult {
  sentBy: MarkerSentBy;
  date: string;
  /** ISO timestamp of the cloud send/attempt start; null for legacy markers. */
  sentAt?: string | null;
  /** "sent" = confirmed delivery; "attempting" = fallback mid-flight (may still
   *  fail). Absent on legacy Worker responses — treat absent as "sent". */
  via?: "sent" | "attempting";
}

const DEFAULT_TIMEOUT_MS = 3000;

export async function checkCloudMarker(
  type: "briefing" | "digest" | "evening",
  opts?: { timeoutMs?: number; date?: string }
): Promise<MarkerCheckResult | null> {
  const url = process.env.WORKER_MARKER_URL;
  const secret = process.env.CRON_SHARED_SECRET;
  if (!url || !secret) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const dateQuery = opts?.date ? `&date=${opts.date}` : "";
  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/internal/marker?type=${type}${dateQuery}`,
      {
        method: "GET",
        headers: { "X-Cron-Secret": secret },
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      console.warn(
        `[marker-check] worker returned ${res.status}; proceeding without skip`
      );
      return null;
    }
    const json = (await res.json()) as MarkerCheckResult;
    return json;
  } catch (err) {
    // Timeout or network error — log and move on.
    console.warn(
      `[marker-check] worker unreachable; proceeding without skip:`,
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stale-window fix (2026-06-09): when the Mac skips because the cloud already
 * sent, advance the shared last_digest_sent_at pointer so the NEXT Mac-won
 * email doesn't re-cover days the cloud already summarized. Forward-only —
 * never regress the pointer. Legacy markers without sentAt fall back to
 * now−30min (slight overlap beats dropped articles).
 *
 * sentAt gets a 5-minute overlap buffer: the Worker writes its cloud-sent
 * marker AFTER Resend delivery, but its Gmail fetch ran 1-3 minutes earlier —
 * an article received inside that processing window is in neither the cloud
 * email nor (without the buffer) the next Mac window. Duplication is
 * acceptable; a dropped article is not.
 */
const CLOUD_SENT_OVERLAP_MS = 5 * 60 * 1000;

export function advanceDigestMarkerAfterCloudSend(
  db: Database.Database,
  sentAt: string | null | undefined,
): void {
  const target = sentAt
    ? new Date(Date.parse(sentAt) - CLOUD_SENT_OVERLAP_MS).toISOString()
    : new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const current = getLastDigestSentAt(db);
  if (!current || Date.parse(target) > Date.parse(current)) {
    setLastDigestSentAt(db, target);
  }
}

/**
 * On-wake reconcile (2026-07-15): a Mac that slept through the whole send
 * window never runs the cron routes' "cloud already sent" branch, so
 * last_digest_sent_at goes stale across every cloud-sent day. (Observed:
 * pointer stuck at 7/13 after the cloud delivered 7/14 + 7/15 — the next
 * Mac-won digest would have re-covered two days the reader already got.)
 *
 * Reads the Worker's markers for digest + evening across yesterday + today
 * (sent-marker TTL is 30h, so older markers are gone anyway) and advances the
 * shared last_digest_sent_at pointer from every CONFIRMED cloud send.
 * Forward-only, so ordering doesn't matter and repeat calls are idempotent.
 *
 * Deliberately skipped:
 *   - via === "attempting": the fallback may still fail; advancing past its
 *     start would drop the articles it never summarized.
 *   - sentBy === "mac": the Mac's own send already advanced the pointer.
 *
 * Callers: /api/cron/digest + /api/cron/evening (route entry, pre-compose)
 * and /api/digest/status (an open dashboard heals the pointer within one poll).
 */
export async function reconcileRecentCloudSends(
  db: Database.Database,
): Promise<{ advanced: boolean; confirmedCloudSends: number }> {
  if (!process.env.WORKER_MARKER_URL || !process.env.CRON_SHARED_SECRET) {
    return { advanced: false, confirmedCloudSends: 0 };
  }

  const today = todayET();
  const dates = [addDays(today, -1), today];
  const types = ["digest", "evening"] as const;

  const markers = await Promise.all(
    types.flatMap((type) => dates.map((date) => checkCloudMarker(type, { date }))),
  );

  const before = getLastDigestSentAt(db);
  let confirmedCloudSends = 0;
  for (const marker of markers) {
    if (!marker || marker.sentBy !== "cloud") continue;
    if (marker.via === "attempting") continue;
    confirmedCloudSends++;
    advanceDigestMarkerAfterCloudSend(db, marker.sentAt);
  }

  const after = getLastDigestSentAt(db);
  const advanced = after !== before;
  if (advanced) {
    console.log(
      `[marker-check] on-wake reconcile advanced last_digest_sent_at ${before ?? "(unset)"} → ${after} from ${confirmedCloudSends} cloud marker(s)`,
    );
  }
  return { advanced, confirmedCloudSends };
}
