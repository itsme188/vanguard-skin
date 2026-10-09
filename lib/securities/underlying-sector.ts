import type Database from "better-sqlite3";
import { normalizeSector } from "@/lib/securities/normalize-sector";
import { issuerSiblings } from "@/lib/securities/issuer-family";

/**
 * How an option finds its underlying's stored sector. Kept apart from
 * classify-option-sectors.ts (which also talks to the AI) so a read-only
 * surface such as Data Health can ask the same question without pulling the
 * AI client in. classify-option-sectors.ts re-exports both names.
 */

/**
 * The two `securities.sector_source` values classify-option-sectors.ts stamps
 * on an OPTION row (their meaning is documented there, where they are
 * re-exported). Declared here so a reader can tell a derived sector from a
 * protected one without importing the classifier.
 */
export const OPTION_SECTOR_SOURCE_INHERITED = "underlying_inherited";
export const OPTION_SECTOR_SOURCE_AI = "ai_classify";

export interface UnderlyingSector {
  /** The non-option security row the sector was read from. */
  securityId: number;
  /** That row's symbol as stored (may be a share-class sibling of the option's
   *  named underlying). */
  symbol: string;
  /** That row's stored sector after `normalizeSector` (GICS-11, or the
   *  pass-through fund labels "Diversified" / "Fixed Income"). */
  sector: string;
}

/** One non-option security row an option's underlying symbol could mean. */
export interface UnderlyingCandidateRow {
  id: number;
  symbol: string;
  sector: string | null;
}

/**
 * Every non-option security row an option's underlying symbol could mean, in
 * the order they are tried: the exactly named symbol first, then its
 * `issuerSiblings` in family order; within one symbol, by row id. Matching is
 * case-insensitive. Another option row is never an underlying. Empty when the
 * symbol is blank or matches nothing.
 */
export function underlyingCandidateRows(
  db: Database.Database,
  underlyingSymbol: string | null | undefined
): UnderlyingCandidateRow[] {
  const wanted = (underlyingSymbol ?? "").trim().toUpperCase();
  if (wanted === "") return [];
  const candidates = [wanted];
  for (const sib of issuerSiblings(wanted)) {
    const s = sib.toUpperCase();
    if (!candidates.includes(s)) candidates.push(s);
  }
  const find = db.prepare(
    `SELECT id, symbol, sector FROM securities
     WHERE UPPER(symbol) = ? AND LOWER(COALESCE(security_type, '')) != 'option'
     ORDER BY id`
  );
  const out: UnderlyingCandidateRow[] = [];
  for (const symbol of candidates) out.push(...(find.all(symbol) as UnderlyingCandidateRow[]));
  return out;
}

/**
 * The stored sector of an option's underlying, or null when the option must
 * not inherit: the underlying symbol matches no non-option security row, or
 * every matching row's sector is blank or a spelling `normalizeSector` rejects.
 *
 * Matching is case-insensitive and share-class aware, the same way
 * `cascadeOptionSectors` (lib/securities/verify-sector-tags.ts) resolves an
 * option's underlying: the exactly named symbol is tried first, then its
 * `issuerSiblings` in family order, and the first row with a usable sector
 * wins. Another option row is never an underlying.
 */
export function resolveUnderlyingSector(
  db: Database.Database,
  underlyingSymbol: string | null | undefined
): UnderlyingSector | null {
  for (const row of underlyingCandidateRows(db, underlyingSymbol)) {
    const sector = normalizeSector(row.sector);
    if (sector) return { securityId: row.id, symbol: row.symbol, sector };
  }
  return null;
}
