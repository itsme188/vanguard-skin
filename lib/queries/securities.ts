import type Database from "better-sqlite3";
import type { Security } from "@/lib/types";

export function getAllSecurities(db: Database.Database): Security[] {
  return db.prepare("SELECT * FROM securities ORDER BY symbol").all() as Security[];
}

export function getSecurityBySymbol(db: Database.Database, symbol: string): Security | null {
  return (db.prepare("SELECT * FROM securities WHERE symbol = ?").get(symbol) as Security) ?? null;
}

export function getSecurityBySymbolCI(db: Database.Database, symbol: string): Security | null {
  return (
    (db.prepare("SELECT * FROM securities WHERE UPPER(symbol) = ?").get(symbol.toUpperCase()) as Security) ?? null
  );
}

/**
 * Resolve an option contract's underlying security row via the book's
 * existing option→underlying relation (`securities.underlying_symbol` →
 * the non-option security row). Returns null for a non-option, an option
 * with no underlying_symbol, or an underlying that has no row in the book.
 */
export function resolveOptionUnderlying(
  db: Database.Database,
  optionSecurityId: number,
): { id: number; symbol: string } | null {
  const opt = db
    .prepare("SELECT security_type, underlying_symbol FROM securities WHERE id = ?")
    .get(optionSecurityId) as { security_type: string | null; underlying_symbol: string | null } | undefined;
  if (!opt || (opt.security_type ?? "").toLowerCase() !== "option" || !opt.underlying_symbol) return null;
  return (
    (db
      .prepare(
        "SELECT id, symbol FROM securities WHERE symbol = ? AND LOWER(security_type) != 'option' ORDER BY id LIMIT 1",
      )
      .get(opt.underlying_symbol) as { id: number; symbol: string } | undefined) ?? null
  );
}

export function getSecurityById(db: Database.Database, id: number): Security | null {
  return (db.prepare("SELECT * FROM securities WHERE id = ?").get(id) as Security) ?? null;
}
