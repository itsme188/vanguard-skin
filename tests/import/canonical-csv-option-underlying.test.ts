import { describe, it, expect } from "vitest";
import { parseCanonicalCsv } from "@/lib/import/parsers/canonical-csv";

// Correct canonical-csv transactions header (matches detectCanonicalType)
const HEADER =
  "account,trade_date,settlement_date,type,symbol,security_name,security_type,quantity,price,amount,fees,notes";

const CSV = `${HEADER}
IBKR,2026-06-01,,BUY_TO_OPEN,AMZN  270617C00260000,AMZN JUN2027 260 CALL,Option,1,12.50,-1250,,`;

describe("canonical-csv option underlying_symbol", () => {
  it("populates underlyingSymbol from a directly-provided OCC symbol", () => {
    const result = parseCanonicalCsv(CSV, "txn.csv");
    const sec = result.securities.find(
      (s) => s.symbol === "AMZN  270617C00260000"
    );
    expect(sec).toBeDefined();
    expect(sec!.underlyingSymbol).toBe("AMZN");
  });

  it("also extracts strike, expiration, optionType from OCC symbol", () => {
    const result = parseCanonicalCsv(CSV, "txn.csv");
    const sec = result.securities.find(
      (s) => s.symbol === "AMZN  270617C00260000"
    );
    expect(sec!.strikePrice).toBe(260);
    expect(sec!.expirationDate).toBe("2027-06-17");
    expect(sec!.optionType).toBe("CALL");
  });
});
