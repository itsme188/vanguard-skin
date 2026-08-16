/**
 * POST /api/research/reconcile-cloud-fetched
 *
 * Drains Worker `cloud-fetched-newsletter-*` KV markers into research_articles
 * on Mac wake. INSERT OR IGNORE on gmail_message_id makes the merge
 * idempotent — Mac's own fetchNewArticles dedups against the same UNIQUE
 * column if the message had already been ingested locally.
 *
 * Auth: X-Cron-Secret (withCronAuth). Called from research-sync paths (both
 * /api/research/sync UI flow and the /api/cron/research-sync background
 * path) so cloud-fetched rows surface in the Feeds tab the moment Mac wakes.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { reconcileCloudFetchedNewsletters } from "@/lib/research/reconcile-cloud-fetched";
import { withCronAuth } from "@/lib/cron/wrappers";

export async function POST(request: NextRequest) {
  return withCronAuth(request, async () => {
    // withCronAuth already verified CRON_SHARED_SECRET is set and matches
    // before invoking this callback.
    const secret = process.env.CRON_SHARED_SECRET as string;
    const result = await reconcileCloudFetchedNewsletters(db, secret);
    // reconcileCloudFetchedNewsletters signals a non-2xx outcome (e.g.
    // Worker unreachable) via result.status rather than throwing — surface
    // it as the real HTTP status by throwing the shape withCronAuth maps.
    if (result.status) {
      throw { status: result.status, message: result.error ?? "reconcile failed" };
    }
    return result;
  });
}
