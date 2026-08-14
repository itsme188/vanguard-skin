/**
 * POST /api/calendar/reconcile-cloud-enrich
 *
 * Drains Worker cloud-enriched payloads into the local calendar_events table.
 * Auth: X-Cron-Secret (withCronAuth).
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { reconcileCloudEnrichment } from "@/lib/calendar/cloud-reconcile";
import { withCronAuth } from "@/lib/cron/wrappers";

export async function POST(request: NextRequest) {
  return withCronAuth(request, async () => {
    // withCronAuth already verified CRON_SHARED_SECRET is set and matches
    // before invoking this callback.
    const secret = process.env.CRON_SHARED_SECRET as string;
    const result = await reconcileCloudEnrichment(db, secret);
    // reconcileCloudEnrichment signals a non-2xx outcome (e.g. Worker
    // unreachable) via result.status rather than throwing — surface it as
    // the real HTTP status by throwing the shape withCronAuth maps.
    if (result.status) {
      throw { status: result.status, message: result.error ?? "reconcile failed" };
    }
    return result;
  });
}
