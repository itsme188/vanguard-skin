import { describe, it, expect } from "vitest";
import { detectSourceType } from "@/lib/import/detect";
import { parseCanonicalCsv } from "@/lib/import/parsers/canonical-csv";

// ── Detection ───────────────────────────────────────────────────────

describe("canonical CSV detection", () => {
  it("detects canonical transactions CSV", () => {
    const content =
      "account,trade_date,settlement_date,type,symbol,security_name,security_type,quantity,price,amount,fees,notes\nIBKR,2025-06-15,,BUY,AAPL,Apple Inc,Stock,10,150,1500,0,";
    expect(detectSourceType(content, "txn-2025-06.csv")).toBe("canonical-csv");
  });

  it("detects canonical holdings CSV", () => {
    const content =
      "account,as_of_date,symbol,security_name,security_type,quantity,cost_basis,market_value\nIBKR,2025-06-30,AAPL,Apple Inc,Stock,100,15000,19500";
    expect(detectSourceType(content, "holdings-2025-06.csv")).toBe(
      "canonical-csv"
    );
  });

  it("detects canonical prices CSV", () => {
    const content = "symbol,date,close_price\nAAPL,2025-06-30,195.00";
    expect(detectSourceType(content, "prices.csv")).toBe("canonical-csv");
  });

  it("detects canonical snapshots CSV", () => {
    const content =
      "account,month_end_date,total_value,starting_value,deposits_withdrawals,dividends,interest,commissions,fees,investment_gain,twr\nIBKR,2025-06-30,250000,245000,2000,150,25,-15,-10,2850,0.0116";
    expect(detectSourceType(content, "snapshots-2025.csv")).toBe(
      "canonical-csv"
    );
  });

  it("does not collide with IBKR holdings detection", () => {
    const content =
      "account,symbol,name,type,quantity,price,cost_basis,balance\nibkr,SPY,SPDR,ETF,100,600,47000,60000";
    expect(detectSourceType(content, "ibkr.csv")).toBe("ibkr-holdings");
  });
});

// ── Transactions parser ─────────────────────────────────────────────

describe("canonical transactions parser", () => {
  const header =
    "account,trade_date,settlement_date,type,symbol,security_name,security_type,quantity,price,amount,fees,notes";

  it("parses basic transactions", () => {
    const csv = `${header}
Vanguard Taxable,2025-06-15,,BUY,AAPL,Apple Inc,Stock,10,150.25,1502.50,4.95,
Vanguard Taxable,2025-06-20,,DIVIDEND,AAPL,Apple Inc,Stock,,,25.00,,Q2 dividend`;

    const result = parseCanonicalCsv(csv, "txn.csv");

    expect(result.sourceType).toBe("canonical-csv");
    expect(result.transactions).toHaveLength(2);
    expect(result.securities).toHaveLength(1);
    expect(result.holdings).toHaveLength(0);

    const buy = result.transactions[0];
    expect(buy.accountName).toBe("Vanguard Taxable");
    expect(buy.tradeDate).toBe("2025-06-15");
    expect(buy.type).toBe("BUY");
    expect(buy.symbol).toBe("AAPL");
    expect(buy.quantity).toBe(10);
    expect(buy.pricePerShare).toBe(150.25);
    expect(buy.amount).toBe(1502.5);
    expect(buy.fees).toBe(4.95);

    const div = result.transactions[1];
    expect(div.type).toBe("DIVIDEND");
    expect(div.amount).toBe(25.0);
    expect(div.notes).toBe("Q2 dividend");
  });

  it("uppercases transaction types", () => {
    const csv = `${header}
IBKR,2025-01-10,,buy,MSFT,Microsoft,Stock,5,400,2000,1,`;

    const result = parseCanonicalCsv(csv, "txn.csv");
    expect(result.transactions[0].type).toBe("BUY");
  });

  it("generates deterministic source keys", () => {
    const csv = `${header}
IBKR,2025-03-01,,BUY,VTI,Vanguard Total Stock,ETF,20,242,4840,0,`;

    const result = parseCanonicalCsv(csv, "txn.csv");
    expect(result.transactions[0].sourceKey).toBe(
      "canonical:txn:IBKR:VTI:2025-03-01:BUY"
    );
  });

  it("skips rows with missing symbol or trade_date", () => {
    const csv = `${header}
IBKR,2025-03-01,,BUY,AAPL,Apple,Stock,10,150,1500,0,
IBKR,,,BUY,,Missing,Stock,5,100,500,0,`;

    const result = parseCanonicalCsv(csv, "txn.csv");
    expect(result.transactions).toHaveLength(1);
  });

  it("extracts securities from transactions", () => {
    const csv = `${header}
IBKR,2025-03-01,,BUY,AAPL,Apple Inc,Stock,10,150,1500,0,
IBKR,2025-03-02,,BUY,MSFT,Microsoft Corp,ETF,5,400,2000,0,
IBKR,2025-03-03,,SELL,AAPL,Apple Inc,Stock,5,155,775,0,`;

    const result = parseCanonicalCsv(csv, "txn.csv");
    expect(result.securities).toHaveLength(2);
    expect(result.securities.map((s) => s.symbol).sort()).toEqual([
      "AAPL",
      "MSFT",
    ]);
    expect(result.securities.find((s) => s.symbol === "AAPL")?.name).toBe(
      "Apple Inc"
    );
  });

  it("rejects comma-bearing amounts (defends against parseFloat silent-truncation)", () => {
    // parseFloat("1,234.56") returns 1 — pre-fix this silently corrupted any
    // comma-grouped amount a Co-Work session might emit. parseStrictNumber()
    // now returns NaN for any comma-bearing cell so validate.ts can warn-and-skip
    // instead of committing wrong numbers.
    const csv = `${header}
IBKR,2025-04-15,,BUY,AAPL,Apple Inc,Stock,10,150.25,"1,502.50",0,bad amount
IBKR,2025-04-16,,BUY,MSFT,Microsoft,Stock,5,400.00,2000.00,0,clean amount`;

    const result = parseCanonicalCsv(csv, "txn.csv");
    expect(result.transactions).toHaveLength(2);
    // Bad row keeps NaN amount so downstream validate.ts catches it.
    expect(result.transactions[0].amount).toBeNaN();
    // Clean row parses normally.
    expect(result.transactions[1].amount).toBe(2000);
  });

  it("preserves signed amounts on VMFXX sweep TRANSFERs", () => {
    // Sweep Into Settlement Fund is positive; Sweep Out Of is negative.
    // Regression: a prior Co-Work prompt stripped the sign so all
    // sweeps imported positive, which inflated running-total views.
    const csv = `${header}
Vanguard Taxable,2025-06-10,,TRANSFER,VMFXX,Vanguard Federal Money Market Fund,Mutual Fund,,,1000.00,,Sweep Into Settlement Fund
Vanguard Taxable,2025-06-12,,TRANSFER,VMFXX,Vanguard Federal Money Market Fund,Mutual Fund,,,-250.00,,Sweep Out Of Settlement Fund`;

    const result = parseCanonicalCsv(csv, "txn.csv");
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].type).toBe("TRANSFER");
    expect(result.transactions[0].amount).toBe(1000);
    expect(result.transactions[1].amount).toBe(-250);
  });
});

