import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIbkrActivity } from "@/lib/import/parsers/ibkr-activity";

const csv = readFileSync(join(__dirname, "../fixtures/ibkr-corporate-actions.csv"), "utf-8");

describe("ibkr-activity parser: Corporate Actions section", () => {
  const result = parseIbkrActivity(csv, "ibkr-corporate-actions.csv");

  it("parses the forward split with ratio from description and date from Date/Time", () => {
    const split = result.corporateActions.find((a) => a.symbol === "AAAA");
    expect(split).toMatchObject({
      accountName: "IBKR",
      actionType: "SPLIT",
      effectiveDate: "2026-07-01",       // NOT the 2026-07-02 report date
      ratioNumerator: 4,
      ratioDenominator: 1,
      quantityDelta: 300,
      sourceKey: "ibkr:ca:split:2026-07-01:AAAA:4:1",
    });
  });

  it("parses the reverse split (numerator < denominator)", () => {
    const rev = result.corporateActions.find((a) => a.symbol === "BBBB");
    expect(rev).toMatchObject({
      actionType: "REVERSE_SPLIT",
      ratioNumerator: 1,
      ratioDenominator: 10,
      quantityDelta: -90,
    });
  });

  it("keeps a dotted exchange-suffixed symbol intact (normalization happens at commit)", () => {
    const kr = result.corporateActions.find((a) => a.symbol === "402340.KS");
    expect(kr).toMatchObject({ actionType: "SPLIT", ratioNumerator: 2, ratioDenominator: 1 });
  });

  it("warns by name on merger, malformed, 1:1, zero-denominator, and option-adjustment rows", () => {
    expect(result.corporateActions).toHaveLength(4);   // AAAA, BBBB, 402340.KS, GGGG
    const joined = result.warnings.join("\n");
    expect(joined).toContain("CCCC");                  // merger
    expect(joined).toContain("DDDD");                  // Split X for Y
    expect(joined).toContain("EEEE");                  // 1-for-1 no-op
    expect(joined).toContain("FFFF");                  // Split 4 for 0
    expect(joined).toContain("Contract Adjustment");   // non-Stocks asset category
  });

  it("nonnumeric Quantity imports with quantityDelta null (evidence absent, not fabricated)", () => {
    const g = result.corporateActions.find((a) => a.symbol === "GGGG");
    expect(g).toMatchObject({ actionType: "SPLIT", ratioNumerator: 3, quantityDelta: null });
  });

  it("stays silent on the Total row", () => {
    expect(result.warnings.filter((w) => w.includes("Total"))).toHaveLength(0);
  });

  it("handles a header WITHOUT the Account column (single-account statements)", () => {
    const noAcct = [
      "Statement,Header,Field Name,Field Value",
      'Statement,Data,Period,"July 1, 2026 - July 31, 2026"',
      "Corporate Actions,Header,Asset Category,Currency,Report Date,Date/Time,Description,Quantity,Proceeds,Value,Realized P/L,Code",
      'Corporate Actions,Data,Stocks,USD,2026-07-02,"2026-07-01, 20:25:00","AAAA(US0000000001) Split 4 for 1 (AAAA, FAKE ALPHA CORP, US0000000001)",300,0,0,0,',
    ].join("\n");
    const r = parseIbkrActivity(noAcct, "no-account.csv");
    expect(r.corporateActions).toHaveLength(1);
    expect(r.corporateActions[0]).toMatchObject({ symbol: "AAAA", effectiveDate: "2026-07-01", quantityDelta: 300 });
  });

  it("rejects a calendar-invalid Date/Time with a warning", () => {
    const bad = [
      "Corporate Actions,Header,Asset Category,Currency,Account,Report Date,Date/Time,Description,Quantity,Proceeds,Value,Realized P/L,Code",
      'Corporate Actions,Data,Stocks,USD,U0,2026-07-02,"2026-13-45, 20:25:00","AAAA(US1) Split 4 for 1 (AAAA, X, US1)",300,0,0,0,',
    ].join("\n");
    const r = parseIbkrActivity(bad, "bad-date.csv");
    expect(r.corporateActions).toHaveLength(0);
    expect(r.warnings.join("\n")).toContain("AAAA");
  });

  it("statements without a Corporate Actions section produce an empty array", () => {
    const bare = parseIbkrActivity("Statement,Header,Field Name,Field Value\n", "bare.csv");
    expect(bare.corporateActions).toEqual([]);
  });
});
