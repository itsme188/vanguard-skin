/**
 * POST /api/calendar/enrich
 *
 * Service/cron trigger for post-release enrichment. Body:
 *   { eventId?: number, upgradeReactionToTws?: boolean }
 * Omit eventId to enrich all same-window events (identical semantics to
 * the launchd sweep).
 *
 * Auth: X-Cron-Secret (withCronAuth) — this is the SERVICE path only.
 * Used by:
 *  - The launchd wrapper (via HTTP)
 *  - Workers Cron primary path (X-Cron-Secret header; see Phase 9)
 *
 * A human-callable variant with IDENTICAL enrichment behavior but no cron
 * secret requirement lives at POST /api/calendar/enrich-manual (packaged-
 * app trust boundary #35, task 4). Both routes are thin wrappers around
 * lib/calendar/enrich-request.ts::runCalendarEnrichRequest.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getIbApi } from "@/lib/tws/client";
import { runCalendarEnrichRequest } from "@/lib/calendar/enrich-request";
import { withCronAuth } from "@/lib/cron/wrappers";

export async function POST(request: NextRequest) {
  return withCronAuth(request, async () => {
    const body = (await request.json().catch(() => ({}))) as {
      eventId?: number;
      upgradeReactionToTws?: boolean;
    };

    return runCalendarEnrichRequest(db, {
      tws: getIbApi(),
      eventId: body.eventId,
      upgradeReactionToTws: body.upgradeReactionToTws === true,
    });
  });
}
