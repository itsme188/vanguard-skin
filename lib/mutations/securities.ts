import type Database from "better-sqlite3";
import { extractMaturityDate } from "@/lib/bonds";
import { formatOccSymbol, parseOptionSymbol } from "@/lib/import/occ-symbol";

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
  currency?: string;
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

  // Default the contract multiplier for options. Listed equity/ETF options
  // always carry a 100x multiplier, but the canonical CSV format has no
  // multiplier column, so a freshly-imported option lands at NULL →
  // COALESCE(multiplier, 1) → valued at 1/100th of reality, with the shortfall
  // leaking into inferred cash. TWS enrichment sets it correctly; this covers
  // every writer that doesn't. No listed equity option has a multiplier <= 1,
  // so treating that as "missing" is safe (a genuine non-standard multiplier
  // like an adjusted option's is always > 1 and is preserved).
  if (
    p.securityType?.toLowerCase() === "option" &&
    (p.multiplier == null || p.multiplier <= 1)
  ) {
    p.multiplier = 100;
  }

  // Canonicalize option symbols to one spelling before anything below looks
  // the row up. The same contract can arrive under multiple human-readable
  // spellings for the exact same (underlying, expiry, right, strike) —
  // "NVDA 260618 C 175.00" vs OCC "NVDA  260618C00175000" — and without
  // this, each spelling gets its own securities row, silently double-
  // counting that option's trades/holdings/tax lots
  // (qa:security-detail-transactions--same-option-trade-duplicated-across-
  // two-symbol-spellings). Parsing the SYMBOL STRING ITSELF — never the
  // separate underlyingSymbol/strikePrice/expirationDate/optionType params
  // — keeps this safe: a bare ticker like "INTC" never parses as an option
  // shape, so it falls straight through unchanged and the type-conflict
  // guard below still runs exactly as before.
  if (p.symbol) {
    const parsedOption = parseOptionSymbol(p.symbol);
    if (parsedOption) {
      p.symbol = formatOccSymbol(parsedOption);
    }
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

  // Bond-like identity must never land on a security whose ledger shows equity
  // fills (2026-08-21 audit: a statement transcription put a name-fragment in
  // the symbol column, colliding with a held equity ticker; the incoming Bond
  // type + Treasury name + derived maturity stamped bond identity onto the
  // equity row, sending a live position through the bond ÷100 valuation path).
  // The CASE guard below only blocks weak incoming 'Stock'; this is the
  // symmetric strong-evidence direction. The transaction row itself still
  // imports — only the identity-corrupting metadata is refused. Real bonds are
  // CUSIP-symboled: a ticker with actual equity fills retyped to Bond is
  // effectively always a transcription defect, and a genuine correction still
  // has the manual-repair path (the warn below is the audit trail).
  if (existing && p.securityType) {
    const incoming = p.securityType.toLowerCase();
    const existingType = (existing.security_type ?? "").toLowerCase();
    if (
      (incoming === "bond" || incoming === "mutual fund") &&
      (existingType === "stock" || existingType === "etf")
    ) {
      const fills = db
        .prepare(
          `SELECT COUNT(*) AS n FROM transactions
            WHERE security_id = ?
              AND UPPER(type) IN ('BUY','SELL','SHORT_SELL','BUY_TO_COVER',
                                  'BUY_TO_OPEN','SELL_TO_OPEN','BUY_TO_CLOSE','SELL_TO_CLOSE')
              AND quantity IS NOT NULL AND quantity <> 0`
        )
        .get(existing.id) as { n: number };
      if (fills.n > 0) {
        console.warn(
          `[upsertSecurity] Refusing ${p.securityType} identity for "${p.symbol}": ` +
            `existing ${existing.security_type} security has ${fills.n} equity fills. ` +
            `Dropping incoming security_type/name/maturity_date; check the source row's symbol.`
        );
        p.securityType = undefined;
        p.name = undefined;
        p.maturityDate = undefined;
      }
    }
  }

  // Currency defaults to 'USD' on a fresh insert (column is NOT NULL). On
  // conflict, an incoming 'USD' (whether explicit or the caller's default —
  // the two are indistinguishable here) never clobbers an already-stored
  // non-USD currency; a genuine non-USD value always wins. This protects a
  // security correctly tagged e.g. 'KRW' by the FX-aware ingestion path from
  // being reset back to 'USD' by a later writer that doesn't know better.
  const currency = p.currency ?? "USD";

  db.prepare(
    `INSERT INTO securities (symbol, name, security_type, asset_class,
       underlying_symbol, strike_price, expiration_date, option_type, multiplier, maturity_date, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       name = COALESCE(excluded.name, securities.name),
       -- 'Stock' is IBKR's catch-all for every STK contract — TWS positions
       -- and IBKR activity imports label ETFs 'Stock' because the API cannot
       -- distinguish them. An incoming 'Stock' is therefore WEAK evidence and
       -- must never downgrade a row already classified into a fund-family
       -- type (the 2026-08-10 ETF-retype repair was silently reverted by the
       -- next TWS sync through exactly this clause). Genuine specific types
       -- still win over each other via the COALESCE fallback.
       security_type = CASE
         WHEN LOWER(excluded.security_type) = 'stock'
              AND LOWER(COALESCE(securities.security_type, ''))
                  IN ('etf', 'mutual fund', 'closed-end fund', 'bond')
         THEN securities.security_type
         ELSE COALESCE(excluded.security_type, securities.security_type)
       END,
       asset_class = COALESCE(excluded.asset_class, securities.asset_class),
       underlying_symbol = COALESCE(excluded.underlying_symbol, securities.underlying_symbol),
       strike_price = COALESCE(excluded.strike_price, securities.strike_price),
       expiration_date = COALESCE(excluded.expiration_date, securities.expiration_date),
       option_type = COALESCE(excluded.option_type, securities.option_type),
       multiplier = COALESCE(excluded.multiplier, securities.multiplier),
       maturity_date = COALESCE(excluded.maturity_date, securities.maturity_date),
       currency = COALESCE(NULLIF(excluded.currency, 'USD'), securities.currency)`
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
    p.maturityDate ?? null,
    currency
  );

  const row = db
    .prepare("SELECT id FROM securities WHERE symbol = ?")
    .get(p.symbol) as { id: number };
  return row.id;
}
