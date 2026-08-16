import type Database from "better-sqlite3";
import type { IBApiNext } from "@stoqey/ib";
import { runEnrichment } from "./enrichment-runner";
import { reconcileCloudEnrichment } from "./cloud-reconcile";

/**
 * Shared orchestration entrypoint for the two calendar-enrich routes
 * (packaged-app trust boundary #35, task 4):
 *
 *   - `POST /api/calendar/enrich` — service/cron path, gated by
 *     `withCronAuth` (launchd wrapper + Workers Cron primary path).
 *   - `POST /api/calendar/enrich-manual` — human path, no cron secret
 *     required (the session proxy will gate this in a later task; for now
 *     it is open like any other pre-boundary route).
 *
 * Both routes are thin wrappers around this function so their enrichment
 * behavior stays byte-for-byte identical — only the auth check the route
 * wraps around it differs. This is the split the boundary work calls for:
 * the enrich LOGIC was already lib-resident (`runEnrichment`); this file
 * adds the piece that used to live inline in the (formerly single) route —
 * the cloud-reconcile pre-step and the response shaping.
 */

export interface EnrichRequestOptions {
  /** Enrich just one event by id. Bypasses the time-window filter. */
  eventId?: number;
  /** Re-run TWS reaction capture for an already-enriched event (see EnrichOptions). */
  upgradeReactionToTws?: boolean;
  /** Optional TWS client for reaction snapshots. */
  tws?: IBApiNext | null;
}

export interface EnrichRequestResult {
  ok: true;
  enriched: number;
  failed: number;
  total: number;
  events: {
    id: number;
    actual: string | null;
    reaction_present: boolean;
    reason?: string;
  }[];
}

export async function runCalendarEnrichRequest(
  db: Database.Database,
  opts: EnrichRequestOptions,
): Promise<EnrichRequestResult> {
  // Phase 9b: before running our own enrichment, drain any cloud-enriched
  // payloads the Worker wrote while the Mac was unreachable. A Worker
  // outage should not block local enrichment. The secret always comes from
  // server-side env — never from the caller — so this step is safe to run
  // on BOTH the cron path and the human path.
  const secret = process.env.CRON_SHARED_SECRET;
  if (secret) {
    const reconcile = await reconcileCloudEnrichment(db, secret);
    if (!reconcile.ok) {
      console.warn("[calendar-enrich] reconcile-cloud-enrich failed:", reconcile.error);
    }
  }

  const results = await runEnrichment(db, {
    tws: opts.tws,
    eventId: opts.eventId,
    upgradeReactionToTws: opts.upgradeReactionToTws === true,
  });

  return {
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
  };
}
