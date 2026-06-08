import type Database from "better-sqlite3";
import { parseOCCSymbol } from "@/lib/import/occ-symbol";
import { issuerSiblings } from "@/lib/securities/issuer-family";

/**
 * Given an OCC option symbol, return the underlying ticker to store in
 * securities.underlying_symbol — preferring the issuer-family sibling actually
 * present in the book (GOOGL option -> held GOOG), so the symbol-exact factor
 * inheritance join works. Returns null if `symbol` is not OCC format.
 */
export function resolveHeldUnderlying(
  db: Database.Database,
  symbol: string
): string | null {
  const parsed = parseOCCSymbol(symbol);
  if (!parsed) return null;
  const occUnderlying = parsed.underlying.toUpperCase();
  const isHeld = db.prepare("SELECT 1 FROM securities WHERE UPPER(symbol) = ? LIMIT 1");
  if (isHeld.get(occUnderlying)) return occUnderlying;
  for (const sib of issuerSiblings(occUnderlying).map((s) => s.toUpperCase())) {
    if (sib === occUnderlying) continue;
    if (isHeld.get(sib)) return sib;
  }
  return occUnderlying;
}
