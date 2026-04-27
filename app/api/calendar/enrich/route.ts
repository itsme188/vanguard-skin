/**
 * POST /api/calendar/enrich
 *
 * Manual trigger for post-release enrichment. Body:
 *   { eventId?: number }
 * Omit eventId to enrich all same-window events (identical semantics to
 * the launchd sweep).
 *
 * Used by:
 *  - The launchd wrapper (via HTTP)
 *  - Manual "re-enrich this row" UI action on the Calendar page
 *  - Workers Cron primary path (X-Cron-Secret header; see Phase 9)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getIbApi } from "@/lib/tws/client";
import { runEnrichment } from "@/lib/calendar/enrichment-runner";
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
  const secret = secretOrResponse;

  const body = await request.json().catch(() => ({})) as {
    eventId?: number;
    upgradeReactionToTws?: boolean;
  };

  // Phase 9b: before running our own enrichment, drain any cloud-enriched
  // payloads the Worker wrote while the Mac was unreachable. A Worker outage
  // should not block local enrichment, but it must not leak the cron secret to
  // a caller-controlled Host header.
  const reconcile = await reconcileCloudEnrichment(db, secret);
  if (!reconcile.ok) {
    console.warn("[calendar-enrich] reconcile-cloud-enrich failed:", reconcile.error);
  }

  const tws = getIbApi();
  const results = await runEnrichment(db, {
    tws,
    eventId: body.eventId,
    upgradeReactionToTws: body.upgradeReactionToTws === true,
  });

  return NextResponse.json({
    ok: true,
    enriched: results.filter((r) => r.enriched).length,
    failed: results.filter((r) => !r.enriched).length,
    total: results.length,
    events: results.map((r) => ({
      id: r.eventId,
      actual: r.actual,
      reaction_present: !!r.reaction,
      reason: r.reason,
    })),
  });
}
