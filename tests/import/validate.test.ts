import { describe, it, expect } from "vitest";
import {
  isValidDate,
  isValidQuantity,
  isValidPrice,
  isValidTransactionType,
  isGarbageSymbol,
  validateParsedResult,
  VALID_TRANSACTION_TYPES,
} from "@/lib/import/validate";
import type { ParsedImportResult } from "@/lib/import/types";

// ── Individual validators ───────────────────────────────────────────

describe("isValidDate", () => {
  it("accepts valid YYYY-MM-DD dates", () => {
    expect(isValidDate("2025-01-15")).toBe(true);
    expect(isValidDate("2026-12-31")).toBe(true);
    expect(isValidDate("2025-02-28")).toBe(true);
  });

  it("rejects invalid dates", () => {
    expect(isValidDate("2025-13-01")).toBe(false); // month 13
    expect(isValidDate("2025-02-30")).toBe(false); // Feb 30
    expect(isValidDate("not-a-date")).toBe(false);
    expect(isValidDate("01/15/2025")).toBe(false); // wrong format
    expect(isValidDate("2025-1-5")).toBe(false);   // missing zero-pad
    expect(isValidDate("")).toBe(false);
  });

  it("rejects leap year edge cases correctly", () => {
    expect(isValidDate("2024-02-29")).toBe(true);  // 2024 is leap year
    expect(isValidDate("2025-02-29")).toBe(false);  // 2025 is not
  });
});

describe("isValidQuantity", () => {
  it("accepts null/undefined (optional field)", () => {
    expect(isValidQuantity(null)).toBe(true);
    expect(isValidQuantity(undefined)).toBe(true);
  });

  it("accepts any finite number (including negatives — canonical-csv parser normalizes)", () => {
    expect(isValidQuantity(0)).toBe(true);
    expect(isValidQuantity(100)).toBe(true);
    expect(isValidQuantity(0.5)).toBe(true);
    // Negatives accepted: canonical-csv parser auto-normalizes to abs and warns.
    // Other source paths (IBKR-activity) may use signed quantities legitimately.
    // Pre-2026-05-04 this rejected negatives and silently dropped 20+ rows on April import.
    expect(isValidQuantity(-1)).toBe(true);
    expect(isValidQuantity(-35.256)).toBe(true);
  });

  it("rejects NaN, Infinity (non-finite)", () => {
    expect(isValidQuantity(NaN)).toBe(false);
    expect(isValidQuantity(Infinity)).toBe(false);
    expect(isValidQuantity(-Infinity)).toBe(false);
  });
});

describe("isValidPrice", () => {
  it("accepts null/undefined (optional field)", () => {
    expect(isValidPrice(null)).toBe(true);
    expect(isValidPrice(undefined)).toBe(true);
  });

  it("accepts zero (expired options)", () => {
    expect(isValidPrice(0)).toBe(true);
  });

  it("accepts positive prices", () => {
    expect(isValidPrice(150.25)).toBe(true);
    expect(isValidPrice(0.01)).toBe(true);
  });

  it("rejects negative, NaN, Infinity", () => {
    expect(isValidPrice(-5)).toBe(false);
    expect(isValidPrice(NaN)).toBe(false);
    expect(isValidPrice(Infinity)).toBe(false);
  });
});

describe("isGarbageSymbol", () => {
  it("accepts real ticker symbols", () => {
    expect(isGarbageSymbol("AAPL")).toBeNull();
    expect(isGarbageSymbol("BRK B")).toBeNull();
    expect(isGarbageSymbol("SPY")).toBeNull();
    expect(isGarbageSymbol("912797TH0")).toBeNull(); // treasury CUSIP
    expect(isGarbageSymbol("SPY   260410C00659000")).toBeNull(); // OCC option
    expect(isGarbageSymbol("VTI")).toBeNull();
  });

  it("rejects timestamp strings", () => {
    expect(isGarbageSymbol("2025-01-06, 08:49:20")).toBe("timestamp");
    expect(isGarbageSymbol("2025-01-03, 11:40:15")).toBe("timestamp");
  });

  it("rejects symbols with commas", () => {
    expect(isGarbageSymbol("AAPL, GOOGL")).toBe("contains comma");
  });

  it("rejects overly long strings", () => {
    expect(isGarbageSymbol("This is a very long description that is definitely not a ticker symbol")).not.toBeNull();
  });

  it("rejects purely numeric strings", () => {
    expect(isGarbageSymbol("123456")).toBe("purely numeric");
  });

  it("rejects time-like patterns", () => {
    expect(isGarbageSymbol("10:30:45")).toBe("contains time-like pattern");
  });

  it("returns null for undefined/empty", () => {
    expect(isGarbageSymbol(undefined)).toBeNull();
    expect(isGarbageSymbol("")).toBe("empty symbol");
  });
});

