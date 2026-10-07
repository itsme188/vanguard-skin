import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * Deterministic guard for the newsletter D3 off-topic vote: the model has
 * voted a takeaway on a HELD stock off-topic (claiming it was not held), so
 * an article whose stored mentioned symbols include a currently held symbol
 * is never marked off-topic. Shared by lib/gmail/process.ts and
 * lib/research/reconcile-cloud-fetched.ts so the two paths cannot drift.
 */

/**
 * Uppercase symbols of every name the owner currently has a position in
 * (per-(account, security) latest row, `quantity != 0`):
 *   - long AND short positions in a stock, fund or bond, by their own symbol;
 *   - the UNDERLYING of every live option held, long or short (an expired
 *     contract still waiting on the purge sweep does not count).
 * Held only, not the watchlist. Wider than the prompt's portfolio context in
 * lib/gmail/process.ts, which lists long positions only: the model may vote
 * an article on a shorted name off-topic, and this guard overrides the vote.
 * Compute once per batch.
 */
export function getHeldSymbolSet(db: Database.Database, today: string = todayET()): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT
              CASE WHEN LOWER(COALESCE(s.security_type, '')) = 'option'
                   THEN s.underlying_symbol ELSE s.symbol END AS symbol
       FROM holdings h
       JOIN securities s ON h.security_id = s.id
       WHERE ${latestHoldingsPredicate({})}
         AND ${liveOptionExpirationSql("s", today)}`
    )
    .all() as { symbol: string | null }[];
  const held = new Set<string>();
  for (const r of rows) {
    const symbol = (r.symbol ?? "").trim().toUpperCase();
    if (symbol !== "") held.add(symbol);
  }
  return held;
}

/**
 * The held symbols (as held, uppercase) covered by `symbols`, share-class
 * aware: holding GOOGL covers an article on GOOG. Empty = no held mention.
 */
export function heldSymbolsMentioned(symbols: string[], held: Set<string>): string[] {
  const hits = new Set<string>();
  for (const sym of symbols) {
    if (typeof sym !== "string") continue;
    for (const sibling of issuerSiblings(sym)) {
      const up = sibling.toUpperCase();
      if (held.has(up)) hits.add(up);
    }
  }
  return [...hits];
}

export function mentionsHeldSymbol(symbols: string[], held: Set<string>): boolean {
  return heldSymbolsMentioned(symbols, held).length > 0;
}
