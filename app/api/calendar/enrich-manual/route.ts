/**
 * POST /api/calendar/enrich-manual
 *
 * Human-callable path for on-demand post-release enrichment — identical
 * behavior to POST /api/calendar/enrich (both call the shared
 * lib/calendar/enrich-request.ts::runCalendarEnrichRequest entrypoint) but
 * does NOT require the X-Cron-Secret service credential.
 *
 * Split out 2026-08-14 (packaged-app trust boundary #35, task 4): a manual
 * "re-enrich this row" UI action must not need a service secret a human
 * session will never carry. No auth is added here YET — the session proxy
 * (a later task) will gate this route like every other human route once it
 * lands; until then it behaves like the rest of the pre-boundary app.
 *
 * Body: { eventId?: number, upgradeReactionToTws?: boolean } — same shape
 * as the cron path.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getIbApi } from "@/lib/tws/client";
import { runCalendarEnrichRequest } from "@/lib/calendar/enrich-request";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    eventId?: number;
    upgradeReactionToTws?: boolean;
  };

  const result = await runCalendarEnrichRequest(db, {
    tws: getIbApi(),
    eventId: body.eventId,
    upgradeReactionToTws: body.upgradeReactionToTws === true,
  });

  return NextResponse.json(result);
}
