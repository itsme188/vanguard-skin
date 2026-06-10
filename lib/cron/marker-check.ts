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

export type MarkerSentBy = "mac" | "cloud" | null;

export interface MarkerCheckResult {
  sentBy: MarkerSentBy;
  date: string;
  /** ISO timestamp of the cloud send/attempt start; null for legacy markers. */
  sentAt?: string | null;
}

const DEFAULT_TIMEOUT_MS = 3000;

export async function checkCloudMarker(
  type: "briefing" | "digest" | "evening",
  opts?: { timeoutMs?: number }
): Promise<MarkerCheckResult | null> {
  const url = process.env.WORKER_MARKER_URL;
  const secret = process.env.CRON_SHARED_SECRET;
  if (!url || !secret) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(
      `${url.replace(/\/$/, "")}/internal/marker?type=${type}`,
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
 */
export function advanceDigestMarkerAfterCloudSend(
  db: Database.Database,
  sentAt: string | null | undefined,
): void {
  const target =
    sentAt ?? new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const current = getLastDigestSentAt(db);
  if (!current || Date.parse(target) > Date.parse(current)) {
    setLastDigestSentAt(db, target);
  }
}
