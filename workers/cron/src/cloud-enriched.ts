/**
 * Cloud-enrichment payload contract — the KV bridge between calendar-enrich
 * (producer, `cloud-enriched-{eventId}` keys) and fallback-earnings (consumer,
 * B8 recap road). Own module because calendar-enrich already imports
 * issuerSiblings from fallback-earnings — sharing via calendar-enrich would
 * be a circular import.
 */

import type { WorkerEnrichActualResult } from "./enrich-actuals";

export interface CloudEnrichedPayload {
  eventId: number;
  source_key: string;
  actual: string | null;
  consensus: string | null;
  source: WorkerEnrichActualResult["source"];
  deferred?: boolean;
  reason?: string;
  reaction: unknown; // ReactionSnapshot JSON, or null
  fetchedAt: string;
}

export function cloudEnrichedKey(eventId: number): string {
  return `cloud-enriched-${eventId}`;
}

/** Mac enrichment-runner REACTION_SETTLE_MS mirror — reaction window closes 150 min post-release. */
export const COMPLETE_SETTLE_MS = 150 * 60 * 1000;

/** Mac enrichment-runner REACTION_READY_MS mirror — earnings reaction attempts are pointless before T+115 (bars target T+120, 10-min tolerance). */
export const REACTION_READY_MS = 115 * 60 * 1000;

/** Earnings-row predicate — mirrors the Mac rule (source='finnhub' OR event_type='earnings'). */
export function isEarningsRow(eventType: string, sourceKey: string): boolean {
  return eventType === "earnings" || sourceKey.startsWith("finnhub:");
}

/**
 * The ONE completeness definition (Mac enrichment-runner mirror): a payload is
 * COMPLETE when it carries a non-deferred actual AND (a reaction OR the
 * release is ≥150 min old — nothing more will arrive). calendar-enrich stops
 * retrying at complete; fallback-earnings only recaps from a complete payload.
 */
export function isPayloadComplete(
  payload: Pick<CloudEnrichedPayload, "actual" | "deferred" | "reaction">,
  releaseInstant: Date,
  nowMs: number,
): boolean {
  if (payload.actual == null || payload.deferred === true) return false;
  if (payload.reaction != null) return true;
  return nowMs - releaseInstant.getTime() >= COMPLETE_SETTLE_MS;
}
