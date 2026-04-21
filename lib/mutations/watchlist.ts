import type Database from "better-sqlite3";

interface AddToWatchlistParams {
  securityId: number;
  priceTargetLow?: number;
  priceTargetHigh?: number;
  thesis?: string;
  groupName?: string;
}

/**
 * Add a security to the watchlist. If already on the watchlist (even inactive),
 * reactivates it and updates the targets/thesis.
 */
export function addToWatchlist(
  db: Database.Database,
  params: AddToWatchlistParams
): void {
  db.prepare(
    `INSERT INTO watchlist (security_id, price_target_low, price_target_high, thesis, group_name)
     VALUES (?, ?, ?, ?, COALESCE(?, 'default'))
     ON CONFLICT(security_id) DO UPDATE SET
       is_active = 1,
       price_target_low = COALESCE(excluded.price_target_low, watchlist.price_target_low),
       price_target_high = COALESCE(excluded.price_target_high, watchlist.price_target_high),
       thesis = COALESCE(excluded.thesis, watchlist.thesis),
       group_name = COALESCE(excluded.group_name, watchlist.group_name)`
  ).run(
    params.securityId,
    params.priceTargetLow ?? null,
    params.priceTargetHigh ?? null,
    params.thesis ?? null,
    params.groupName ?? null
  );
}

/**
 * Update price targets, thesis, or group for an existing watchlist item.
 */
export function updateWatchlistItem(
  db: Database.Database,
  id: number,
  updates: {
    priceTargetLow?: number | null;
    priceTargetHigh?: number | null;
    thesis?: string | null;
    groupName?: string | null;
  }
): void {
  const sets: string[] = [];
  const params: (number | string | null)[] = [];

  if (updates.priceTargetLow !== undefined) {
    sets.push("price_target_low = ?");
    params.push(updates.priceTargetLow);
  }
  if (updates.priceTargetHigh !== undefined) {
    sets.push("price_target_high = ?");
    params.push(updates.priceTargetHigh);
  }
  if (updates.thesis !== undefined) {
    sets.push("thesis = ?");
    params.push(updates.thesis);
  }
  if (updates.groupName !== undefined) {
    sets.push("group_name = ?");
    params.push(updates.groupName);
  }

  if (sets.length === 0) return;

  params.push(id);
  db.prepare(`UPDATE watchlist SET ${sets.join(", ")} WHERE id = ?`).run(
    ...params
  );
}

/**
 * Soft-delete: deactivate a watchlist item.
 */
export function removeFromWatchlist(
  db: Database.Database,
  id: number
): void {
  db.prepare("UPDATE watchlist SET is_active = 0 WHERE id = ?").run(id);
}
