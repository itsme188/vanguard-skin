import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { getActiveWatchlistSecurityIds } from "@/lib/queries/watchlist";
import { resolveOptionUnderlying } from "@/lib/queries/securities";
import type { TieredPickerSecurity } from "@/lib/notes/security-picker";

/**
 * Securities a note can be filed under, tiered for the composer's picker:
 * `held` (latest non-zero holding, or the underlying of a held option),
 * `watch` (active watchlist), `other` (the rest of the equity universe,
 * reachable only through the picker's search). Options themselves are never
 * listed; a held option promotes its underlying, once.
 */
export function getNotePickerSecurities(db: Database.Database): TieredPickerSecurity[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.symbol, s.name, s.security_type
         FROM securities s
        WHERE s.symbol IS NOT NULL AND s.symbol != ''
          AND LOWER(s.security_type) IN ('stock', 'etf', 'mutual fund')
        ORDER BY s.symbol`,
    )
    .all() as Omit<TieredPickerSecurity, "tier">[];

  const heldRows = db
    .prepare(
      `SELECT DISTINCT s.id, LOWER(COALESCE(s.security_type, '')) AS type
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE ${latestHoldingsPredicate()}`,
    )
    .all() as { id: number; type: string }[];

  const held = new Set<number>();
  for (const r of heldRows) {
    if (r.type === "option") {
      const u = resolveOptionUnderlying(db, r.id);
      if (u) held.add(u.id);
    } else {
      held.add(r.id);
    }
  }
  const watch = new Set(getActiveWatchlistSecurityIds(db));

  return rows.map((r) => ({
    ...r,
    tier: held.has(r.id) ? "held" : watch.has(r.id) ? "watch" : "other",
  }));
}
