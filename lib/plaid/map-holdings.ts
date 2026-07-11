import { ensureOCCSymbol } from "@/lib/import/occ-symbol";
import { isGarbageSymbol } from "@/lib/import/validate";
import type { PlaidHoldingsResponse, PlaidSecurity } from "./client";

export interface MappedPlaidPosition {
  plaidAccountId: string;
  symbol: string;
  name: string | null;
  securityType: string;
  quantity: number;
  underlyingSymbol?: string;
  strikePrice?: number;
  expirationDate?: string;
  optionType?: "CALL" | "PUT";
}

export interface UnmatchedPlaidSecurity {
  name: string | null;
  reason: string;
}

export interface MutualFundPrice {
  plaidAccountId: string;
  symbol: string;
  price: number;
  asOf: string | null;
}

export interface PlaidMapResult {
  positions: MappedPlaidPosition[];
  cashByAccount: Record<string, number>;
  totalByAccount: Record<string, number | null>;
  unmatched: UnmatchedPlaidSecurity[];
  mutualFundPrices: MutualFundPrice[];
}

const TYPE_MAP: Record<string, string> = {
  equity: "Stock",
  etf: "ETF",
  "mutual fund": "Mutual Fund",
  "fixed income": "Bond",
  derivative: "Option",
};

function resolveSymbol(sec: PlaidSecurity): { symbol: string } | { reason: string } {
  const ticker = sec.ticker_symbol?.trim();
  if (ticker && !isGarbageSymbol(ticker)) return { symbol: ticker };
  const cusip = sec.cusip?.trim();
  // Bonds store CUSIP as securities.symbol in this codebase.
  if (cusip && !isGarbageSymbol(cusip)) return { symbol: cusip };
  return { reason: ticker || cusip ? "garbage symbol" : "no ticker or cusip" };
}

export function mapPlaidHoldings(resp: PlaidHoldingsResponse): PlaidMapResult {
  const secById = new Map(resp.securities.map((s) => [s.security_id, s]));
  const result: PlaidMapResult = {
    positions: [],
    cashByAccount: {},
    totalByAccount: {},
    unmatched: [],
    mutualFundPrices: [],
  };
  for (const a of resp.accounts) result.totalByAccount[a.account_id] = a.balances.current;

  for (const h of resp.holdings) {
    if (h.quantity === 0) continue;
    const sec = secById.get(h.security_id);
    if (!sec) {
      result.unmatched.push({ name: h.security_id, reason: "security not in response" });
      continue;
    }
    const plaidType = (sec.type ?? "").toLowerCase();

    // Settlement fund / cash equivalents fold into cash, never a position.
    if (sec.is_cash_equivalent === true || sec.ticker_symbol?.trim() === "VMFXX") {
      if (h.institution_value != null) {
        result.cashByAccount[h.account_id] =
          (result.cashByAccount[h.account_id] ?? 0) + h.institution_value;
      }
      continue;
    }

    if (plaidType === "derivative") {
      const oc = sec.option_contract;
      if (!oc) {
        result.unmatched.push({ name: sec.name, reason: "derivative without option_contract" });
        continue;
      }
      const underlying = oc.underlying_security_ticker?.trim() || undefined;
      const optionType = oc.contract_type.toUpperCase() as "CALL" | "PUT";
      const symbol = ensureOCCSymbol(
        sec.ticker_symbol?.trim() || underlying || "",
        underlying,
        oc.expiration_date,
        optionType,
        oc.strike_price,
      );
      if (!symbol || isGarbageSymbol(symbol)) {
        result.unmatched.push({ name: sec.name, reason: "option missing OCC inputs" });
        continue;
      }
      result.positions.push({
        plaidAccountId: h.account_id,
        symbol,
        name: sec.name,
        securityType: "Option",
        quantity: h.quantity,
        underlyingSymbol: underlying,
        strikePrice: oc.strike_price,
        expirationDate: oc.expiration_date,
        optionType,
      });
      continue;
    }

    const resolved = resolveSymbol(sec);
    if ("reason" in resolved) {
      result.unmatched.push({ name: sec.name, reason: resolved.reason });
      continue;
    }
    const securityType =
      TYPE_MAP[plaidType] ?? (plaidType ? plaidType[0].toUpperCase() + plaidType.slice(1) : "Stock");
    result.positions.push({
      plaidAccountId: h.account_id,
      symbol: resolved.symbol,
      name: sec.name,
      securityType,
      quantity: h.quantity,
    });
    if (plaidType === "mutual fund" && h.institution_price != null) {
      result.mutualFundPrices.push({
        plaidAccountId: h.account_id,
        symbol: resolved.symbol,
        price: h.institution_price,
        asOf: h.institution_price_as_of,
      });
    }
  }
  return result;
}
