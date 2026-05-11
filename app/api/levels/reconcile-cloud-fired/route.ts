/**
 * POST /api/levels/reconcile-cloud-fired
 *
 * Tier 4a: drains Worker cloud-fired-level KV markers into the local
 * level_alerts table on every Mac wake. Pushover already fired in the
 * cloud — reconcile is audit/UI only, ensuring the inbox + LevelsPanel
 * match what the phone already received.
 *
 * Requires X-Cron-Secret to match CRON_SHARED_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reconcileCloudFiredLevels } from "@/lib/alerts/reconcile-cloud-fired";

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

  const result = await reconcileCloudFiredLevels(db, secretOrResponse);
  return NextResponse.json(result, { status: result.status ?? 200 });
}
