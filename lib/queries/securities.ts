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
  const candidates = db
    .prepare(
      "SELECT id, symbol, security_type FROM securities WHERE symbol = ? AND LOWER(COALESCE(security_type, '')) != 'option' ORDER BY id",
    )
    .all(opt.underlying_symbol) as { id: number; symbol: string; security_type: string | null }[];
  // Equity first (stock / common stock), then ETF, then any other non-option
  // row (bond, fund…); lowest id breaks ties. Case-insensitive.
  const rank = (t: string | null): number => {
    const v = (t ?? "").toLowerCase();
    if (v === "stock" || v === "common stock") return 0;
    if (v === "etf") return 1;
    return 2;
  };
  const best = [...candidates].sort((a, b) => rank(a.security_type) - rank(b.security_type) || a.id - b.id)[0];
  return best ? { id: best.id, symbol: best.symbol } : null;
}

export function getSecurityById(db: Database.Database, id: number): Security | null {
  return (db.prepare("SELECT * FROM securities WHERE id = ?").get(id) as Security) ?? null;
}
