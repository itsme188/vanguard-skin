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
import { parseCanonicalCsv } from "@/lib/import/parsers/canonical-csv";
import { parseIbkrActivity } from "@/lib/import/parsers/ibkr-activity";
import fs from "node:fs";
import path from "node:path";

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
    corporateActions: [],
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

  it("excludes securities with garbage symbols (timestamp from misaligned CSV)", () => {
    // Regression: pre-f8fd2d8 ibkr-activity parser misread Date/Time as the
    // symbol; validation rejected the transactions but the securities array
    // was committed unvalidated — 127 orphan rows landed in the live DB.
    const parsed = makeParsedResult({
      securities: [
        { symbol: "2026-05-07, 16:36:07", securityType: "Stock" },
        { symbol: "AAPL", securityType: "Stock" },
      ],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed);
    expect(validatedResult.securities).toHaveLength(1);
    expect(validatedResult.securities[0].symbol).toBe("AAPL");
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].category).toBe("security");
    expect(skippedRows[0].reason).toContain("timestamp");
  });

  it("rejects symbols with no alphanumeric characters", () => {
    // Vanguard corporate-action rows sometimes carry "-" as the symbol —
    // a real "-" security (id 5025) polluted the notes dropdown for years.
    expect(isGarbageSymbol("-")).toBeTruthy();
    expect(isGarbageSymbol("--")).toBeTruthy();
    expect(isGarbageSymbol("BRK/B")).toBeNull(); // real dual-class form
  });

  it("excludes date-like security symbols", () => {
    const parsed = makeParsedResult({
      securities: [{ symbol: "2026-05-07", securityType: "Stock" }],
    });

    const { validatedResult } = validateParsedResult(parsed);
    expect(validatedResult.securities).toHaveLength(0);
  });

  it("excludes prices whose symbol is garbage (not just date-like)", () => {
    // isDateLikeSymbol alone misses timestamps like "2026-05-07, 16:36:07"
    // (the strict YYYY-MM-DD regex doesn't match them).
    const parsed = makeParsedResult({
      prices: [
        { symbol: "2026-05-07, 16:36:07", date: "2026-05-07", closePrice: 10, source: "ibkr" },
        { symbol: "AAPL", date: "2026-05-07", closePrice: 150, source: "ibkr" },
      ],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed);
    expect(validatedResult.prices).toHaveLength(1);
    expect(validatedResult.prices[0].symbol).toBe("AAPL");
    expect(skippedRows).toHaveLength(1);
  });

  it("never surfaces the raw NaN token in skip reasons (parseStrictNumber comma rows)", () => {
    // parseStrictNumber() returns NaN for comma-bearing cells like "-2,105.00";
    // the skip reason must explain that in words, not leak "NaN" to the user.
    const parsed = makeParsedResult({
      transactions: [
        {
          accountName: "IBKR",
          tradeDate: "2025-03-15",
          type: "BUY",
          symbol: "AAPL",
          quantity: NaN,
          amount: NaN,
          sourceKey: "test:nan",
        },
      ],
      holdings: [
        {
          accountName: "IBKR",
          symbol: "MSFT",
          quantity: NaN,
          asOfDate: "2025-03-15",
          sourceKey: "test:hnan",
        },
      ],
      prices: [{ symbol: "GOOG", date: "2025-03-15", closePrice: NaN, source: "ibkr" }],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed);
    expect(validatedResult.transactions).toHaveLength(0);
    expect(validatedResult.holdings).toHaveLength(0);
    expect(validatedResult.prices).toHaveLength(0);
    expect(skippedRows.length).toBeGreaterThanOrEqual(3);
    for (const row of skippedRows) {
      expect(row.reason).not.toContain("NaN");
      expect(row.reason).toContain("not a number");
    }
  });
});

// ── Account-name resolution (opts.knownAccountNames) ────────────────
// QA finding import-preview--no-account-validation-500-on-commit: a typo'd
// accountName previewed green (validateParsedResult never checked it) and
// then 500'd at commit, because commitImport's getAccountId only SELECTs —
// it never creates an account. These pin the preview-time guard.

