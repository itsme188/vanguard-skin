import { issuerSiblings } from "@/lib/securities/issuer-family";

/**
 * Pure logic for the note composer's security picker (two tiers):
 *   default list   = held + watchlist securities, in a native select
 *   escape hatch   = a search over every security, by symbol or name
 * Rows with a placeholder / CUSIP / OCC-option symbol, or with no name, are
 * hidden from both unless the user types exactly that symbol.
 */

export type PickerTier = "held" | "watch" | "other";

export interface TieredPickerSecurity {
  id: number;
  symbol: string;
  name: string | null;
  security_type?: string | null;
  tier: PickerTier;
}

// A bare 9-character CUSIP (a Treasury bill stored under its CUSIP) and a
// raw OCC option string are identifiers, not securities a note is filed
// under. All-digit symbols are deliberately NOT matched: Tokyo and Seoul
// tickers are numeric.
const CUSIP_SYMBOL_RE = /^\d{3}[0-9A-Z]{5}\d$/i;
const OCC_SYMBOL_RE = /^[A-Z.]{1,6}\s*\d{6}[CP]\d{8}$/i;

/** False for placeholder rows ("-"), bare CUSIPs and raw OCC option strings. */
export function isSelectableNoteSecurity(symbol: string): boolean {
  const s = symbol.trim();
  if (!/[A-Za-z0-9]/.test(s)) return false;
  if (CUSIP_SYMBOL_RE.test(s)) return false;
  if (OCC_SYMBOL_RE.test(s)) return false;
  return true;
}

function familyKey(symbol: string): string {
  const fam = issuerSiblings(symbol);
  return (fam.length > 0 ? [...fam].map((s) => s.toUpperCase()).sort()[0] : symbol).toUpperCase();
}

/** Held + watchlist securities, garbage dropped, share classes adjacent. */
export function defaultPickerSecurities(
  securities: TieredPickerSecurity[],
  keep?: { id: number | null; symbol: string | null } | null,
): TieredPickerSecurity[] {
  const out = securities.filter(
    (s) => (s.tier === "held" || s.tier === "watch") && isSelectableNoteSecurity(s.symbol),
  );
  out.sort(
    (a, b) =>
      familyKey(a.symbol).localeCompare(familyKey(b.symbol)) ||
      a.symbol.localeCompare(b.symbol),
  );
  if (keep?.symbol && keep.id != null && !out.some((s) => s.symbol === keep.symbol)) {
    const row = securities.find((s) => s.id === keep.id);
    out.unshift(row ?? { id: keep.id, symbol: keep.symbol, name: null, tier: "other" });
  }
  return out;
}

/** Typeahead over every security. Empty query -> nothing. */
export function searchPickerSecurities(
  securities: TieredPickerSecurity[],
  query: string,
  limit = 50,
): TieredPickerSecurity[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { s: TieredPickerSecurity; rank: number }[] = [];
  for (const s of securities) {
    const sym = s.symbol.trim().toLowerCase();
    const exact = sym === q;
    if (!exact) {
      if (!isSelectableNoteSecurity(s.symbol)) continue;
      if (!s.name || !s.name.trim()) continue;
    }
    let rank: number;
    if (exact) rank = 0;
    else if (sym.startsWith(q)) rank = 1;
    else if (sym.includes(q)) rank = 2;
    else if ((s.name ?? "").toLowerCase().includes(q)) rank = 3;
    else continue;
    scored.push({ s, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.s.symbol.localeCompare(b.s.symbol));
  return scored.slice(0, limit).map((x) => x.s);
}
