import type Database from "better-sqlite3";
import { SecType } from "@stoqey/ib";
import { getIbApi } from "./client";
import { RateLimiter } from "./rate-limiter";
import type { EnrichResult } from "./types";

const rateLimiter = new RateLimiter();

interface SecurityRow {
  id: number;
  symbol: string;
  security_type: string | null;
}

function mapSecurityType(dbType: string | null): SecType {
  switch (dbType?.toLowerCase()) {
    case "stock":
    case "etf":
      return SecType.STK;
    case "bond":
      return SecType.BOND;
    case "mutual_fund":
    case "mutual fund":
      return SecType.FUND;
    case "option":
      return SecType.OPT;
    default:
      return SecType.STK;
  }
}

/**
 * Enrich securities with contract details from TWS.
 *
 * Fetches industry, category, exchange, and conId for each security.
 * Only fetches securities that don't already have an ib_con_id.
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
        `SELECT id, symbol, security_type FROM securities WHERE id IN (${placeholders})`,
      )
      .all(...securityIds) as SecurityRow[];
  } else {
    // Only enrich held securities that TWS can resolve by ticker.
    // Excluded (need special handling in the future):
    //   - CUSIP-prefixed: bonds/SPACs without tickers → look up by CUSIP + SecType.BOND
    //   - Vanguard-format options ("ARKK 270115 P 100.00") → convert to OCC format
    //   - OCC options with spaces → trim and use SecType.OPT
    //   - Cash positions (AUD, etc.) → use SecType.CASH
    securities = db
      .prepare(
        `SELECT DISTINCT s.id, s.symbol, s.security_type
         FROM securities s
         JOIN holdings h ON h.security_id = s.id
         WHERE s.ib_con_id IS NULL
           AND s.symbol NOT LIKE 'CUSIP:%'
           AND LOWER(s.security_type) NOT IN ('cash', 'option', 'money_market', 'money market')
           AND s.symbol NOT LIKE '% %'`,
      )
      .all() as SecurityRow[];
  }

  const updateSecurity = db.prepare(`
    UPDATE securities
    SET sector = COALESCE(?, sector),
        industry = COALESCE(?, industry),
        exchange = COALESCE(?, exchange),
        ib_con_id = COALESCE(?, ib_con_id)
    WHERE id = ?
  `);

  const results: EnrichResult[] = [];

  for (const sec of securities) {
    try {
      await rateLimiter.waitForSlot();

      const contract = {
        symbol: sec.symbol,
        secType: mapSecurityType(sec.security_type),
        exchange: "SMART",
        currency: "USD",
      };

      const details = await api.getContractDetails(contract);

      if (details.length > 0) {
        const detail = details[0];
        const sector = detail.industry ?? null;
        const industry = detail.category ?? null;
        const exchange = detail.contract?.primaryExch ?? null;
        const conId = detail.contract?.conId ?? null;

        updateSecurity.run(sector, industry, exchange, conId, sec.id);

        results.push({
          symbol: sec.symbol,
          securityId: sec.id,
          enriched: true,
          sector: sector ?? undefined,
          industry: industry ?? undefined,
          exchange: exchange ?? undefined,
          conId: conId ?? undefined,
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