describe("isValidTransactionType", () => {
  it("accepts known types", () => {
    expect(isValidTransactionType("BUY")).toBe(true);
    expect(isValidTransactionType("SELL")).toBe(true);
    expect(isValidTransactionType("DIVIDEND")).toBe(true);
    expect(isValidTransactionType("REINVESTMENT")).toBe(true);
    expect(isValidTransactionType("BUY_TO_OPEN")).toBe(true);
    expect(isValidTransactionType("SELL_TO_CLOSE")).toBe(true);
    expect(isValidTransactionType("EXERCISED")).toBe(true);
    expect(isValidTransactionType("EXPIRED")).toBe(true);
  });

  it("accepts types case-insensitively", () => {
    expect(isValidTransactionType("buy")).toBe(true);
    expect(isValidTransactionType("Dividend")).toBe(true);
  });

  it("rejects unknown types", () => {
    expect(isValidTransactionType("MAGIC")).toBe(false);
    expect(isValidTransactionType("Reorganization")).toBe(false);
    expect(isValidTransactionType("")).toBe(false);
  });

  it("covers all expected types", () => {
    // Verify the allowlist has a reasonable size
    expect(VALID_TRANSACTION_TYPES.size).toBeGreaterThanOrEqual(25);
  });
});

// ── Full validation ─────────────────────────────────────────────────

function makeParsedResult(
  overrides: Partial<ParsedImportResult> = {},
): ParsedImportResult {
  return {
    sourceType: "ibkr-activity",
    sourceName: "test.csv",
    transactions: [],
    securities: [],
    holdings: [],
    prices: [],
    snapshots: [],
    errors: [],
    warnings: [],
    ...overrides,
  };
}

