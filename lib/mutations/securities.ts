import type Database from "better-sqlite3";

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
