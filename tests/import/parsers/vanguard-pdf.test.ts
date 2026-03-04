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
      const dividends = result.transactions.filter((t) => t.type === "dividend");
      expect(dividends.length).toBe(3);

      const vnqDiv = dividends.find((t) => t.symbol === "VNQ");
      expect(vnqDiv).toBeTruthy();
      expect(vnqDiv!.amount).toBe(15.23);
      expect(vnqDiv!.tradeDate).toBe("2025-01-02");
    });

    it("parses buy transactions", () => {
      const buys = result.transactions.filter((t) => t.type === "buy");
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
        (t) => t.type === "reinvestment"
      );
      expect(reinvestments.length).toBe(3);
    });

    it("parses foreign tax withheld", () => {
      const taxWithheld = result.transactions.filter(
        (t) => t.type === "tax_withheld"
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
        (t) => t.symbol === "PLTR" && t.type === "buy"
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
