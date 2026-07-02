/**
 * Map IBKR Web API raw position rows → a normalized shape ready for the holdings
 * upsert. Field shapes verified live: option metadata (strike/expiry/right/
 * multiplier) is NOT in the top-level fields (they return null/0) — it's embedded
 * in `contractDesc` as `... [<OCC> <multiplier>]`, so we parse the OCC out.
 *
 * cost_basis = position × avgCost. IBKR's `avgCost` is per-unit INCLUDING the
 * multiplier (for options, avgCost = avgPrice × 100), so `position × avgCost`
 * gives the total basis for both stocks and options — matching the TWS path.
 */

import { parseOCCSymbol } from "../import/occ-symbol";

export interface RawPosition {
  acctId?: string;
  assetClass?: string;
  conid?: number;
  contractDesc?: string;
  currency?: string;
  position?: number;
  avgCost?: number;
  avgPrice?: number;
  mktPrice?: number;
  mktValue?: number;
  [k: string]: unknown;
}

export interface MappedPosition {
  symbol: string;
  securityType: string;
  assetClass: string;
  underlyingSymbol?: string;
  strikePrice?: number;
  expirationDate?: string;
  optionType?: "CALL" | "PUT";
  multiplier?: number;
  conid: number | null;
  quantity: number;
  avgCost: number;
  costBasis: number | null;
  mktPrice: number | null;
  mktValue: number | null;
  currency: string;
}

/** USD per 1 unit of the position's local currency, from the broker's own USD
 *  market value. Returns null when inputs are missing/≤0 (caller skips fx write). */
export function deriveUsdPerUnit(
  mktValueUsd: number | null,
  mktPriceLocal: number | null,
  quantity: number,
  multiplier: number = 1,
): number | null {
  if (!mktValueUsd || !mktPriceLocal || !quantity) return null;
  const localNotional = mktPriceLocal * quantity * (multiplier || 1);
  if (localNotional <= 0) return null;
  const rate = mktValueUsd / localNotional;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

const ASSET_CLASS_TO_TYPE: Record<string, string> = {
  STK: "Stock",
  OPT: "Option",
  FOP: "Option",
  WAR: "Warrant",
  BOND: "Bond",
  BILL: "Bond",
  FUND: "Mutual Fund",
  FUT: "Future",
  CASH: "Cash",
};

/** Extract the OCC symbol + multiplier from an option `contractDesc` bracket. */
export function extractOccFromContractDesc(
  contractDesc: string,
): { occ: string; multiplier: number } | null {
  // "HACK   JUN2026 100 P [HACK  260618P00100000 100]"
  const m = /\[(.{21})\s+(\d+)\]\s*$/.exec(contractDesc);
  if (!m) return null;
  return { occ: m[1], multiplier: parseInt(m[2], 10) };
}

export function mapPosition(raw: RawPosition): MappedPosition {
  const assetClass = (raw.assetClass ?? "STK").toUpperCase();
  const securityType = ASSET_CLASS_TO_TYPE[assetClass] ?? "Stock";
  const quantity = raw.position ?? 0;
  const avgCost = raw.avgCost ?? 0;
  const costBasis = avgCost ? quantity * avgCost : null;
  const conid = typeof raw.conid === "number" ? raw.conid : null;
  const mktPrice = typeof raw.mktPrice === "number" ? raw.mktPrice : null;
  const mktValue = typeof raw.mktValue === "number" ? raw.mktValue : null;
  const contractDesc = raw.contractDesc ?? "";
  // Guard against an empty-string broker currency (`??` alone only catches
  // null/undefined) — treat it the same as missing and default to USD.
  const currency = (raw.currency && raw.currency.trim() ? raw.currency : "USD").toUpperCase();

  if (securityType === "Option") {
    const extracted = extractOccFromContractDesc(contractDesc);
    if (extracted) {
      const parsed = parseOCCSymbol(extracted.occ);
      if (parsed) {
        return {
          symbol: extracted.occ,
          securityType: "Option",
          assetClass,
          underlyingSymbol: parsed.underlying,
          strikePrice: parsed.strike,
          expirationDate: parsed.expirationDate,
          optionType: parsed.optionType,
          multiplier: extracted.multiplier,
          conid,
          quantity,
          avgCost,
          costBasis,
          mktPrice,
          mktValue,
          currency,
        };
      }
    }
    // Fall through: option we couldn't parse — keep the raw desc as symbol.
  }

  return {
    symbol: contractDesc.trim() || `conid:${conid}`,
    securityType,
    assetClass,
    conid,
    quantity,
    avgCost,
    costBasis,
    mktPrice,
    mktValue,
    currency,
  };
}