// ── Holdings parser ────────────────────────────────���────────────────

describe("canonical holdings parser", () => {
  const header =
    "account,as_of_date,symbol,security_name,security_type,quantity,cost_basis,market_value";

  it("parses holdings with cost basis and market value", () => {
    const csv = `${header}
Vanguard Taxable,2025-06-30,AAPL,Apple Inc,Stock,100,15025.00,19500.00
Vanguard Taxable,2025-06-30,VTI,Vanguard Total Stock,ETF,50,11250.00,12100.00`;

    const result = parseCanonicalCsv(csv, "holdings.csv");

    expect(result.holdings).toHaveLength(2);
    expect(result.securities).toHaveLength(2);
    expect(result.transactions).toHaveLength(0);

    const aapl = result.holdings[0];
    expect(aapl.accountName).toBe("Vanguard Taxable");
    expect(aapl.asOfDate).toBe("2025-06-30");
    expect(aapl.symbol).toBe("AAPL");
    expect(aapl.quantity).toBe(100);
    expect(aapl.costBasis).toBe(15025);
    expect(aapl.marketValue).toBe(19500);
  });

  it("handles optional fields gracefully", () => {
    const csv = `${header}
IBKR,2025-06-30,SPY,SPDR S&P 500,,100,,`;

    const result = parseCanonicalCsv(csv, "holdings.csv");
    const holding = result.holdings[0];
    expect(holding.quantity).toBe(100);
    expect(holding.costBasis).toBeUndefined();
    expect(holding.marketValue).toBeUndefined();
  });

  it("skips rows with NaN quantity", () => {
    const csv = `${header}
IBKR,2025-06-30,AAPL,Apple,Stock,abc,,
IBKR,2025-06-30,VTI,Vanguard,ETF,50,,`;

    const result = parseCanonicalCsv(csv, "holdings.csv");
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].symbol).toBe("VTI");
  });

  it("skips holdings rows with comma-bearing quantity", () => {
    // parseFloat("1,234") returns 1 — would silently corrupt the quantity.
    // parseStrictNumber() returns NaN, so the existing isNaN guard skips the row.
    const csv = `${header}
IBKR,2025-06-30,SPY,SPDR S&P 500 ETF,ETF,"1,250",,
IBKR,2025-06-30,VTI,Vanguard,ETF,50,,`;

    const result = parseCanonicalCsv(csv, "holdings.csv");
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].symbol).toBe("VTI");
    expect(result.holdings[0].quantity).toBe(50);
  });

  it("generates correct source keys", () => {
    const csv = `${header}
IBKR,2025-06-30,AAPL,Apple,Stock,100,,`;

    const result = parseCanonicalCsv(csv, "holdings.csv");
    expect(result.holdings[0].sourceKey).toBe(
      "canonical:hold:IBKR:AAPL:2025-06-30"
    );
  });
});

