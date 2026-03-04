import { describe, it, expect } from "vitest";
import { parseIbkrActivity } from "@/lib/import/parsers/ibkr-activity";
import fs from "node:fs";
import path from "node:path";

const fixture = fs.readFileSync(
  path.join(__dirname, "../../fixtures/ibkr-activity-sample.csv"),
  "utf-8"
);

describe("IBKR activity parser", () => {
  it("returns correct source type", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    expect(result.sourceType).toBe("ibkr-activity");
  });

  it("extracts monthly snapshot with NAV data", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    expect(result.snapshots).toHaveLength(1);
    const snap = result.snapshots[0];
    expect(snap.accountName).toBe("IBKR");
    expect(snap.monthEndDate).toBe("2025-01-31");
    expect(snap.totalValue).toBe(63000);
    expect(snap.startingValue).toBe(55000);
    expect(snap.markToMarket).toBe(6200);
    expect(snap.dividends).toBe(150);
    expect(snap.interest).toBe(50);
    expect(snap.fees).toBe(-30);
    expect(snap.commissions).toBe(-15.5);
    expect(snap.twr).toBeCloseTo(14.545454545);
  });

  it("extracts trades as transactions", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    const trades = result.transactions.filter((t) => t.type === "SELL" || t.type === "BUY");
    expect(trades).toHaveLength(2);

    const sell = trades.find((t) => t.type === "SELL");
    expect(sell).toBeTruthy();
    expect(sell!.symbol).toBe("MSFT");
    expect(sell!.quantity).toBe(50);
    expect(sell!.amount).toBe(19350);
    expect(sell!.fees).toBe(2.75);

    const buy = trades.find((t) => t.type === "BUY");
    expect(buy).toBeTruthy();
    expect(buy!.symbol).toBe("GOOG");
    expect(buy!.quantity).toBe(200);
    expect(buy!.amount).toBe(-27200);
  });

  it("extracts dividends", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    const divs = result.transactions.filter((t) => t.type === "DIVIDEND");
    expect(divs).toHaveLength(2);
    expect(divs[0].amount).toBe(25);
    expect(divs[1].amount).toBe(125);
  });

  it("extracts interest", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    const interest = result.transactions.filter((t) => t.type === "INTEREST");
    expect(interest).toHaveLength(1);
    expect(interest[0].amount).toBe(50);
  });

  it("extracts fees", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    const fees = result.transactions.filter((t) => t.type === "FEE");
    expect(fees).toHaveLength(1);
    expect(fees[0].amount).toBe(-30);
  });

  it("extracts securities", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    const symbols = result.securities.map((s) => s.symbol);
    expect(symbols).toContain("AAPL");
    expect(symbols).toContain("MSFT");
    expect(symbols).toContain("GOOG");
  });

  it("has no errors", () => {
    const result = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");
    expect(result.errors).toHaveLength(0);
  });
});