describe("validateParsedResult: knownAccountNames option", () => {
  const KNOWN = ["IBKR", "Vanguard Roth IRA", "Vanguard Taxable"];

  it("excludes a transaction naming an unknown account and lists the valid set in the reason", () => {
    const parsed = makeParsedResult({
      transactions: [
        {
          accountName: "Vangaurd Taxable", // typo
          tradeDate: "2025-06-15",
          type: "BUY",
          symbol: "AAPL",
          quantity: 10,
          amount: -1500,
          sourceKey: "test:1",
        },
      ],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed, {
      knownAccountNames: KNOWN,
    });

    expect(validatedResult.transactions).toHaveLength(0);
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].category).toBe("transaction");
    expect(skippedRows[0].reason).toContain('Unknown account "Vangaurd Taxable"');
    expect(skippedRows[0].reason).toContain("IBKR");
    expect(skippedRows[0].reason).toContain("Vanguard Roth IRA");
    expect(skippedRows[0].reason).toContain("Vanguard Taxable");
  });

  it("unshifts a single summary warning naming every unknown account and the valid set", () => {
    const parsed = makeParsedResult({
      transactions: [
        {
          accountName: "Vangaurd Taxable",
          tradeDate: "2025-06-15",
          type: "BUY",
          symbol: "AAPL",
          quantity: 10,
          amount: -1500,
          sourceKey: "test:1",
        },
      ],
      holdings: [
        {
          accountName: "Robinhood", // a second, distinct unknown name
          symbol: "MSFT",
          quantity: 5,
          asOfDate: "2025-06-30",
          sourceKey: "test:h1",
        },
      ],
    });

    const { validatedResult } = validateParsedResult(parsed, {
      knownAccountNames: KNOWN,
    });

    const summary = validatedResult.warnings[0];
    expect(summary).toContain("Unknown account(s):");
    expect(summary).toContain("Vangaurd Taxable");
    expect(summary).toContain("Robinhood");
    expect(summary).toContain("IBKR");
    expect(summary).toContain("Vanguard Roth IRA");
    expect(summary).toContain("Vanguard Taxable");
  });

  it("passes rows through unchanged when accountName matches the known set", () => {
    const parsed = makeParsedResult({
      transactions: [
        {
          accountName: "Vanguard Taxable",
          tradeDate: "2025-06-15",
          type: "BUY",
          symbol: "AAPL",
          quantity: 10,
          amount: -1500,
          sourceKey: "test:1",
        },
      ],
      holdings: [
        {
          accountName: "IBKR",
          symbol: "MSFT",
          quantity: 5,
          asOfDate: "2025-06-30",
          sourceKey: "test:h1",
        },
      ],
      snapshots: [
        {
          accountName: "Vanguard Roth IRA",
          monthEndDate: "2025-06-30",
          totalValue: 50000,
          source: "test",
        },
      ],
      corporateActions: [
        {
          accountName: "IBKR",
          symbol: "AAAA",
          actionType: "SPLIT",
          effectiveDate: "2025-06-01",
          ratioNumerator: 4,
          ratioDenominator: 1,
          quantityDelta: 300,
          sourceKey: "test:ca1",
        },
      ],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed, {
      knownAccountNames: KNOWN,
    });

    expect(skippedRows).toHaveLength(0);
    expect(validatedResult.transactions).toHaveLength(1);
    expect(validatedResult.holdings).toHaveLength(1);
    expect(validatedResult.snapshots).toHaveLength(1);
    expect(validatedResult.corporateActions).toHaveLength(1);
    expect(validatedResult.warnings.some((w) => w.includes("Unknown account"))).toBe(false);
  });

  it("excludes holdings, snapshots, and corporate actions naming an unknown account", () => {
    const parsed = makeParsedResult({
      holdings: [
        {
          accountName: "Robinhood",
          symbol: "MSFT",
          quantity: 5,
          asOfDate: "2025-06-30",
          sourceKey: "test:h1",
        },
      ],
      snapshots: [
        {
          accountName: "Robinhood",
          monthEndDate: "2025-06-30",
          totalValue: 50000,
          source: "test",
        },
      ],
      corporateActions: [
        {
          accountName: "Robinhood",
          symbol: "AAAA",
          actionType: "SPLIT",
          effectiveDate: "2025-06-01",
          ratioNumerator: 4,
          ratioDenominator: 1,
          quantityDelta: 300,
          sourceKey: "test:ca1",
        },
      ],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed, {
      knownAccountNames: KNOWN,
    });

    expect(validatedResult.holdings).toHaveLength(0);
    expect(validatedResult.snapshots).toHaveLength(0);
    expect(validatedResult.corporateActions).toHaveLength(0);
    expect(skippedRows.map((r) => r.category).sort()).toEqual(
      ["corporateAction", "holding", "snapshot"].sort(),
    );
    for (const row of skippedRows) {
      expect(row.reason).toContain('Unknown account "Robinhood"');
    }
  });

  it("does not check account names at all when opts is omitted (existing callers unchanged)", () => {
    const parsed = makeParsedResult({
      transactions: [
        {
          accountName: "Totally Made Up Brokerage",
          tradeDate: "2025-06-15",
          type: "BUY",
          symbol: "AAPL",
          quantity: 10,
          amount: -1500,
          sourceKey: "test:1",
        },
      ],
    });

    const { skippedRows, validatedResult } = validateParsedResult(parsed);

    expect(skippedRows).toHaveLength(0);
    expect(validatedResult.transactions).toHaveLength(1);
    expect(validatedResult.warnings.some((w) => w.includes("Unknown account"))).toBe(false);
  });
});

describe("validateParsedResult: canonical monthly snapshots", () => {
  const header =
    "account,month_end_date,total_value,starting_value,deposits_withdrawals,dividends,interest,commissions,fees,investment_gain,twr";

  function validateSnapshotRows(rows: string) {
    return validateParsedResult(parseCanonicalCsv(`${header}\n${rows}`, "snapshots.csv"));
  }

  it("excludes canonical snapshot rows whose decimal twr is above 100%", () => {
    const { skippedRows, validatedResult } = validateSnapshotRows(
      "Vanguard Taxable,2026-08-31,100000,,,,,,,,5",
    );

    expect(validatedResult.snapshots).toHaveLength(0);
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0]).toMatchObject({
      category: "snapshot",
      index: 0,
    });
    expect(skippedRows[0].reason).toContain("twr is a decimal");
    expect(skippedRows[0].reason).toContain("0.05");
  });

  it("prints the implied percent without floating-point noise", () => {
    const { skippedRows } = validateSnapshotRows(
      [
        "Vanguard Taxable,2026-08-31,100000,,,,,,,,5.1",
        "Vanguard Taxable,2026-09-30,200000,,,,,,,,1.0000001",
        "Vanguard Taxable,2026-10-31,300000,,,,,,,,-1.1",
      ].join("\n"),
    );

    expect(skippedRows.map((r) => r.reason)).toEqual([
      "twr is a decimal: 5.1 means +510% for the month. Enter 0.05 for 5%.",
      "twr is a decimal: 1.0000001 means +100.00001% for the month. Enter 0.05 for 5%.",
      "twr is a decimal: -1.1 means -110% for the month. Enter 0.05 for 5%.",
    ]);
  });

  it("keeps canonical decimal twr values at and inside the 100% boundary", () => {
    const { skippedRows, validatedResult } = validateSnapshotRows(
      [
        "Vanguard Taxable,2026-08-31,100000,,,,,,,,0.05",
        "Vanguard Taxable,2026-09-30,200000,,,,,,,,1",
        "Vanguard Taxable,2026-10-31,300000,,,,,,,,-1",
      ].join("\n"),
    );

    expect(skippedRows).toHaveLength(0);
    expect(validatedResult.snapshots.map((s) => s.twr)).toEqual([0.05, 1, -1]);
  });

  it("excludes negative canonical decimal twr values below -100%", () => {
    const { skippedRows, validatedResult } = validateSnapshotRows(
      "Vanguard Taxable,2026-08-31,100000,,,,,,,,-1.5",
    );

    expect(validatedResult.snapshots).toHaveLength(0);
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].reason).toContain("twr is a decimal");
  });

  it("warns but keeps a canonical monthly snapshot whose date is not month-end", () => {
    const { skippedRows, warnings, validatedResult } = validateSnapshotRows(
      "Vanguard Taxable,2026-08-15,100000,,,,,,,,0.05",
    );

    expect(skippedRows).toHaveLength(0);
    expect(validatedResult.snapshots).toHaveLength(1);
    expect(validatedResult.snapshots[0].monthEndDate).toBe("2026-08-15");
    expect(warnings.join("\n")).toContain("month_end_date");
    expect(warnings.join("\n")).toContain("last calendar day");
    expect(warnings.join("\n")).toContain("2026-08-31");
  });

  it("accepts leap-day February month-end without a warning", () => {
    const { skippedRows, warnings, validatedResult } = validateSnapshotRows(
      "Vanguard Taxable,2024-02-29,100000,,,,,,,,0.05",
    );

    expect(skippedRows).toHaveLength(0);
    expect(validatedResult.snapshots).toHaveLength(1);
    expect(warnings.join("\n")).not.toContain("month_end_date");
  });

  it("keeps a blank canonical twr and excludes a non-numeric one by name", () => {
    const { skippedRows, validatedResult } = validateSnapshotRows(
      [
        "Vanguard Taxable,2026-08-31,100000,,,,,,,,",
        "Vanguard Taxable,2026-09-30,200000,,,,,,,,not-a-number",
      ].join("\n"),
    );

    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].index).toBe(1);
    expect(skippedRows[0].reason).toContain("Invalid twr");
    expect(validatedResult.snapshots).toHaveLength(1);
    expect(validatedResult.snapshots[0].twr).toBeUndefined();
  });

  it("does not apply the canonical decimal twr exclusion to IBKR activity snapshots", () => {
    const fixture = fs.readFileSync(
      path.join(__dirname, "../fixtures/ibkr-activity-sample.csv"),
      "utf-8",
    );
    const parsed = parseIbkrActivity(fixture, "IBKR 2025-01 activity.csv");

    expect(parsed.snapshots[0].source).toBe("ibkr-activity");
    expect(parsed.snapshots[0].twr).toBeGreaterThan(1);

    const { skippedRows, validatedResult } = validateParsedResult(parsed);

    expect(skippedRows.filter((row) => row.category === "snapshot")).toHaveLength(0);
    expect(validatedResult.snapshots).toHaveLength(1);
    expect(validatedResult.snapshots[0].twr).toBe(parsed.snapshots[0].twr);
  });
});

