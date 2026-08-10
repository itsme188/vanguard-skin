import type Database from "better-sqlite3";
import { SecType } from "@stoqey/ib";
import { getIbApi } from "./client";
import { RateLimiter } from "./rate-limiter";
import { mapSecurityType, shouldRetypeAsEtf } from "./security-type-map";
import type { EnrichResult } from "./types";
import { normalizeSector } from "@/lib/securities/normalize-sector";

const rateLimiter = new RateLimiter();

interface SecurityRow {
  id: number;
  symbol: string;
  security_type: string | null;
  name: string | null;
  currency: string | null;
}

/**
 * Parse an OCC option symbol into its components.
 * OCC format: "ALGM  270115C00035000"
 *   - Underlying: first chars up to padding spaces (or 6 chars)
 *   - Date: YYMMDD
 *   - Right: C or P
 *   - Strike: 8-digit integer / 1000
 */
function parseOCCSymbol(symbol: string): {
  underlying: string;
  lastTradeDate: string;
  right: string;
  strike: number;
} | null {
  // OCC format: up to 6-char underlying (space-padded), YYMMDD, C/P, 8-digit strike
  const match = symbol.match(/^(.{1,6}?)\s*(\d{6})([CP])(\d{8})$/);
  if (!match) return null;

  const [, underlying, dateStr, right, strikeStr] = match;
  const yy = dateStr.slice(0, 2);
  const mm = dateStr.slice(2, 4);
  const dd = dateStr.slice(4, 6);
  const lastTradeDate = `20${yy}${mm}${dd}`;
  const strike = parseInt(strikeStr, 10) / 1000;

  return { underlying: underlying.trim(), lastTradeDate, right, strike };
}

/**
 * Build a TWS contract for a security, handling options specially.
 * Options use underlying + expiry + strike + right instead of the OCC symbol.
 */
function buildContract(sec: SecurityRow): Record<string, unknown> | null {
  const secType = mapSecurityType(sec.security_type);

  if (secType === SecType.OPT) {
    // Try to parse OCC symbol for option contract fields
    const parsed = parseOCCSymbol(sec.symbol);
    if (!parsed) return null; // can't resolve non-OCC option symbols

    return {
      symbol: parsed.underlying,
      secType: SecType.OPT,
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: parsed.lastTradeDate,
      strike: parsed.strike,
      right: parsed.right,
    };
  }

  // Stocks, ETFs, bonds, mutual funds — simple symbol lookup. Use the
  // security's own stored currency (Task 6: foreign-currency valuation) so a
  // KRW-denominated contract like 402340 isn't queried as if it were USD.
  return {
    symbol: sec.symbol,
    secType,
    exchange: "SMART",
    currency: sec.currency || "USD",
  };
}

/**
 * Enrich securities with contract details from TWS.
 *
 * Fetches industry, category, exchange, and conId for each security.
 * Only fetches securities that don't already have an ib_con_id.
 *
 * Covers ALL held securities across all accounts:
 *   - Stocks/ETFs: resolved by symbol
 *   - Mutual funds: resolved by symbol with SecType.FUND
 *   - Options (OCC format): resolved by underlying + expiry + strike + right
 *   - Excluded: CUSIP-prefixed bonds, Cash, non-OCC option symbols
 */
