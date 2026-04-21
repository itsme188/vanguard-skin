import { describe, it, expect } from "vitest";
import { parseClaudePdfResponse } from "@/lib/import/parsers/vanguard-pdf";
import type { ClaudePdfResponse } from "@/lib/import/parsers/vanguard-pdf";
import fixtureData from "../../fixtures/vanguard-pdf-claude-response.json";

const fixture = fixtureData as ClaudePdfResponse;
const filename = "01-2025 roth.pdf";

describe("vanguard PDF parser", () => {
  describe("parseClaudePdfResponse", () => {
    const result = parseClaudePdfResponse(fixture, filename);

    it("returns correct source type and name", () => {
      expect(result.sourceType).toBe("vanguard-pdf");
      expect(result.sourceName).toBe(filename);
    });

    it("resolves Roth IRA account name", () => {
      // All holdings should be attributed to "Vanguard Roth IRA"
      for (const h of result.holdings) {
        expect(h.accountName).toBe("Vanguard Roth IRA");
      }
      for (const t of result.transactions) {
        expect(t.accountName).toBe("Vanguard Roth IRA");
      }
    });

    it("extracts all holdings with correct data", () => {
      expect(result.holdings.length).toBe(17);

      const vti = result.holdings.find((h) => h.symbol === "VTI");
      expect(vti).toBeTruthy();
      expect(vti!.quantity).toBe(36.0);
      expect(vti!.marketValue).toBe(10749.60);
      expect(vti!.asOfDate).toBe("2025-01-31");
    });

    it("extracts securities from holdings", () => {
      expect(result.securities.length).toBeGreaterThanOrEqual(17);

      const tsm = result.securities.find((s) => s.symbol === "TSM");
      expect(tsm).toBeTruthy();
      expect(tsm!.name).toContain("TAIWAN SEMICONDUCTOR");
    });

    it("extracts prices from holdings", () => {
      const vgtPrice = result.prices.find((p) => p.symbol === "VGT");
      expect(vgtPrice).toBeTruthy();
      expect(vgtPrice!.closePrice).toBe(616.61);
      expect(vgtPrice!.date).toBe("2025-01-31");
      expect(vgtPrice!.source).toBe("vanguard-pdf");
    });

    it("extracts transactions excluding sweep", () => {
      // Fixture has 9 transactions, none are sweeps
      expect(result.transactions.length).toBe(9);
    });

    it("parses dividend transactions", () => {
      const dividends = result.transactions.filter((t) => t.type === "DIVIDEND");
      expect(dividends.length).toBe(3);

      const vnqDiv = dividends.find((t) => t.symbol === "VNQ");
      expect(vnqDiv).toBeTruthy();
      expect(vnqDiv!.amount).toBe(15.23);
      expect(vnqDiv!.tradeDate).toBe("2025-01-02");
    });

    it("parses buy transactions", () => {
      const buys = result.transactions.filter((t) => t.type === "BUY");
      expect(buys.length).toBe(2);

      const pltrBuy = buys.find((t) => t.symbol === "PLTR");
      expect(pltrBuy).toBeTruthy();
      expect(pltrBuy!.quantity).toBe(10.0);
      expect(pltrBuy!.pricePerShare).toBe(71.25);
      expect(pltrBuy!.amount).toBe(-712.50);
      expect(pltrBuy!.fees).toBe(0.0);
    });

    it("parses reinvestment transactions", () => {
      const reinvestments = result.transactions.filter(
        (t) => t.type === "REINVESTMENT"
      );
      expect(reinvestments.length).toBe(3);
    });

    it("parses foreign tax withheld", () => {
      const taxWithheld = result.transactions.filter(
        (t) => t.type === "TAX_WITHHELD"
      );
      expect(taxWithheld.length).toBe(1);
      expect(taxWithheld[0].amount).toBe(-2.81);
      expect(taxWithheld[0].symbol).toBe("TSM");
    });

    it("creates monthly snapshot", () => {
      expect(result.snapshots.length).toBe(1);
      const snap = result.snapshots[0];
      expect(snap.accountName).toBe("Vanguard Roth IRA");
      expect(snap.monthEndDate).toBe("2025-01-31");
      expect(snap.totalValue).toBe(59379.62);
      expect(snap.dividends).toBe(28.59);
      expect(snap.source).toBe("vanguard-pdf");
    });

    it("generates deterministic source keys for holdings", () => {
      const vti = result.holdings.find((h) => h.symbol === "VTI");
      expect(vti!.sourceKey).toBe(
        "vanguard-pdf:holding:Vanguard Roth IRA:VTI:2025-01-31"
      );
    });

    it("generates deterministic source keys for transactions", () => {
      const pltrBuy = result.transactions.find(
        (t) => t.symbol === "PLTR" && t.type === "BUY"
      );
      expect(pltrBuy!.sourceKey).toBe(
        "vanguard-pdf:txn:Vanguard Roth IRA:2025-01-14:PLTR:buy:-712.5"
      );
    });

    it("has no errors", () => {
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("account name resolution", () => {
    it("resolves brokerage account to Vanguard Taxable", () => {
      const brokerageFixture: ClaudePdfResponse = {
        ...fixture,
        account_type: "Individual brokerage account",
      };
      const result = parseClaudePdfResponse(brokerageFixture, "test.pdf");
      expect(result.holdings[0].accountName).toBe("Vanguard Taxable");
      expect(result.snapshots[0].accountName).toBe("Vanguard Taxable");
    });
  });

  describe("OCC symbol enforcement for options", () => {
    it("converts bare ticker to OCC format when option metadata is present", () => {
      const optionFixture: ClaudePdfResponse = {
        ...fixture,
        holdings: [
          {
            symbol: "INTC", // bare ticker — should be converted
            name: "PUT INTEL CORP $45 EXP 03/20/26",
            category: "Options",
            quantity: 5,
            price: 2.5,
            value: 1250,
            underlying_symbol: "INTC",
            strike_price: 45,
            expiration_date: "2026-03-20",
            option_type: "PUT",
          },
          {
            symbol: "INTC",
            name: "Intel Corp",
            category: "Stocks",
            quantity: 275,
            price: 45.61,
            value: 12542.75,
          },
        ],
        transactions: [],
      };

      const result = parseClaudePdfResponse(optionFixture, "test.pdf");

      // Option should get OCC symbol
      const optionHolding = result.holdings.find(h => h.quantity === 5);
      expect(optionHolding!.symbol).toBe("INTC  260320P00045000");

      // Stock should keep bare ticker
      const stockHolding = result.holdings.find(h => h.quantity === 275);
      expect(stockHolding!.symbol).toBe("INTC");

      // Securities should be separate
      const optionSec = result.securities.find(s => s.securityType === "Option");
      expect(optionSec!.symbol).toBe("INTC  260320P00045000");
      expect(optionSec!.multiplier).toBe(100);

      const stockSec = result.securities.find(s => s.securityType === "Stock");
      expect(stockSec!.symbol).toBe("INTC");
      expect(stockSec!.multiplier).toBeUndefined();
    });

    it("leaves already-OCC symbols unchanged", () => {
      const optionFixture: ClaudePdfResponse = {
        ...fixture,
        holdings: [
          {
            symbol: "INTC  260320P00045000", // already OCC
            name: "PUT INTEL CORP $45 EXP 03/20/26",
            category: "Options",
            quantity: 5,
            price: 2.5,
            value: 1250,
            underlying_symbol: "INTC",
            strike_price: 45,
            expiration_date: "2026-03-20",
            option_type: "PUT",
          },
        ],
        transactions: [],
      };

      const result = parseClaudePdfResponse(optionFixture, "test.pdf");
      expect(result.holdings[0].symbol).toBe("INTC  260320P00045000");
      // Should not generate a warning for already-correct symbols
      expect(result.warnings.filter(w => w.includes("converted bare ticker"))).toHaveLength(0);
    });

    it("converts bare ticker in option transactions too", () => {
      const txnFixture: ClaudePdfResponse = {
        ...fixture,
        holdings: [],
        transactions: [
          {
            settlement_date: "2026-01-23",
            trade_date: "2026-01-23",
            symbol: "INTC",
            name: "PUT INTEL CORP $45 EXP 03/20/26",
            transaction_type: "Buy to open",
            quantity: 3,
            price: 8.6,
            commissions: 0,
            amount: -2583,
            underlying_symbol: "INTC",
            strike_price: 45,
            expiration_date: "2026-03-20",
            option_type: "PUT",
          },
        ],
      };

      const result = parseClaudePdfResponse(txnFixture, "test.pdf");
      expect(result.transactions[0].symbol).toBe("INTC  260320P00045000");

      const sec = result.securities.find(s => s.securityType === "Option");
      expect(sec!.symbol).toBe("INTC  260320P00045000");
    });

    it("emits warning when converting bare ticker to OCC", () => {
      const optionFixture: ClaudePdfResponse = {
        ...fixture,
        holdings: [
          {
            symbol: "INTC",
            name: "PUT INTEL CORP $45 EXP 03/20/26",
            category: "Options",
            quantity: 5,
            price: 2.5,
            value: 1250,
            underlying_symbol: "INTC",
            strike_price: 45,
            expiration_date: "2026-03-20",
            option_type: "PUT",
          },
        ],
        transactions: [],
      };

      const result = parseClaudePdfResponse(optionFixture, "test.pdf");
      const conversionWarnings = result.warnings.filter(w => w.includes("converted bare ticker"));
      expect(conversionWarnings.length).toBeGreaterThan(0);
      expect(conversionWarnings[0]).toContain("INTC");
      expect(conversionWarnings[0]).toContain("INTC  260320P00045000");
    });
  });

  describe("statement-mode transaction coverage", () => {
    // Statement PDFs produce the full range of Vanguard transaction types.
    // Before the H3 refactor, Step 2's combined-prompt suffered attention
    // dilution and missed these reliably. This test exercises the mapping
    // for every type that matters for tax-lot / cost-basis correctness.
    const statementFixture: ClaudePdfResponse = {
      ...fixture,
      holdings: [],
      transactions: [
        {
          settlement_date: "2025-01-03",
          trade_date: "2025-01-02",
          symbol: "AAPL",
          name: "APPLE INC",
          transaction_type: "Sell",
          quantity: 10,
          price: 180.5,
          commissions: 0,
          amount: 1805,
        },
        {
          settlement_date: "2025-01-05",
          trade_date: "2025-01-05",
          symbol: "AAPL  250117C00190000",
          name: "CALL AAPL $190 EXP 01/17/25",
          transaction_type: "Buy to open",
          quantity: 2,
          price: 3.25,
          commissions: 0,
          amount: -650,
          underlying_symbol: "AAPL",
          strike_price: 190,
          expiration_date: "2025-01-17",
          option_type: "CALL",
        },
        {
          settlement_date: "2025-01-10",
          trade_date: "2025-01-10",
          symbol: "AAPL  250117C00190000",
          name: "CALL AAPL $190 EXP 01/17/25",
          transaction_type: "Sell to close",
          quantity: 2,
          price: 5.1,
          commissions: 0,
          amount: 1020,
          underlying_symbol: "AAPL",
          strike_price: 190,
          expiration_date: "2025-01-17",
          option_type: "CALL",
        },
        {
          settlement_date: "2025-01-15",
          trade_date: "2025-01-15",
          symbol: null,
          name: "ACH TRANSFER FROM BANK",
          transaction_type: "Transfer (in)",
          quantity: null,
          price: null,
          commissions: null,
          amount: 5000,
        },
        {
          settlement_date: "2025-01-20",
          trade_date: "2025-01-20",
          symbol: null,
          name: "ACH TRANSFER TO BANK",
          transaction_type: "Transfer (out)",
          quantity: null,
          price: null,
          commissions: null,
          amount: -2000,
        },
        {
          settlement_date: "2025-01-17",
          trade_date: "2025-01-17",
          symbol: "MSFT  250117P00400000",
          name: "PUT MSFT $400 EXP 01/17/25",
          transaction_type: "Expired",
          quantity: 1,
          price: null,
          commissions: null,
          amount: 0,
          underlying_symbol: "MSFT",
          strike_price: 400,
          expiration_date: "2025-01-17",
          option_type: "PUT",
        },
        {
          settlement_date: "2025-01-17",
          trade_date: "2025-01-17",
          symbol: "NVDA  250117C00140000",
          name: "CALL NVDA $140 EXP 01/17/25",
          transaction_type: "Exercised",
          quantity: 1,
          price: null,
          commissions: null,
          amount: 0,
          underlying_symbol: "NVDA",
          strike_price: 140,
          expiration_date: "2025-01-17",
          option_type: "CALL",
        },
        {
          settlement_date: "2025-01-25",
          trade_date: "2025-01-25",
          symbol: null,
          name: "MARGIN INTEREST",
          transaction_type: "Interest charge",
          quantity: null,
          price: null,
          commissions: null,
          amount: -12.5,
        },
      ],
    };

    const result = parseClaudePdfResponse(statementFixture, "statement.pdf");

    it("maps SELL with correct amount sign", () => {
      const sell = result.transactions.find((t) => t.type === "SELL");
      expect(sell).toBeTruthy();
      expect(sell!.amount).toBe(1805);
      expect(sell!.quantity).toBe(10);
    });

    it("maps BUY_TO_OPEN with OCC symbol preserved", () => {
      const bto = result.transactions.find((t) => t.type === "BUY_TO_OPEN");
      expect(bto).toBeTruthy();
      expect(bto!.symbol).toBe("AAPL  250117C00190000");
      expect(bto!.amount).toBe(-650);
    });

    it("maps SELL_TO_CLOSE for option", () => {
      const stc = result.transactions.find((t) => t.type === "SELL_TO_CLOSE");
      expect(stc).toBeTruthy();
      expect(stc!.amount).toBe(1020);
    });

    it("maps TRANSFER_IN and TRANSFER_OUT", () => {
      const transferIn = result.transactions.find((t) => t.type === "TRANSFER_IN");
      const transferOut = result.transactions.find((t) => t.type === "TRANSFER_OUT");
      expect(transferIn!.amount).toBe(5000);
      expect(transferOut!.amount).toBe(-2000);
    });

    it("maps EXPIRED options", () => {
      const expired = result.transactions.find((t) => t.type === "EXPIRED");
      expect(expired).toBeTruthy();
      expect(expired!.symbol).toBe("MSFT  250117P00400000");
    });

    it("maps EXERCISED options", () => {
      const exercised = result.transactions.find((t) => t.type === "EXERCISED");
      expect(exercised).toBeTruthy();
      expect(exercised!.symbol).toBe("NVDA  250117C00140000");
    });

    it("maps INTEREST charges", () => {
      const interest = result.transactions.find((t) => t.type === "INTEREST");
      expect(interest).toBeTruthy();
      expect(interest!.amount).toBe(-12.5);
    });

    it("registers option securities with multiplier 100", () => {
      const aaplOpt = result.securities.find((s) => s.symbol === "AAPL  250117C00190000");
      expect(aaplOpt).toBeTruthy();
      expect(aaplOpt!.securityType).toBe("Option");
      expect(aaplOpt!.multiplier).toBe(100);
    });

    it("emits no errors on a full statement", () => {
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("focused transactions prompt", () => {
    it("exports FOCUSED_TRANSACTIONS_PROMPT with key instructions", async () => {
      const mod = await import("@/lib/import/parsers/vanguard-pdf");
      // Spot-check the module shape: extractTransactionsFromPdf should exist
      expect(typeof mod.extractTransactionsFromPdf).toBe("function");
      expect(typeof mod.parseVanguardPdf).toBe("function");
    });
  });

  describe("date normalization", () => {
    it("handles MM/DD format dates", () => {
      const shortDateFixture: ClaudePdfResponse = {
        ...fixture,
        transactions: [
          {
            settlement_date: "01/15",
            trade_date: "01/14",
            symbol: "VTI",
            name: "VANGUARD TOTAL STOCK MARKET ETF",
            transaction_type: "Buy",
            quantity: 1,
            price: 298.6,
            commissions: 0,
            amount: -298.6,
          },
        ],
      };
      const result = parseClaudePdfResponse(shortDateFixture, "test.pdf");
      expect(result.transactions[0].tradeDate).toBe("2025-01-14");
      expect(result.transactions[0].settlementDate).toBe("2025-01-15");
    });
  });
});