describe("validateParsedResult: present-but-unparseable price and fees", () => {
  const base = {
    accountName: "IBKR",
    tradeDate: "2025-03-15",
    type: "BUY",
    symbol: "ZQQ1",
    quantity: 50,
    amount: 500,
    sourceKey: "test:strict",
  };

  it("excludes a transaction with NaN price, naming the price", () => {
    const { skippedRows, validatedResult } = validateParsedResult(
      makeParsedResult({ transactions: [{ ...base, pricePerShare: NaN }] }),
    );
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].reason).toContain("Invalid price");
    expect(skippedRows[0].reason).toContain("not a number");
    expect(validatedResult.transactions).toHaveLength(0);
  });

  it("excludes a transaction with NaN fees, naming the fees", () => {
    const { skippedRows, validatedResult } = validateParsedResult(
      makeParsedResult({ transactions: [{ ...base, fees: NaN }] }),
    );
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].reason).toContain("Invalid fees");
    expect(validatedResult.transactions).toHaveLength(0);
  });

  it("keeps a transaction whose price and fees are blank (undefined)", () => {
    const { skippedRows, validatedResult } = validateParsedResult(
      makeParsedResult({ transactions: [{ ...base }] }),
    );
    expect(skippedRows).toHaveLength(0);
    expect(validatedResult.transactions).toHaveLength(1);
  });
});

