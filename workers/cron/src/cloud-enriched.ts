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
  // ReactionSnapshot JSON (reaction-matcher.ts), or null. Never written before
  // release + 120 minutes (REACTION_READY_MS below); a fresh capture carries
  // its own `captured_at`.
  reaction: unknown;
  // When the actual-fetch pass last wrote this payload. NOT the reaction's
  // capture time: an earnings payload is re-written on later ticks, and the
  // macro reaction-only follow-up (calendar-enrich.ts) adds a reaction
  // without touching this field. Read `reaction.captured_at` for that.
  fetchedAt: string;
  /**
   * Macro FRED rows: the data period of the observation the actual came from
   * ("2026-08", "2026-Q2", a week-ending date). Present only when known. The
   * Mac's cloud reconcile stores it in calendar_events.reference_period.
   *
   * A macro actual refused by the size check (macro-figure.ts) goes out as
   * `actual: null` with `reason` set to ACTUAL_REFUSED_PREFIX + the sentence.
   */
  referencePeriod?: string;
}

export function cloudEnrichedKey(eventId: number): string {
  return `cloud-enriched-${eventId}`;
}

/** Mac enrichment-runner REACTION_SETTLE_MS mirror — reaction window closes 150 min post-release. */
export const COMPLETE_SETTLE_MS = 150 * 60 * 1000;

/**
 * Mac enrichment-runner REACTION_READY_MS mirror (same value: the full
 * 120-minute reaction window). A reaction is the move to release + 120
 * minutes; before that instant there is nothing to measure, so NO row —
 * earnings or macro — is captured earlier (owner ruling 2026-10-08; the Mac
 * rule lives in lib/calendar/reaction-validity.ts). History: this was 115
 * minutes and earnings-only, and macro rows were captured minutes after the
 * release, which stored a 5-minute move as the two-hour reaction.
 */
export const REACTION_READY_MS = 120 * 60 * 1000;

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
