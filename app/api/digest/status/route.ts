import { db } from "@/lib/db";
import { getLastDigestSentAt, getLastBriefingSentAt } from "@/lib/digest/daily-digest";
import {
  checkCloudMarker,
  reconcileRecentCloudSends,
  type MarkerCheckResult,
} from "@/lib/cron/marker-check";

export const dynamic = "force-dynamic";

/**
 * GET /api/digest/status — Get last-sent timestamps and default recipient.
 *
 * Cloud-aware since 2026-07-15: a Mac that slept through the send window has
 * a stale last_digest_sent_at while the Worker's KV markers know the cloud
 * delivered. Two additions:
 *   1. reconcileRecentCloudSends — forward-only pointer advance from confirmed
 *      cloud sends (yesterday + today, digest + evening). Idempotent, so
 *      running it on every status poll is safe; DigestCatchup polls every
 *      5 min, which makes an open dashboard self-heal within one poll of wake.
 *   2. cloudDigestToday — today's digest marker verbatim, so the UI can say
 *      "delivered via cloud fallback at 10:47" (or "cloud send in flight")
 *      instead of nagging that 8:45 was missed.
 *
 * Both are graceful no-ops when WORKER_MARKER_URL is unset.
 */
export async function GET() {
  await reconcileRecentCloudSends(db);

  const marker = await checkCloudMarker("digest");
  const cloudDigestToday: MarkerCheckResult | null =
    marker && marker.sentBy === "cloud" ? marker : null;

  return Response.json({
    lastDigestSentAt: getLastDigestSentAt(db),
    lastBriefingSentAt: getLastBriefingSentAt(db),
    defaultRecipient: process.env.BRIEFING_EMAIL_TO || null,
    cloudDigestToday,
  });
}
