import { describe, it, expect } from "vitest";
import { detectSourceType } from "@/lib/import/detect";

describe("file format detection", () => {
  it("detects IBKR activity CSV", () => {
    const content = `Statement,Header,Field Name,Field Value
Statement,Data,BrokerName,Interactive Brokers LLC
Statement,Data,Title,Activity Statement`;
    expect(detectSourceType(content, "IBKR 2025-01 activity.csv")).toBe("ibkr-activity");
  });

  it("detects IBKR holdings CSV", () => {
    const content = `account,symbol,name,type,quantity,price,cost_basis,balance
ibkr,SPY,SPDR S&P 500 ETF TRUST,ETF,100,600,47000,60000`;
    expect(detectSourceType(content, "holdings_current.csv")).toBe("ibkr-holdings");
  });

  it("detects Vanguard cost basis CSV", () => {
    const content = `symbol,name,type,account,cost_basis_method,quantity,cost_per_share,total_cost,market_value,short_term_gain_loss,long_term_gain_loss,total_gain_loss,percent_gain_loss
VEMBX,Vanguard Emerging Markets Bond,Mutual Fund,Brokerage,MinTax,400.000,,4000.00,3900.00,10.00,-110.00,-100.00,-2.50%`;
    expect(detectSourceType(content, "vanguard_cost_basis.csv")).toBe("vanguard-cost-basis");
  });

  it("detects Vanguard holdings CSV", () => {
    const content = `symbol,name,type,price,quantity,value
VMFXX,Vanguard Federal Money Market Fund,Settlement Fund,1.00,8000.00,8000.00`;
    expect(detectSourceType(content, "vanguard_holdings.csv")).toBe("vanguard-holdings");
  });

  it("detects monthly values CSV", () => {
    const content = `date,month,year,ibkr
2024-12-31,12,2024,250000.125
2025-01-31,1,2025,260000.00`;
    expect(detectSourceType(content, "monthly_values.csv")).toBe("monthly-values");
  });

  it("detects PDF files by magic bytes", () => {
    const content = "%PDF-1.4 rest of pdf content";
    expect(detectSourceType(content, "statement.pdf")).toBe("vanguard-pdf");
  });

  it("returns unknown for unrecognized format", () => {
    const content = "some,random,data\n1,2,3";
    expect(detectSourceType(content, "random.csv")).toBe("unknown");
  });
});
