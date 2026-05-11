import type Database from "better-sqlite3";
import { extractMaturityDate } from "@/lib/bonds";

export interface UpsertSecurityParams {
  symbol: string;
  name?: string;
  securityType?: string;
  assetClass?: string;
  underlyingSymbol?: string;
  strikePrice?: number;
  expirationDate?: string;
  optionType?: "CALL" | "PUT";
  multiplier?: number;
  maturityDate?: string;
}

export function upsertSecurity(
  db: Database.Database,
  params: UpsertSecurityParams
): number;
export function upsertSecurity(
  db: Database.Database,
  symbol: string,
  name?: string,
  securityType?: string,
  assetClass?: string
): number;
export function upsertSecurity(
  db: Database.Database,
  symbolOrParams: string | UpsertSecurityParams,
  name?: string,
  securityType?: string,
  assetClass?: string
): number {
  const p: UpsertSecurityParams =
    typeof symbolOrParams === "string"
      ? { symbol: symbolOrParams, name, securityType, assetClass }
      : symbolOrParams;

  // Defense-in-depth normalization. Some writers (notably TWS contractDetails)
  // historically supplied YYYYMMDD expirations and lowercase security types,
  // breaking date comparisons + downstream rendering. Caught at boundary.
  if (p.expirationDate && /^\d{8}$/.test(p.expirationDate)) {
    p.expirationDate = `${p.expirationDate.slice(0, 4)}-${p.expirationDate.slice(4, 6)}-${p.expirationDate.slice(6, 8)}`;
  }
  if (p.maturityDate && /^\d{8}$/.test(p.maturityDate)) {
    p.maturityDate = `${p.maturityDate.slice(0, 4)}-${p.maturityDate.slice(4, 6)}-${p.maturityDate.slice(6, 8)}`;
  }
  if (p.securityType) {
    const normalized: Record<string, string> = {
      stock: "Stock",
      option: "Option",
      bond: "Bond",
      etf: "ETF",
      mutual_fund: "Mutual Fund",
      "mutual fund": "Mutual Fund",
      future: "Future",
      forex: "Forex",
      cash: "Cash",
    };
    const lower = p.securityType.toLowerCase();
    if (normalized[lower]) p.securityType = normalized[lower];
  }

  // Auto-derive maturity date from name for bonds when not explicitly provided.
  // This ensures every bond import auto-populates maturity_date even when the
  // caller (TWS, canonical CSV) doesn't set it — enabling duration computation.
  if (
    p.securityType?.toLowerCase() === "bond" &&
    !p.maturityDate &&
    p.name
  ) {
    const parsed = extractMaturityDate(p.name);
    if (parsed) p.maturityDate = parsed;
  }

  // Safety check: don't let option metadata clobber an existing stock security
  // (or vice versa) on the same symbol. This prevents the "INTC stock becomes
  // INTC option" bug when Claude returns bare tickers for options.
  const existing = db
    .prepare("SELECT id, security_type FROM securities WHERE symbol = ?")
    .get(p.symbol) as { id: number; security_type: string | null } | undefined;

  if (existing && p.securityType && existing.security_type) {
    const existingIsOption = existing.security_type?.toLowerCase() === "option";
    const incomingIsOption = p.securityType?.toLowerCase() === "option";

    if (existingIsOption !== incomingIsOption) {
      // Type conflict: don't merge, just return the existing ID.
      // The parser should have used an OCC symbol for options — if we get
      // here, something upstream didn't convert properly.
      console.warn(
        `[upsertSecurity] Type conflict for symbol "${p.symbol}": ` +
        `existing=${existing.security_type}, incoming=${p.securityType}. ` +
        `Skipping update to prevent data corruption.`
      );
      return existing.id;
    }
  }

  db.prepare(
    `INSERT INTO securities (symbol, name, security_type, asset_class,
       underlying_symbol, strike_price, expiration_date, option_type, multiplier, maturity_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       name = COALESCE(excluded.name, securities.name),
       security_type = COALESCE(excluded.security_type, securities.security_type),
       asset_class = COALESCE(excluded.asset_class, securities.asset_class),
       underlying_symbol = COALESCE(excluded.underlying_symbol, securities.underlying_symbol),
       strike_price = COALESCE(excluded.strike_price, securities.strike_price),
       expiration_date = COALESCE(excluded.expiration_date, securities.expiration_date),
       option_type = COALESCE(excluded.option_type, securities.option_type),
       multiplier = COALESCE(excluded.multiplier, securities.multiplier),
       maturity_date = COALESCE(excluded.maturity_date, securities.maturity_date)`
  ).run(
    p.symbol,
    p.name ?? null,
    p.securityType ?? null,
    p.assetClass ?? null,
    p.underlyingSymbol ?? null,
    p.strikePrice ?? null,
    p.expirationDate ?? null,
    p.optionType ?? null,
    p.multiplier ?? null,
    p.maturityDate ?? null
  );

  const row = db
    .prepare("SELECT id FROM securities WHERE symbol = ?")
    .get(p.symbol) as { id: number };
  return row.id;
}
