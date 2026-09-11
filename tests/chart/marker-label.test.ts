import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markerTypeLabel, transactionTypeLabel } from "@/lib/chart/marker-label";

// deep-QA: charts-txn-markers--raw-enum-transaction-type-labels-underscores
// SecurityChart's transaction-overlay markerText() used to render t.type raw,
// so option legs printed "BUY_TO_CLOSE 50" / "SELL_TO_OPEN 50" beside plain
// equity's "BUY 100" / "SELL 50". The underscore-enum leak was NOT
// chart-only: TransactionsSection.tsx's type chip and TransactionHistory.tsx's
// type pill (desktop + mobile) rendered the same raw t.type/txn.type. The
// chart keeps its own uppercase marker form (markerTypeLabel — space beside
// the candle is tight); the two table surfaces route through
// transactionTypeLabel (sentence-cased prose form) instead.
describe("markerTypeLabel", () => {
  it("replaces underscores with spaces for option-leg types", () => {
    expect(markerTypeLabel("BUY_TO_CLOSE")).toBe("BUY TO CLOSE");
    expect(markerTypeLabel("SELL_TO_OPEN")).toBe("SELL TO OPEN");
    expect(markerTypeLabel("BUY_TO_COVER")).toBe("BUY TO COVER");
  });

  it("leaves plain equity types unchanged", () => {
    expect(markerTypeLabel("BUY")).toBe("BUY");
    expect(markerTypeLabel("SELL")).toBe("SELL");
  });

  it("trims and collapses repeated spaces/underscores", () => {
    expect(markerTypeLabel("  BUY_TO_CLOSE  ")).toBe("BUY TO CLOSE");
    expect(markerTypeLabel("BUY__TO_CLOSE")).toBe("BUY TO CLOSE");
  });

  it("returns an empty string for empty/undefined input", () => {
    expect(markerTypeLabel("")).toBe("");
    expect(markerTypeLabel(undefined as unknown as string)).toBe("");
  });
});

// Source-scan: no jsdom/RTL harness in this repo (see CLAUDE.md testing
// conventions) — pin the wiring by reading the component source directly.
describe("SecurityChart.tsx wiring", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "app/dashboard/components/SecurityChart.tsx",
    ),
    "utf8",
  );

  it("imports markerTypeLabel from the shared helper", () => {
    expect(source).toMatch(
      /import\s*\{\s*markerTypeLabel\s*\}\s*from\s*["']@\/lib\/chart\/marker-label["']/,
    );
  });

  it("no longer interpolates t.type directly in markerText", () => {
    const match = source.match(
      /function markerText\([\s\S]*?\n\}/,
    );
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).not.toMatch(/\$\{t\.type\}/);
    expect(body).not.toMatch(/return t\.type;/);
    expect(body).toContain("markerTypeLabel(t.type)");
  });
});

describe("transactionTypeLabel", () => {
  it("de-underscores and sentence-cases multi-word option types", () => {
    expect(transactionTypeLabel("BUY_TO_OPEN")).toBe("Buy to open");
    expect(transactionTypeLabel("SELL_TO_CLOSE")).toBe("Sell to close");
    expect(transactionTypeLabel("BUY_TO_CLOSE")).toBe("Buy to close");
    expect(transactionTypeLabel("SELL_TO_OPEN")).toBe("Sell to open");
    expect(transactionTypeLabel("BUY_TO_COVER")).toBe("Buy to cover");
  });

  it("sentence-cases single-word ledger types", () => {
    expect(transactionTypeLabel("BUY")).toBe("Buy");
    expect(transactionTypeLabel("SELL")).toBe("Sell");
    expect(transactionTypeLabel("DIVIDEND")).toBe("Dividend");
    expect(transactionTypeLabel("INTEREST")).toBe("Interest");
    expect(transactionTypeLabel("FEE")).toBe("Fee");
    expect(transactionTypeLabel("COMMISSION")).toBe("Commission");
    expect(transactionTypeLabel("DEPOSIT")).toBe("Deposit");
    expect(transactionTypeLabel("WITHDRAWAL")).toBe("Withdrawal");
  });

  it("de-underscores and sentence-cases other multi-word ledger types", () => {
    expect(transactionTypeLabel("TAX_WITHHELD")).toBe("Tax withheld");
    expect(transactionTypeLabel("TRANSFER_IN")).toBe("Transfer in");
    expect(transactionTypeLabel("TRANSFER_OUT")).toBe("Transfer out");
  });

  it("handles a type with no underscores (single word) unchanged in shape", () => {
    expect(transactionTypeLabel("REINVESTMENT")).toBe("Reinvestment");
  });

  it("falls back gracefully for an unknown/future type — no lookup table needed", () => {
    expect(transactionTypeLabel("SOME_NEW_TYPE")).toBe("Some new type");
    expect(transactionTypeLabel("RECONCILE_CLOSE")).toBe("Reconcile close");
  });

  it("trims and collapses repeated spaces/underscores", () => {
    expect(transactionTypeLabel("  BUY_TO_CLOSE  ")).toBe("Buy to close");
    expect(transactionTypeLabel("BUY__TO_CLOSE")).toBe("Buy to close");
  });

  it("returns an empty string for empty/null/undefined input", () => {
    expect(transactionTypeLabel("")).toBe("");
    expect(transactionTypeLabel(null)).toBe("");
    expect(transactionTypeLabel(undefined)).toBe("");
  });
});

// Source-scan: no jsdom/RTL harness in this repo (see CLAUDE.md testing
// conventions) — pin the wiring by reading the component source directly.
// deep-QA: charts-txn-markers--raw-enum-transaction-type-labels-underscores
describe("TransactionsSection.tsx wiring", () => {
  const source = readFileSync(
    join(process.cwd(), "app/dashboard/components/TransactionsSection.tsx"),
    "utf8",
  );

  it("imports transactionTypeLabel from the shared helper", () => {
    expect(source).toMatch(
      /import\s*\{\s*transactionTypeLabel\s*\}\s*from\s*["']@\/lib\/chart\/marker-label["']/,
    );
  });

  it("no longer renders the raw t.type inside the type chip", () => {
    expect(source).not.toMatch(/\{t\.type\}/);
    expect(source).toContain("transactionTypeLabel(t.type)");
  });
});

describe("TransactionHistory.tsx wiring", () => {
  const source = readFileSync(
    join(process.cwd(), "app/dashboard/components/TransactionHistory.tsx"),
    "utf8",
  );

  it("imports transactionTypeLabel from the shared helper", () => {
    expect(source).toMatch(
      /import\s*\{\s*transactionTypeLabel\s*\}\s*from\s*["']@\/lib\/chart\/marker-label["']/,
    );
  });

  it("no longer renders the raw txn.type in either the desktop or mobile type pill", () => {
    expect(source).not.toMatch(/\{txn\.type\}/);
    const occurrences = source.match(/transactionTypeLabel\(txn\.type\)/g) ?? [];
    // Two pills render the type: the desktop-only cell and the mobile-only
    // inline pill beside the symbol.
    expect(occurrences.length).toBe(2);
  });
});