describe("validateParsedResult: holdings cost basis and market value", () => {
  const header =
    "account,as_of_date,symbol,security_name,security_type,quantity,cost_basis,market_value";

  it("warns on and clears a non-numeric cost_basis or market_value, keeping the row", () => {
    const csv = [
      header,
      "IBKR,2025-06-30,AAA,A Inc,Stock,10,not-a-number,1000",
      "IBKR,2025-06-30,BBB,B Inc,Stock,10,900,also-garbage",
      "IBKR,2025-06-30,CCC,C Inc,Stock,10,900,1000",
    ].join("\n");
    const { skippedRows, warnings, validatedResult } = validateParsedResult(
      parseCanonicalCsv(csv, "holdings.csv"),
    );
    expect(skippedRows).toHaveLength(0);
    expect(validatedResult.holdings).toHaveLength(3);
    const [a, b, c] = validatedResult.holdings;
    expect(a.costBasis).toBeUndefined();
    expect(a.marketValue).toBe(1000);
    expect(b.costBasis).toBe(900);
    expect(b.marketValue).toBeUndefined();
    expect(c.costBasis).toBe(900);
    expect(c.marketValue).toBe(1000);
    expect(warnings.filter((w) => w.includes("(AAA)") && w.includes("cost_basis"))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("(BBB)") && w.includes("market_value"))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("(CCC)"))).toHaveLength(0);
  });
});

describe("validateParsedResult: snapshot optional numeric cells", () => {
  const header =
    "account,month_end_date,total_value,starting_value,deposits_withdrawals,dividends,interest,commissions,fees,investment_gain,twr";

  it("excludes a snapshot whose optional figure is present but unparseable, by name", () => {
    const rows = [
      "Vanguard Taxable,2026-01-31,100000,,,,,,,,5%",
      "Vanguard Taxable,2026-02-28,100000,,,,,,,,abc",
      "Vanguard Taxable,2026-03-31,100000,,,,,,,,5.0",
      "Vanguard Taxable,2026-04-30,100000,,,12.5,,,,,0.05",
      "Vanguard Taxable,2026-05-31,100000,,,n/a,,,,,",
    ].join("\n");
    const { skippedRows, validatedResult } = validateParsedResult(
      parseCanonicalCsv(`${header}\n${rows}`, "snapshots.csv"),
    );
    expect(skippedRows).toHaveLength(4);
    expect(skippedRows.map((r) => r.index)).toEqual([0, 1, 2, 4]);
    expect(skippedRows[0].reason).toContain("Invalid twr");
    expect(skippedRows[1].reason).toContain("Invalid twr");
    expect(skippedRows[2].reason).toContain("twr is a decimal");
    expect(skippedRows[3].reason).toContain("Invalid dividends");
    expect(validatedResult.snapshots).toHaveLength(1);
    expect(validatedResult.snapshots[0].monthEndDate).toBe("2026-04-30");
    expect(validatedResult.snapshots[0].dividends).toBe(12.5);
  });
});
