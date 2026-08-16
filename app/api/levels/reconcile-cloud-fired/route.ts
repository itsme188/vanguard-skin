/**
 * POST /api/levels/reconcile-cloud-fired
 *
 * Tier 4a: drains Worker cloud-fired-level KV markers into the local
 * level_alerts table on every Mac wake. Pushover already fired in the
 * cloud — reconcile is audit/UI only, ensuring the inbox + LevelsPanel
 * match what the phone already received.
 *
 * Auth: X-Cron-Secret (withCronAuth).
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { reconcileCloudFiredLevels } from "@/lib/alerts/reconcile-cloud-fired";
import { withCronAuth } from "@/lib/cron/wrappers";

export async function POST(request: NextRequest) {
  return withCronAuth(request, async () => {
    // withCronAuth already verified CRON_SHARED_SECRET is set and matches
    // before invoking this callback.
    const secret = process.env.CRON_SHARED_SECRET as string;
    const result = await reconcileCloudFiredLevels(db, secret);
    // reconcileCloudFiredLevels signals a non-2xx outcome (e.g. Worker
    // unreachable) via result.status rather than throwing — surface it as
    // the real HTTP status by throwing the shape withCronAuth maps.
    if (result.status) {
      throw { status: result.status, message: result.error ?? "reconcile failed" };
    }
    return result;
  });
}