export async function enrichSecurities(
  db: Database.Database,
  securityIds?: number[],
): Promise<EnrichResult[]> {
  const api = getIbApi();
  if (!api) throw new Error("TWS not connected");

  let securities: SecurityRow[];
  if (securityIds?.length) {
    const placeholders = securityIds.map(() => "?").join(",");
    securities = db
      .prepare(
        `SELECT id, symbol, security_type, name, currency FROM securities WHERE id IN (${placeholders})`,
      )
      .all(...securityIds) as SecurityRow[];
  } else {
    // Enrich all held securities across all accounts that TWS can resolve.
    // Excluded:
    //   - CUSIP-prefixed: bonds/SPACs without tickers
    //   - Cash positions (AUD, etc.)
    //   - Non-OCC option symbols (Vanguard format with spaces like "ARKK 270115 P 100.00")
    //     → migration 022 merges these into OCC counterparts
    //
    // Selection criteria reaches both unenriched (ib_con_id IS NULL) AND rows
    // whose `name` is missing/=symbol so we can backfill company names from
    // contractDetails.longName for IBKR-imported holdings.
    securities = db
      .prepare(
        `SELECT DISTINCT s.id, s.symbol, s.security_type, s.name, s.currency
         FROM securities s
         JOIN holdings h ON h.security_id = s.id
         WHERE (s.ib_con_id IS NULL OR s.name IS NULL OR s.name = s.symbol)
           AND s.symbol NOT LIKE 'CUSIP:%'
           AND LOWER(s.security_type) NOT IN ('cash', 'money_market', 'money market')
           AND (
             -- Stocks, ETFs, bonds, mutual funds: simple symbols (no spaces)
             (LOWER(s.security_type) NOT IN ('option') AND s.symbol NOT LIKE '% %')
             -- Options: only OCC format (ends in digits, no human-readable spaces)
             OR (LOWER(s.security_type) = 'option' AND s.symbol GLOB '*[0-9][0-9][0-9]')
           )`,
      )
      .all() as SecurityRow[];
  }

  // `name` is set when the existing value is missing or just echoes the
  // symbol (i.e. was never enriched). Existing real names take precedence.
  //
  // security_type: IBKR reports ETFs as plain stocks (SecType.STK) in both
  // TWS positions and IBKR activity-statement imports — nothing upstream
  // distinguishes ARKK/HACK/SPY/etc. from a single-name equity. Contract
  // details carry the missing signal (`stockType`); shouldRetypeAsEtf()
  // only fires it forward (NULL/'Stock' -> 'ETF'), never downgrades an
  // already-typed row, and never overwrites a statement-sourced non-Stock
  // type (see lib/tws/security-type-map.ts for the full contract).
  const updateSecurity = db.prepare(`
    UPDATE securities
    SET sector = COALESCE(?, sector),
        sector_source = CASE WHEN ? IS NOT NULL THEN 'tws_bloomberg' ELSE sector_source END,
        industry = COALESCE(NULLIF(industry,''), ?),
        exchange = COALESCE(?, exchange),
        ib_con_id = COALESCE(?, ib_con_id),
        name = CASE
                 WHEN ? IS NOT NULL AND (name IS NULL OR name = symbol) THEN ?
                 ELSE name
               END,
        security_type = CASE WHEN ? = 1 THEN 'ETF' ELSE security_type END
    WHERE id = ?
  `);

  const results: EnrichResult[] = [];

  for (const sec of securities) {
    try {
      await rateLimiter.waitForSlot();

      const contract = buildContract(sec);
      if (!contract) {
        results.push({
          symbol: sec.symbol,
          securityId: sec.id,
          enriched: false,
          error: "Cannot build TWS contract from symbol",
        });
        continue;
      }

      const details = await api.getContractDetails(contract);

      if (details.length > 0) {
        const detail = details[0];
        const rawSector = detail.industry ?? null;
        const sector = normalizeSector(rawSector);
        const industry = detail.category ?? rawSector ?? null;
        const exchange = detail.contract?.primaryExch ?? null;
        const conId = detail.contract?.conId ?? null;
        const longName = detail.longName?.trim() || null;
        const retypeAsEtf = shouldRetypeAsEtf(sec.security_type, detail.stockType);

        updateSecurity.run(
          sector,
          sector,
          industry,
          exchange,
          conId,
          longName,
          longName,
          retypeAsEtf ? 1 : 0,
          sec.id,
        );

        results.push({
          symbol: sec.symbol,
          securityId: sec.id,
          enriched: true,
          sector: sector ?? undefined,
          industry: industry ?? undefined,
          exchange: exchange ?? undefined,
          conId: conId ?? undefined,
          retypedToEtf: retypeAsEtf,
        });
      } else {
        results.push({
          symbol: sec.symbol,
          securityId: sec.id,
          enriched: false,
        });
      }
    } catch (err) {
      results.push({
        symbol: sec.symbol,
        securityId: sec.id,
        enriched: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return results;
}
