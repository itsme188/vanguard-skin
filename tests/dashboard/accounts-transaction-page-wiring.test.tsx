/**
 * The Accounts page fetched the newest 50 transactions and passed no total
 * or server sort, so the list could not state its cap and a column sort only
 * re-ordered the loaded rows. The page now reads the `txnsSort` / `txnsDir`
 * search params (what useSortParam("txns") writes) through
 * getAccountTransactionPage and hands total + sort down to the table.
 *
 * No DOM harness: the server page is source-pinned; AccountDetail is rendered
 * to static markup. Fixtures are synthetic.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountDetail } from "@/app/dashboard/components/AccountDetail";
import { PrivacyProvider } from "@/lib/privacy/context";
import type { TransactionWithSecurity } from "@/lib/queries/transactions";
import type { Account } from "@/lib/types";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/accounts",
}));

const page = readFileSync("app/dashboard/accounts/page.tsx", "utf8");
const table = readFileSync("app/dashboard/components/TransactionHistory.tsx", "utf8");
const hook = readFileSync("lib/hooks/useSortParam.ts", "utf8");

describe("accounts page transaction wiring (source pin)", () => {
  it("reads the same URL params the table's sort hook writes", () => {
    // The table's scope is "txns"; the hook appends Sort / Dir to the scope.
    anchorIndex(table, 'useSortParam<Field>("txns"');
    anchorIndex(hook, "const sortKey = `${scope}Sort`;");
    anchorIndex(hook, "const dirKey = `${scope}Dir`;");
    expect(page).toMatch(/searchParams:\s*Promise<\{[^}]*txnsSort\?:\s*string;[^}]*txnsDir\?:\s*string/);
    const call = sliceBetween(page, "getAccountTransactionPage(db,", "});");
    expect(call).toMatch(/sortParam:\s*searchParams\.txnsSort/);
    expect(call).toMatch(/dirParam:\s*searchParams\.txnsDir/);
    expect(call).toMatch(/limit:\s*50/);
  });

  it("no longer fetches an unsorted, uncounted page", () => {
    expect(page).not.toContain("getTransactionsByAccount");
  });

  it("passes rows, total and sort to AccountDetail and stays force-dynamic", () => {
    const detail = sliceBetween(page, "<AccountDetail", "/>");
    expect(detail).toMatch(/transactions=\{transactionPage\.rows\}/);
    expect(detail).toMatch(/transactionTotal=\{transactionPage\.total\}/);
    expect(detail).toMatch(/transactionSort=\{transactionPage\.sort\}/);
    expect(page).toContain('export const dynamic = "force-dynamic";');
    expect(page).toContain("await props.searchParams");
  });
});

const account = { id: 1, name: "Test AAA" } as Account;
const txn = (id: number): TransactionWithSecurity =>
  ({
    id,
    account_id: 1,
    security_id: null,
    trade_date: `2020-01-${String(id).padStart(2, "0")}`,
    type: "DEPOSIT",
    quantity: null,
    price_per_share: null,
    amount: 100,
    symbol: null,
    security_name: null,
    account_name: "Test AAA",
  }) as unknown as TransactionWithSecurity;

function render(props: { total?: number; sort?: { field: "trade_date" | "amount"; dir: "asc" | "desc" } }) {
  return renderToStaticMarkup(
    <PrivacyProvider>
      <AccountDetail
        selectedAccount={account}
        holdings={[]}
        transactions={[txn(1), txn(2)]}
        snapshots={[]}
        transactionTotal={props.total}
        transactionSort={props.sort}
      />
    </PrivacyProvider>,
  );
}

describe("AccountDetail hands total and server sort to the table", () => {
  it("states the cap when the account has more rows than are shown", () => {
    const html = render({ total: 40, sort: { field: "trade_date", dir: "desc" } });
    expect(html).toContain("Showing");
    expect(html).toContain("Sorting a column sorts the full history");
  });

  it("says the sort covers only the loaded rows when the server sort differs", () => {
    const html = render({ total: 40, sort: { field: "amount", dir: "desc" } });
    expect(html).toContain("The sort covers only the rows shown.");
  });

  it("shows no caption when every row is on screen or no total is given", () => {
    expect(render({ total: 2, sort: { field: "trade_date", dir: "desc" } })).not.toContain("Showing");
    expect(render({})).not.toContain("Showing");
  });
});
