import type Database from "better-sqlite3";
import { findCrossedLevels } from "@/lib/queries/security-levels";
import { triggerLevel } from "@/lib/mutations/security-levels";
import { getHoldingsBySecurity } from "@/lib/queries/security-detail";
import { isOnWatchlist, getWatchlistItem } from "@/lib/queries/watchlist";

/**
 * Scan active levels against the latest price of each security and fire alerts
 * for any that have been crossed. Called by the auto-refresh pipeline after
 * prices are fresh, and also exposed as POST /api/alerts/detect for manual runs.
 *
 * For each fired alert, a compact position-context JSON is attached so the
 * alerts inbox can summarize without a second lookup:
 *   { held: [{account, quantity}], onWatchlist: bool, watchlistGroup: string|null }
 *
 * Claude-generated suggested_action is intentionally NOT computed here — the
 * detect step is fast and synchronous. Suggestion generation is a separate
 * async pass so it can be skipped or retried without blocking detection.
 */
export function detectAndFireAlerts(db: Database.Database): {
  scanned: number;
  fired: number;
  deduped: number;
} {
  const crossed = findCrossedLevels(db);
  let fired = 0;
  let deduped = 0;

  for (const level of crossed) {
    const holdings = getHoldingsBySecurity(db, level.security_id).filter(
      (h) => h.quantity > 0
    );
    const watchItem = getWatchlistItem(db, level.security_id);
    const context = JSON.stringify({
      held: holdings.map((h) => ({
        account: h.account_name,
        quantity: h.quantity,
        unrealized_gain: h.unrealized_gain,
      })),
      onWatchlist: isOnWatchlist(db, level.security_id),
      watchlistGroup: watchItem?.group_name ?? null,
    });

    const { deduped: wasDeduped } = triggerLevel(db, {
      levelId: level.id,
      securityId: level.security_id,
      triggeredPrice: level.current_price,
      positionContext: context,
    });
    // Note: triggeredPrice is the current price, not the level's effective price.
    // For MA-based levels the level itself may have moved; we store what the price
    // was when the cross occurred (useful in the alert display).

    if (wasDeduped) deduped++;
    else fired++;
  }

  return { scanned: crossed.length, fired, deduped };
}
