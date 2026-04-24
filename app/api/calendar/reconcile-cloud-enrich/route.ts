/**
 * POST /api/calendar/reconcile-cloud-enrich
 *
 * Phase 9b: when the Mac was unreachable during an enrichment window, the
 * Worker's cloud-fallback path populates `cloud-enriched-{eventId}` KV keys
 * with actual values (FRED/Finnhub) and reaction snapshots (Polygon). On
 * next Mac wake, this route:
 *
 *   1. Calls the Worker's `/internal/cloud-enriched` to fetch all payloads.
 *   2. Upserts each into `calendar_events` with TWS-always-wins precedence.
 *   3. Calls the Worker's DELETE `/internal/cloud-enriched?eventId=X` per
 *      reconciled row so the KV store drains.
 *
 * No-op when `WORKER_MARKER_URL` (or equivalent) is unset — the pipeline
 * pre-dates Phase 9b and must stay backwards-compatible for local dev.
 *
 * Auth: optional `X-Cron-Secret` header. Piggy-backed on by `/api/calendar/enrich`
 * so every Mac-wake enrichment call naturally drains any pending cloud state
 * first; that's the hot path.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

interface CloudEnrichedPayload {
  eventId: number;
  source_key: string;
  actual: string | null;
  consensus: string | null;
  source: string;
  deferred?: boolean;
  reason?: string;
  reaction: unknown;
  fetchedAt: string;
}

function workerBase(): string | null {
  // Same env var already used by the Mac's Phase-4 marker pre-check
  // (see lib/cron/marker-check.ts::checkCloudMarker). Format: origin only.
  const raw = process.env.WORKER_MARKER_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SHARED_SECRET;
  if (secret) {
    const provided = request.headers.get("x-cron-secret");
    if (provided && provided !== secret) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const base = workerBase();
  if (!base || !secret) {
    return NextResponse.json({
      ok: true,
      reconciled: 0,
      skipped_tws_wins: 0,
      note: "WORKER_MARKER_URL or CRON_SHARED_SECRET unset — no-op",
    });
  }

  // 1. Fetch pending cloud-enriched payloads from the Worker.
  let payloads: Record<string, CloudEnrichedPayload> = {};
  try {
    const res = await fetch(`${base}/internal/cloud-enriched`, {
      headers: { "X-Cron-Secret": secret },
    });
    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        error: `worker returned ${res.status}`,
      }, { status: 502 });
    }
    const body = (await res.json()) as { payloads?: Record<string, CloudEnrichedPayload> };
    payloads = body.payloads ?? {};
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 502 });
  }

  const entries = Object.entries(payloads);
  if (entries.length === 0) {
    return NextResponse.json({ ok: true, reconciled: 0, skipped_tws_wins: 0 });
  }

  let reconciled = 0;
  let skippedTwsWins = 0;
  const errors: { eventId: string; error: string }[] = [];

  const selectRow = db.prepare(
    `SELECT id, reaction_snapshot, consensus_value, enriched_at
     FROM calendar_events
     WHERE id = ?`,
  );
  const updateWithReaction = db.prepare(
    `UPDATE calendar_events
     SET actual_value = ?,
         consensus_value = COALESCE(consensus_value, ?),
         reaction_snapshot = ?,
         enriched_at = datetime('now')
     WHERE id = ?`,
  );
  const updateActualOnly = db.prepare(
    `UPDATE calendar_events
     SET actual_value = ?,
         consensus_value = COALESCE(consensus_value, ?),
         enriched_at = COALESCE(enriched_at, datetime('now'))
     WHERE id = ?`,
  );

  for (const [idStr, payload] of entries) {
    const eventId = Number(idStr);
    if (!Number.isInteger(eventId)) continue;

    try {
      const existing = selectRow.get(eventId) as {
        id: number;
        reaction_snapshot: string | null;
        consensus_value: string | null;
        enriched_at: string | null;
      } | undefined;

      if (!existing) {
        // Event was deleted/rescheduled after snapshot — swallow and drain.
        await deleteFromWorker(base, secret, eventId);
        continue;
      }

      // TWS-always-wins: if the row already has a TWS reaction snapshot,
      // do NOT overwrite it. Still upsert actual + consensus (those are
      // source-agnostic — FRED/Finnhub values are authoritative).
      let existingIsTws = false;
      if (existing.reaction_snapshot) {
        try {
          const parsed = JSON.parse(existing.reaction_snapshot) as { source?: string };
          existingIsTws = parsed.source === "tws";
        } catch {
          existingIsTws = false;
        }
      }

      if (existingIsTws) {
        updateActualOnly.run(
          payload.actual,
          payload.consensus,
          eventId,
        );
        skippedTwsWins += 1;
      } else {
        updateWithReaction.run(
          payload.actual,
          payload.consensus,
          payload.reaction ? JSON.stringify(payload.reaction) : null,
          eventId,
        );
      }
      reconciled += 1;

      await deleteFromWorker(base, secret, eventId);
    } catch (err) {
      errors.push({
        eventId: idStr,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    reconciled,
    skipped_tws_wins: skippedTwsWins,
    errors,
  });
}

async function deleteFromWorker(base: string, secret: string, eventId: number): Promise<void> {
  try {
    await fetch(`${base}/internal/cloud-enriched?eventId=${eventId}`, {
      method: "DELETE",
      headers: { "X-Cron-Secret": secret },
    });
  } catch {
    // Silent — if KV delete fails, the payload will just re-reconcile next
    // wake, which is idempotent on the DB side (`enriched_at` is already set).
  }
}
