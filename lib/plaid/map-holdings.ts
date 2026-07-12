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

// Plaid sometimes labels an option position with the UNDERLYING's type
// ("etf" for an MTUM put) and an unpadded OCC-ish ticker instead of
// type "derivative" + option_contract (observed live 2026-07-11). Detect
// the OCC shape in the ticker itself so those positions still normalize
// to the canonical padded Option symbol instead of becoming duplicate
// mistyped securities.
const OCC_SHAPE = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/;

function parseOccShapedTicker(symbol: string): {
  padded: string;
  underlying: string;
  expirationDate: string;
  optionType: "CALL" | "PUT";
  strikePrice: number;
} | null {
  const m = OCC_SHAPE.exec(symbol.replace(/\s+/g, ""));
  if (!m) return null;
  const [, underlying, yymmdd, cp, strikeRaw] = m;
  return {
    padded: underlying.padEnd(6, " ") + yymmdd + cp + strikeRaw,
    underlying,
    expirationDate: `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`,
    optionType: cp === "C" ? "CALL" : "PUT",
    strikePrice: parseInt(strikeRaw, 10) / 1000,
  };
}

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
    if (sec.is_cash_equivalent === true || plaidType === "cash" || sec.ticker_symbol?.trim() === "VMFXX") {
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
    const occ = parseOccShapedTicker(resolved.symbol);
    if (occ) {
      result.positions.push({
        plaidAccountId: h.account_id,
        symbol: occ.padded,
        name: sec.name,
        securityType: "Option",
        quantity: h.quantity,
        underlyingSymbol: occ.underlying,
        strikePrice: occ.strikePrice,
        expirationDate: occ.expirationDate,
        optionType: occ.optionType,
      });
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
