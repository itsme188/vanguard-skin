import type Database from "better-sqlite3";

interface AddToWatchlistParams {
  securityId: number;
  priceTargetLow?: number;
  priceTargetHigh?: number;
  thesis?: string;
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
    `INSERT INTO watchlist (security_id, price_target_low, price_target_high, thesis)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(security_id) DO UPDATE SET
       is_active = 1,
       price_target_low = COALESCE(excluded.price_target_low, watchlist.price_target_low),
       price_target_high = COALESCE(excluded.price_target_high, watchlist.price_target_high),
       thesis = COALESCE(excluded.thesis, watchlist.thesis)`
  ).run(
    params.securityId,
    params.priceTargetLow ?? null,
    params.priceTargetHigh ?? null,
    params.thesis ?? null
  );
}

/**
 * Update price targets and/or thesis for an existing watchlist item.
 */
export function updateWatchlistItem(
  db: Database.Database,
  id: number,
  updates: {
    priceTargetLow?: number | null;
    priceTargetHigh?: number | null;
    thesis?: string | null;
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
