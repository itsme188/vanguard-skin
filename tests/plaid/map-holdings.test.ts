import { describe, it, expect } from "vitest";
import { mapPlaidHoldings } from "@/lib/plaid/map-holdings";
import type { PlaidHoldingsResponse } from "@/lib/plaid/client";

function baseResp(): PlaidHoldingsResponse {
  return {
    accounts: [
      {
        account_id: "acctA",
        name: "Brokerage",
        mask: "1234",
        subtype: "brokerage",
        balances: { current: 250000, available: null },
      },
    ],
    holdings: [
      { account_id: "acctA", security_id: "s-eq", quantity: 100, institution_price: 50, institution_value: 5000, institution_price_as_of: "2026-07-09" },
      { account_id: "acctA", security_id: "s-mf", quantity: 200, institution_price: 87.31, institution_value: 17462, institution_price_as_of: "2026-07-09" },
      { account_id: "acctA", security_id: "s-mm", quantity: 12000, institution_price: 1, institution_value: 12000, institution_price_as_of: "2026-07-09" },
      { account_id: "acctA", security_id: "s-opt", quantity: 2, institution_price: 11.2, institution_value: 2240, institution_price_as_of: "2026-07-09" },
      { account_id: "acctA", security_id: "s-bond", quantity: 10000, institution_price: 0.98, institution_value: 9800, institution_price_as_of: "2026-07-09" },
      { account_id: "acctA", security_id: "s-junk", quantity: 5, institution_price: 1, institution_value: 5, institution_price_as_of: null },
      { account_id: "acctA", security_id: "s-zero", quantity: 0, institution_price: 10, institution_value: 0, institution_price_as_of: null },
    ],
    securities: [
      { security_id: "s-eq", ticker_symbol: "PRIM", cusip: "74164F103", name: "Primoris", type: "equity", is_cash_equivalent: false },
      { security_id: "s-mf", ticker_symbol: "VWENX", cusip: null, name: "Wellington Admiral", type: "mutual fund", is_cash_equivalent: false },
      { security_id: "s-mm", ticker_symbol: "VMFXX", cusip: null, name: "Federal Money Market", type: "mutual fund", is_cash_equivalent: true },
      {
        security_id: "s-opt", ticker_symbol: null, cusip: null, name: "TER Mar 2027 Call", type: "derivative", is_cash_equivalent: false,
        option_contract: { contract_type: "call", expiration_date: "2027-03-19", strike_price: 100, underlying_security_ticker: "TER" },
      },
      { security_id: "s-bond", ticker_symbol: null, cusip: "912797GD5", name: "US T-Bill", type: "fixed income", is_cash_equivalent: false },
      { security_id: "s-junk", ticker_symbol: null, cusip: null, name: "Mystery Asset", type: "other", is_cash_equivalent: false },
      { security_id: "s-zero", ticker_symbol: "GONE", cusip: null, name: "Closed", type: "equity", is_cash_equivalent: false },
    ],
  };
}

describe("mapPlaidHoldings", () => {
  it("maps equity/mf/option/bond, folds cash, skips zero-qty, reports unmatched", () => {
    const r = mapPlaidHoldings(baseResp());
    const symbols = r.positions.map((p) => p.symbol);
    expect(symbols).toContain("PRIM");
    expect(symbols).toContain("VWENX");
    expect(symbols).toContain("912797GD5"); // CUSIP-as-symbol bond
    expect(symbols).not.toContain("VMFXX"); // folded into cash
    expect(symbols).not.toContain("GONE"); // zero quantity skipped
    expect(r.cashByAccount.acctA).toBe(12000);
    expect(r.totalByAccount.acctA).toBe(250000);
    expect(r.unmatched).toEqual([{ name: "Mystery Asset", reason: "no ticker or cusip" }]);
  });

  it("builds OCC symbols for options with contract metadata", () => {
    const r = mapPlaidHoldings(baseResp());
    const opt = r.positions.find((p) => p.securityType === "Option");
    expect(opt).toBeDefined();
    expect(opt!.symbol).toBe("TER   270319C00100000");
    expect(opt!.underlyingSymbol).toBe("TER");
    expect(opt!.optionType).toBe("CALL");
    expect(opt!.strikePrice).toBe(100);
    expect(opt!.expirationDate).toBe("2027-03-19");
  });

  it("collects mutual-fund prices only", () => {
    const r = mapPlaidHoldings(baseResp());
    expect(r.mutualFundPrices).toEqual([
      { plaidAccountId: "acctA", symbol: "VWENX", price: 87.31, asOf: "2026-07-09" },
    ]);
  });

  it("folds type:'cash' securities into cash, not position", () => {
    const resp: PlaidHoldingsResponse = {
      accounts: [
        {
          account_id: "acctB",
          name: "Brokerage",
          mask: "5678",
          subtype: "brokerage",
          balances: { current: 100000, available: null },
        },
      ],
      holdings: [
        {
          account_id: "acctB",
          security_id: "s-cash",
          quantity: 1,
          institution_price: 500,
          institution_value: 500,
          institution_price_as_of: "2026-07-09",
        },
      ],
      securities: [
        {
          security_id: "s-cash",
          ticker_symbol: "CUR:USD",
          cusip: null,
          name: "US Dollar",
          type: "cash",
          is_cash_equivalent: null,
        },
      ],
    };
    const r = mapPlaidHoldings(resp);
    expect(r.positions).toHaveLength(0);
    expect(r.cashByAccount.acctB).toBe(500);
  });
});
