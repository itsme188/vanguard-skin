/**
 * QA (accounts-transactions--50-row-cap-sort-implies-full-history-
 * regression-1): the Accounts "Recent Transactions" list showed 50 rows of
 * thousands with no word about the cap, and a column sort re-ordered only
 * those 50. The list now states the cap and says which kind of sort is on
 * screen. There is no DOM harness, so this tests the two pure helpers and
 * pins the caption in the source. All figures are invented.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sortLoadedTransactions,
  transactionCapState,
} from "@/app/dashboard/components/TransactionHistory";
import type { TransactionWithSecurity } from "@/lib/queries/transactions";
import { anchorIndex } from "../helpers/source-anchor";

function row(id: number, type: string, amount: number | null): TransactionWithSecurity {
  return {
    id,
    account_id: 1,
    security_id: 1,
    import_batch_id: null,
    trade_date: "2024-05-07",
    settlement_date: null,
    type,
    quantity: 5,
    amount,
    price_per_share: null,
    fees: 0,
    is_external_flow: 0,
    source_key: `test:${id}`,
    notes: null,
    symbol: "AAA",
    security_name: "AAA Corp",
    account_name: "Test Account",
  } as unknown as TransactionWithSecurity;
}

describe("transactionCapState", () => {
  const url = { field: "amount" as const, dir: "desc" as const };

  it("says nothing when every row is shown or the total is unknown", () => {
    expect(transactionCapState(12, 12, undefined, url)).toBe("none");
    expect(transactionCapState(12, undefined, undefined, url)).toBe("none");
    expect(transactionCapState(12, null, url, url)).toBe("none");
    expect(transactionCapState(12, Number.NaN, url, url)).toBe("none");
  });

  it("claims a full-history sort only when the server sorted by the column on screen", () => {
    expect(transactionCapState(50, 400, url, url)).toBe("full-history");
  });

  it("admits the sort covers only the loaded rows otherwise", () => {
    expect(transactionCapState(50, 400, undefined, url)).toBe("loaded-only");
    expect(
      transactionCapState(50, 400, { field: "trade_date", dir: "desc" }, url),
    ).toBe("loaded-only");
    expect(
      transactionCapState(50, 400, { field: "amount", dir: "asc" }, url),
    ).toBe("loaded-only");
  });
});

describe("sortLoadedTransactions", () => {
  it("sorts Amount by the printed figure, the same order the server uses", () => {
    const rows = [row(1, "BUY", 500), row(2, "BUY", -900), row(3, "SELL", 300)];
    expect(sortLoadedTransactions(rows, "amount", "asc").map((r) => r.id)).toEqual([2, 1, 3]);
    expect(sortLoadedTransactions(rows, "amount", "desc").map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it("keeps a missing amount last in both directions and does not mutate the input", () => {
    const rows = [row(1, "DEPOSIT", null), row(2, "DEPOSIT", 10), row(3, "DEPOSIT", 20)];
    expect(sortLoadedTransactions(rows, "amount", "asc").map((r) => r.id)).toEqual([2, 3, 1]);
    expect(sortLoadedTransactions(rows, "amount", "desc").map((r) => r.id)).toEqual([3, 2, 1]);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("returns the rows as given when there is no sort field", () => {
    const rows = [row(2, "BUY", 1), row(1, "BUY", 2)];
    expect(sortLoadedTransactions(rows, null, "asc")).toBe(rows);
  });
});

describe("TransactionHistory source", () => {
  const src = readFileSync(
    join(process.cwd(), "app/dashboard/components/TransactionHistory.tsx"),
    "utf8",
  );

  it("states the cap with masked counts next to the heading", () => {
    const start = anchorIndex(src, 'capState !== "none" && (');
    const end = anchorIndex(src, "<ScrollFade>", start);
    const caption = src.slice(start, end);
    expect(caption).toContain("<Count value={transactions.length} />");
    expect(caption).toContain("<Count value={total} />");
    expect(caption).toContain("Showing");
  });

  it("renders server-sorted rows as they came instead of re-sorting them", () => {
    const start = anchorIndex(src, "const rows = useMemo(");
    const body = src.slice(start, anchorIndex(src, ");", start));
    expect(body).toMatch(/serverSorted\s*\?\s*transactions\s*:\s*sortLoadedTransactions\(/);
  });
});