// ── Prices parser ───────────────────────────────────────────────────

describe("canonical prices parser", () => {
  it("parses price data", () => {
    const csv = `symbol,date,close_price
AAPL,2025-06-30,195.00
AAPL,2025-06-29,193.50
VTI,2025-06-30,242.00`;

    const result = parseCanonicalCsv(csv, "prices.csv");

    expect(result.prices).toHaveLength(3);
    expect(result.securities).toHaveLength(2);

    expect(result.prices[0].symbol).toBe("AAPL");
    expect(result.prices[0].date).toBe("2025-06-30");
    expect(result.prices[0].closePrice).toBe(195.0);
    expect(result.prices[0].source).toBe("canonical");
  });

  it("skips rows with NaN close_price", () => {
    const csv = `symbol,date,close_price
AAPL,2025-06-30,N/A
VTI,2025-06-30,242.00`;

    const result = parseCanonicalCsv(csv, "prices.csv");
    expect(result.prices).toHaveLength(1);
    expect(result.prices[0].symbol).toBe("VTI");
  });

  it("skips rows with missing fields", () => {
    const csv = `symbol,date,close_price
,2025-06-30,195.00
AAPL,,195.00
VTI,2025-06-30,242.00`;

    const result = parseCanonicalCsv(csv, "prices.csv");
    expect(result.prices).toHaveLength(1);
  });
});

// ── Snapshots parser ────────────────────────────────────────────────

describe("canonical snapshots parser", () => {
  const header =
    "account,month_end_date,total_value,starting_value,deposits_withdrawals,dividends,interest,commissions,fees,investment_gain,twr";

  it("parses full snapshot row", () => {
    const csv = `${header}
Vanguard Taxable,2025-06-30,250000,245000,2000,150,25,-15,-10,2850,0.0116`;

    const result = parseCanonicalCsv(csv, "snapshots.csv");

    expect(result.snapshots).toHaveLength(1);
    expect(result.transactions).toHaveLength(0);
    expect(result.holdings).toHaveLength(0);

    const snap = result.snapshots[0];
    expect(snap.accountName).toBe("Vanguard Taxable");
    expect(snap.monthEndDate).toBe("2025-06-30");
    expect(snap.totalValue).toBe(250000);
    expect(snap.startingValue).toBe(245000);
    expect(snap.depositsWithdrawals).toBe(2000);
    expect(snap.dividends).toBe(150);
    expect(snap.interest).toBe(25);
    expect(snap.commissions).toBe(-15);
    expect(snap.fees).toBe(-10);
    expect(snap.investmentGain).toBe(2850);
    expect(snap.twr).toBe(0.0116);
    expect(snap.source).toBe("canonical");
  });

  it("handles minimal snapshot (only required fields)", () => {
    const csv = `${header}
IBKR,2025-06-30,300000,,,,,,,,`;

    const result = parseCanonicalCsv(csv, "snapshots.csv");
    expect(result.snapshots).toHaveLength(1);
    const snap = result.snapshots[0];
    expect(snap.totalValue).toBe(300000);
    expect(snap.startingValue).toBeUndefined();
    expect(snap.twr).toBeUndefined();
  });

  it("skips rows with NaN total_value", () => {
    const csv = `${header}
IBKR,2025-06-30,bad_value,,,,,,,,
IBKR,2025-05-31,290000,,,,,,,,`;

    const result = parseCanonicalCsv(csv, "snapshots.csv");
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].monthEndDate).toBe("2025-05-31");
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe("canonical CSV edge cases", () => {
  it("handles empty CSV (header only)", () => {
    const csv = "symbol,date,close_price\n";
    const result = parseCanonicalCsv(csv, "empty.csv");
    expect(result.prices).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("trims whitespace from fields", () => {
    const csv = `account,as_of_date,symbol,security_name,security_type,quantity,cost_basis,market_value
 IBKR , 2025-06-30 , AAPL , Apple Inc , Stock ,100,,`;

    const result = parseCanonicalCsv(csv, "holdings.csv");
    expect(result.holdings[0].accountName).toBe("IBKR");
    expect(result.holdings[0].asOfDate).toBe("2025-06-30");
    expect(result.holdings[0].symbol).toBe("AAPL");
  });

  it("deduplicates securities across multiple rows", () => {
    const csv = `account,trade_date,settlement_date,type,symbol,security_name,security_type,quantity,price,amount,fees,notes
IBKR,2025-01-10,,BUY,AAPL,Apple Inc,Stock,10,150,1500,0,
IBKR,2025-02-10,,BUY,AAPL,Apple Inc,Stock,5,155,775,0,
IBKR,2025-03-10,,SELL,AAPL,Apple Inc,Stock,3,160,480,0,`;

    const result = parseCanonicalCsv(csv, "txn.csv");
    expect(result.transactions).toHaveLength(3);
    expect(result.securities).toHaveLength(1);
    expect(result.securities[0].symbol).toBe("AAPL");
  });
});
