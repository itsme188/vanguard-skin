/**
 * POST /api/calendar/reconcile-cloud-enrich
 *
 * Drains Worker cloud-enriched payloads into the local calendar_events table.
 * Requires X-Cron-Secret to match CRON_SHARED_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reconcileCloudEnrichment } from "@/lib/calendar/cloud-reconcile";

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

  const result = await reconcileCloudEnrichment(db, secretOrResponse);
  return NextResponse.json(result, { status: result.status ?? 200 });
}
