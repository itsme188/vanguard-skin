import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { issuerSiblings } from "@/lib/securities/issuer-family";

/**
 * Deterministic guard for the newsletter D3 off-topic vote: the model has
 * voted a takeaway on a HELD stock off-topic (claiming it was not held), so
 * an article whose stored mentioned symbols include a currently held symbol
 * is never marked off-topic. Shared by lib/gmail/process.ts and
 * lib/research/reconcile-cloud-fetched.ts so the two paths cannot drift.
 */

/**
 * Uppercase symbols of everything currently held (same universe as the
 * prompt's portfolio context in lib/gmail/process.ts: per-(account,
 * security) latest row, quantity > 0). Held only, not the watchlist.
 * Compute once per batch.
 */
export function getHeldSymbolSet(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.symbol
       FROM holdings h
       JOIN securities s ON h.security_id = s.id
       WHERE ${latestHoldingsPredicate({ includeShorts: false })}`
    )
    .all() as { symbol: string }[];
  return new Set(rows.map((r) => r.symbol.toUpperCase()));
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