describe("validateParsedResult", () => {
  it("passes clean data through unchanged", () => {
    const parsed = makeParsedResult({
      transactions: [
        {
          accountName: "IBKR",
          tradeDate: "2025-03-15",
          type: "BUY",
          symbol: "AAPL",
          quantity: 10,
          amount: 1500,
          sourceKey: "test:1",
        },
      ],
      holdings: [
        {
          accountName: "IBKR",
          symbol: "AAPL",
          quantity: 10,
          asOfDate: "2025-03-15",
          sourceKey: "test:h1",
        },
      ],
      prices: [
        { symbol: "AAPL", date: "2025-03-15", closePrice: 150.0, source: "ibkr" },
      ],
      snapshots: [
        {
          accountName: "IBKR",
          monthEndDate: "2025-03-31",
          totalValue: 100000,
          source: "ibkr",
        },
      ],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed);
    expect(skippedRows).toHaveLength(0);
    expect(validatedResult.transactions).toHaveLength(1);
    expect(validatedResult.holdings).toHaveLength(1);
    expect(validatedResult.prices).toHaveLength(1);
    expect(validatedResult.snapshots).toHaveLength(1);
  });

  it("excludes transactions with invalid trade dates", () => {
    const parsed = makeParsedResult({
      transactions: [
        {
          accountName: "IBKR",
          tradeDate: "not-a-date",
          type: "BUY",
          symbol: "AAPL",
          quantity: 10,
          amount: 1500,
          sourceKey: "test:1",
        },
        {
          accountName: "IBKR",
          tradeDate: "2025-03-15",
          type: "SELL",
          symbol: "MSFT",
          quantity: 5,
          amount: 2000,
          sourceKey: "test:2",
        },
      ],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed);
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].reason).toContain("Invalid trade date");
    expect(skippedRows[0].symbol).toBe("AAPL");
    expect(validatedResult.transactions).toHaveLength(1);
    expect(validatedResult.transactions[0].symbol).toBe("MSFT");
  });

  it("excludes transactions with NaN quantity", () => {
    const parsed = makeParsedResult({
      transactions: [
        {
          accountName: "IBKR",
          tradeDate: "2025-03-15",
          type: "BUY",
          symbol: "AAPL",
          quantity: NaN,
          amount: 1500,
          sourceKey: "test:1",
        },
      ],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed);
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].reason).toContain("Invalid quantity");
    expect(validatedResult.transactions).toHaveLength(0);
  });

  it("warns on unknown transaction types but keeps the row", () => {
    const parsed = makeParsedResult({
      transactions: [
        {
          accountName: "IBKR",
          tradeDate: "2025-03-15",
          type: "MAGIC_TRADE",
          symbol: "AAPL",
          quantity: 10,
          amount: 1500,
          sourceKey: "test:1",
        },
      ],
    });

    const { skippedRows, warnings, validatedResult } =
      validateParsedResult(parsed);
    expect(skippedRows).toHaveLength(0);
    expect(validatedResult.transactions).toHaveLength(1);
    expect(warnings.some((w) => w.includes("unknown type"))).toBe(true);
  });

  it("clears invalid settlement dates but keeps the transaction", () => {
    const parsed = makeParsedResult({
      transactions: [
        {
          accountName: "IBKR",
          tradeDate: "2025-03-15",
          settlementDate: "bad-date",
          type: "BUY",
          symbol: "AAPL",
          quantity: 10,
          amount: 1500,
          sourceKey: "test:1",
        },
      ],
    });

    const { validatedResult, warnings } = validateParsedResult(parsed);
    expect(validatedResult.transactions).toHaveLength(1);
    expect(validatedResult.transactions[0].settlementDate).toBeUndefined();
    expect(warnings.some((w) => w.includes("settlement date"))).toBe(true);
  });

  it("excludes holdings with invalid dates", () => {
    const parsed = makeParsedResult({
      holdings: [
        {
          accountName: "IBKR",
          symbol: "AAPL",
          quantity: 10,
          asOfDate: "13/01/2025",
          sourceKey: "test:h1",
        },
      ],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed);
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].category).toBe("holding");
    expect(validatedResult.holdings).toHaveLength(0);
  });

  it("excludes holdings with non-finite quantity", () => {
    const parsed = makeParsedResult({
      holdings: [
        {
          accountName: "IBKR",
          symbol: "AAPL",
          quantity: Infinity,
          asOfDate: "2025-03-15",
          sourceKey: "test:h1",
        },
      ],
    });

    const { skippedRows } = validateParsedResult(parsed);
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].reason).toContain("Invalid quantity");
  });

  it("excludes prices with invalid dates or NaN values", () => {
    const parsed = makeParsedResult({
      prices: [
        { symbol: "AAPL", date: "bad", closePrice: 150, source: "test" },
        { symbol: "MSFT", date: "2025-03-15", closePrice: NaN, source: "test" },
        { symbol: "GOOG", date: "2025-03-15", closePrice: 100, source: "test" },
      ],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed);
    expect(skippedRows).toHaveLength(2);
    expect(validatedResult.prices).toHaveLength(1);
    expect(validatedResult.prices[0].symbol).toBe("GOOG");
  });

  it("excludes snapshots with invalid dates or non-finite totals", () => {
    const parsed = makeParsedResult({
      snapshots: [
        {
          accountName: "IBKR",
          monthEndDate: "bad-date",
          totalValue: 100000,
          source: "ibkr",
        },
        {
          accountName: "IBKR",
          monthEndDate: "2025-03-31",
          totalValue: NaN,
          source: "ibkr",
        },
        {
          accountName: "IBKR",
          monthEndDate: "2025-03-31",
          totalValue: 100000,
          source: "ibkr",
        },
      ],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed);
    expect(skippedRows).toHaveLength(2);
    expect(validatedResult.snapshots).toHaveLength(1);
  });

  it("adds summary warning when rows are skipped", () => {
    const parsed = makeParsedResult({
      transactions: [
        {
          accountName: "IBKR",
          tradeDate: "bad",
          type: "BUY",
          sourceKey: "t:1",
        },
      ],
    });

    const { validatedResult } = validateParsedResult(parsed);
    expect(
      validatedResult.warnings.some((w) => w.includes("excluded")),
    ).toBe(true);
  });

  it("preserves existing warnings from parsers", () => {
    const parsed = makeParsedResult({
      warnings: ["Parser warning: something odd"],
    });

    const { validatedResult } = validateParsedResult(parsed);
    expect(
      validatedResult.warnings.some((w) => w.includes("Parser warning")),
    ).toBe(true);
  });
});
