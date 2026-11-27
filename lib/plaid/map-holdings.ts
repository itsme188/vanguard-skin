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

/**
 * The kind of a Plaid price. Both kinds are dated the same way since the
 * session-dating work (lib/plaid/refresh.ts, plan v4 A1): on the session the
 * pre-open read describes, the trading day before the run day. Plaid's
 * as-of date is never used as a date. The kind is kept so the mapper's
 * "stocks, ETFs and funds only" rule stays visible.
 */
export type InstitutionPriceKind = "equity" | "mutual_fund";

/** Vanguard's own price for a held stock, ETF or mutual fund. Never an option or bond. */
export interface InstitutionPrice {
  plaidAccountId: string;
  /** The SAME symbol the matching position carries, so both resolve to one security. */
  symbol: string;
  kind: InstitutionPriceKind;
  price: number;
  asOf: string | null;
}

/**
 * A money-market fund Plaid flags as cash. Its dollars stay in
 * `cashByAccount` (the snapshot's cash_value is unchanged); this entry only
 * lets the writer refresh the fund's own holdings row. Never a position.
 */
export interface CashEquivalentHolding {
  plaidAccountId: string;
  symbol: string;
  quantity: number;
}

export interface PlaidMapResult {
  positions: MappedPlaidPosition[];
  cashByAccount: Record<string, number>;
  totalByAccount: Record<string, number | null>;
  unmatched: UnmatchedPlaidSecurity[];
  institutionPrices: InstitutionPrice[];
  cashEquivalentHoldings: CashEquivalentHolding[];
}

/** Plaid security types whose institution_price is a per-share close on the `prices` basis. */
const PRICE_KIND_BY_PLAID_TYPE: Record<string, InstitutionPriceKind> = {
  equity: "equity",
  etf: "equity",
  "mutual fund": "mutual_fund",
};

function isUsablePrice(p: number | null): p is number {
  return typeof p === "number" && Number.isFinite(p) && p > 0;
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
    institutionPrices: [],
    cashEquivalentHoldings: [],
  };
  for (const a of resp.accounts) result.totalByAccount[a.account_id] = a.balances.current;

  for (const h of resp.holdings) {
    const sec = secById.get(h.security_id);
    const plaidType = (sec?.type ?? "").toLowerCase();
    // The VMFXX literal predates the shared identity rule
    // (lib/compute/cash-equivalents.ts). It cannot move onto that rule here:
    // the rule reads the stored security's fund_category, and this mapper
    // has no database. It only decides what lands in cash_value.
    const plaidSaysCash =
      sec != null &&
      (sec.is_cash_equivalent === true || plaidType === "cash" || sec.ticker_symbol?.trim() === "VMFXX");

    // A money-market fund reported at zero is evidence the balance is gone;
    // keep it (as a zero) so the writer can retire the fund's row. Every
    // other zero-quantity holding is skipped as before.
    if (h.quantity === 0 && !(plaidSaysCash && plaidType !== "cash")) continue;
    if (!sec) {
      result.unmatched.push({ name: h.security_id, reason: "security not in response" });
      continue;
    }

    // Settlement fund / cash equivalents fold into cash, never a position.
    if (plaidSaysCash) {
      // A zero row adds nothing, and must not turn an absent cash_value
      // (null) into 0.
      if (h.quantity !== 0 && h.institution_value != null) {
        result.cashByAccount[h.account_id] =
          (result.cashByAccount[h.account_id] ?? 0) + h.institution_value;
      }
      // A ticketed fund (not Plaid's generic "cash" line) also refreshes its
      // own holdings row — the writer decides, against the shared identity
      // rule, whether the row may be written.
      if (plaidType !== "cash") {
        const resolved = resolveSymbol(sec);
        if ("symbol" in resolved && Number.isFinite(h.quantity)) {
          result.cashEquivalentHoldings.push({
            plaidAccountId: h.account_id,
            symbol: resolved.symbol,
            quantity: h.quantity,
          });
        }
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
    // Options and bonds are left out on purpose: nothing in this repo proves
    // Plaid's price for them is on the basis `prices` stores (per-share
    // premium for an option, per-100-face for a bond), so a wrong-basis row
    // would mis-value the position by 100x. Only stocks, ETFs and funds.
    const kind = PRICE_KIND_BY_PLAID_TYPE[plaidType];
    if (kind && isUsablePrice(h.institution_price)) {
      result.institutionPrices.push({
        plaidAccountId: h.account_id,
        symbol: resolved.symbol,
        kind,
        price: h.institution_price,
        asOf: h.institution_price_as_of,
      });
    }
  }
  return result;
}
