/**
 * POST /api/research/reconcile-cloud-fetched
 *
 * Drains Worker `cloud-fetched-newsletter-*` KV markers into research_articles
 * on Mac wake. INSERT OR IGNORE on gmail_message_id makes the merge
 * idempotent — Mac's own fetchNewArticles dedups against the same UNIQUE
 * column if the message had already been ingested locally.
 *
 * Requires X-Cron-Secret to match CRON_SHARED_SECRET. Called from
 * research-sync paths (both /api/research/sync UI flow and the
 * /api/cron/research-sync background path) so cloud-fetched rows surface in
 * the Feeds tab the moment Mac wakes.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reconcileCloudFetchedNewsletters } from "@/lib/research/reconcile-cloud-fetched";

function requireCronSecret(request: NextRequest): string | NextResponse {
  const secret = process.env.CRON_SHARED_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Server not configured: CRON_SHARED_SECRET missing." },
      { status: 500 },
    );
  }

  const provided = request.headers.get("x-cron-secret") ?? "";
  if (provided !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return secret;
}

export async function POST(request: NextRequest) {
  const secretOrResponse = requireCronSecret(request);
  if (typeof secretOrResponse !== "string") return secretOrResponse;

  const result = await reconcileCloudFetchedNewsletters(db, secretOrResponse);
  return NextResponse.json(result, { status: result.status ?? 200 });
}
