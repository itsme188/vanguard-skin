import type { CalendarEvent } from "@/lib/types";

/**
 * Consensus precedence — `consensus_value` (set by the enrichment runner at
 * release time) wins over `consensus_estimate` (the older Finnhub-sync-time
 * snapshot). This is the same rule renderHeadlineTable and the cockpit apply;
 * every display surface must read consensus through this helper, never the
 * bare `consensus_estimate` column. When the two diverge, a beat/miss delta
 * anchored to the stale estimate is wrong (deep-QA 2026-07-28: the hub showed
 * a +36.6% "beat" while the cockpit and the sent email correctly showed +3.7%).
 */
export function effectiveConsensus(
  event: Pick<CalendarEvent, "consensus_estimate"> &
    Partial<Pick<CalendarEvent, "consensus_value">>
): string | null {
  return event.consensus_value ?? event.consensus_estimate;
}
