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

export async function POST(request: NextRequest) {
  // Optional shared-secret gate — enforced when the Worker calls in.
  // Local UI / launchd both run without the header (trusted local caller).
  const secret = process.env.CRON_SHARED_SECRET;
  if (secret) {
    const provided = request.headers.get("x-cron-secret");
    if (provided && provided !== secret) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const body = await request.json().catch(() => ({})) as {
    eventId?: number;
    upgradeReactionToTws?: boolean;
  };

  // Phase 9b: before running our own enrichment, drain any cloud-enriched
  // payloads the Worker wrote while the Mac was unreachable. Fire-and-forget
  // so a Worker outage doesn't block local enrichment.
  reconcileCloudEnrichment(request).catch((err) => {
    console.warn("[calendar-enrich] reconcile-cloud-enrich failed:", err);
  });

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

async function reconcileCloudEnrichment(request: NextRequest): Promise<void> {
  const secret = process.env.CRON_SHARED_SECRET;
  const hostHeader = request.headers.get("host");
  if (!secret || !hostHeader) return;
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  const url = `${proto}://${hostHeader}/api/calendar/reconcile-cloud-enrich`;
  await fetch(url, {
    method: "POST",
    headers: { "X-Cron-Secret": secret },
  }).catch(() => null);
}
