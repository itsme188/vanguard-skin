/**
 * QA (accounts-holdings-footer--value-total-counts-unpriced-options-as-zero-
 * no-tilde): a held position with no current price shows a dash in its own
 * Value cell, but the footer's Value total printed an exact figure with no
 * mark on it, and an exact "$0.00" when none of the rows shown had a price.
 *
 * The footer keeps its "no tilde, no hover title" rule
 * (tests/dashboard/all-holdings-footer-disclosure.test.tsx): the mark is
 * visible words under the figure. Unknown is never zero: when no row shown
 * has a price the Value total (and the Alloc % total) is a dash.
 *
 * Both Accounts tables are covered: All Accounts and one account.
 * Fixtures are synthetic: ZZ* tickers, round numbers.
 */
import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AllHoldingsTable,
  summarizeHoldingsFooter,
  type AllHoldingsRow,
} from "@/app/dashboard/components/AllHoldingsTable";
import { HoldingsTable } from "@/app/dashboard/components/HoldingsTable";
import type { AccountHoldingRow } from "@/lib/queries/holdings";
import { PrivacyProvider } from "@/lib/privacy/context";
import { sliceBetween } from "@/tests/helpers/source-anchor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/accounts",
}));

const MARK = "priced positions only";

let nextId = 1;
/** A row as the holdings queries produce it: no price means no value and no gain. */
function allRow(symbol: string, f: { cost: number | null; value: number | null }): AllHoldingsRow {
  const known = f.cost !== null && f.cost !== 0;
  return {
    account_id: 1,
    account_name: "ZZ Account",
    security_id: nextId++,
    symbol,
    security_name: `${symbol} Corp`,
    security_type: "Stock",
    multiplier: 1,
    quantity: 10,
    cost_basis: f.cost,
    as_of_date: "2026-03-03",
    current_price: f.value === null ? null : f.value / 10,
    current_value: f.value,
    unrealized_gain: f.value !== null && known ? f.value - f.cost! : null,
  };
}

function accountRow(symbol: string, f: { cost: number | null; value: number | null }): AccountHoldingRow {
  const base = allRow(symbol, f);
  return {
    ...base,
    id: base.security_id,
    import_batch_id: null,
    source_key: `zz:${symbol}`,
    underlying_symbol: null,
    strike_price: null,
    expiration_date: null,
    option_type: null,
    fund_category: null,
  };
}

const wrap = (node: ReactNode) => renderToStaticMarkup(<PrivacyProvider>{node}</PrivacyProvider>);
const footerOf = (html: string) => sliceBetween(html, "<tfoot", "</tfoot>");
const cells = (footer: string) =>
  [...footer.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  );

const PRICED = { cost: 1000, value: 1500 };
const UNPRICED_WITH_BASIS = { cost: 500, value: null };
const UNPRICED_NO_BASIS = { cost: null, value: null };

describe("summarizeHoldingsFooter counts the rows Value cannot cover", () => {
  it("counts priced and unpriced rows; Value stays the sum of the priced ones", () => {
    const s = summarizeHoldingsFooter([
      allRow("ZZAAA", PRICED),
      allRow("ZZOPA", UNPRICED_WITH_BASIS),
      allRow("ZZOPB", UNPRICED_NO_BASIS),
    ]);
    expect(s.totalValue).toBe(1500);
    expect(s.pricedCount).toBe(1);
    expect(s.unpricedCount).toBe(2);
    // The same rows the two disclosure sentences name.
    expect(s.unpricedCount).toBe(s.noPriceCount + s.noBasisUnpricedCount);
  });

  it("a real zero value is priced, not unknown", () => {
    const s = summarizeHoldingsFooter([allRow("ZZZRO", { cost: 100, value: 0 })]);
    expect(s.pricedCount).toBe(1);
    expect(s.unpricedCount).toBe(0);
  });

  it("every row priced: nothing to mark", () => {
    const s = summarizeHoldingsFooter([allRow("ZZAAA", PRICED), allRow("ZZBBB", PRICED)]);
    expect(s.unpricedCount).toBe(0);
    expect(s.pricedCount).toBe(2);
  });
});

describe("All Accounts footer Value", () => {
  // Footer cells: label (colSpan 4), Cost Basis, Value, Gain, Gain %, Alloc %.
  const VALUE = 2;
  const ALLOC = 5;

  it("marks the Value total in visible words when a row shown has no price", () => {
    const footer = footerOf(
      wrap(<AllHoldingsTable holdings={[allRow("ZZAAA", PRICED), allRow("ZZOPA", UNPRICED_WITH_BASIS)]} />),
    );
    const value = cells(footer)[VALUE];
    expect(value).toContain("$1,500.00");
    expect(value).toContain(MARK);
    // Visible words only: the footer's no-tilde, no-hover rule still holds.
    expect(footer).not.toContain("~");
    expect(footer).not.toContain("title=");
  });

  it("prints a dash, never $0.00, when no row shown has a price", () => {
    const footer = footerOf(
      wrap(<AllHoldingsTable holdings={[allRow("ZZOPA", UNPRICED_WITH_BASIS), allRow("ZZOPB", UNPRICED_NO_BASIS)]} />),
    );
    const row = cells(footer);
    expect(row[VALUE]).toBe("—");
    expect(row[ALLOC]).toBe("—");
    expect(footer).not.toContain("$0.00");
    expect(footer).not.toContain("0.00%");
    // Cost Basis is still known for the row that has one.
    expect(row[1]).toBe("$500.00");
  });

  it("leaves the Value total unmarked when every row is priced", () => {
    const footer = footerOf(
      wrap(<AllHoldingsTable holdings={[allRow("ZZAAA", PRICED), allRow("ZZBBB", PRICED)]} />),
    );
    expect(cells(footer)[VALUE]).toBe("$3,000.00");
    expect(footer).not.toContain(MARK);
  });

  it("a real zero-value position still totals to a figure", () => {
    const footer = footerOf(wrap(<AllHoldingsTable holdings={[allRow("ZZZRO", { cost: 100, value: 0 })]} />));
    expect(cells(footer)[VALUE]).toBe("$0.00");
  });
});

describe("single-account footer Value", () => {
  // Footer cells: label, (hidden name), (quantity), Cost Basis, Value, Gain, Gain %.
  const VALUE = 4;

  it("marks the Value total in visible words when a row shown has no price", () => {
    const footer = footerOf(
      wrap(
        <HoldingsTable
          holdings={[accountRow("ZZAAA", PRICED), accountRow("ZZOPA", UNPRICED_NO_BASIS)]}
          cashLine={null}
        />,
      ),
    );
    const value = cells(footer)[VALUE];
    expect(value).toContain("$1,500.00");
    expect(value).toContain(MARK);
    expect(footer).not.toContain("~");
    expect(footer).not.toContain("title=");
  });

  it("prints a dash, never $0.00, when no row shown has a price", () => {
    const footer = footerOf(
      wrap(<HoldingsTable holdings={[accountRow("ZZOPA", UNPRICED_WITH_BASIS)]} cashLine={null} />),
    );
    expect(cells(footer)[VALUE]).toBe("—");
    expect(footer).not.toContain("$0.00");
  });

  it("leaves the Value total unmarked when every row is priced", () => {
    const footer = footerOf(wrap(<HoldingsTable holdings={[accountRow("ZZAAA", PRICED)]} cashLine={null} />));
    expect(cells(footer)[VALUE]).toBe("$1,500.00");
    expect(footer).not.toContain(MARK);
  });
});

describe("the mark is readable and masks nothing it should not", () => {
  it("uses the readable small-text tone, and the figure still goes through Money", () => {
    const html = wrap(
      <AllHoldingsTable holdings={[allRow("ZZAAA", PRICED), allRow("ZZOPA", UNPRICED_WITH_BASIS)]} />,
    );
    const footer = footerOf(html);
    const at = footer.indexOf(MARK);
    const opening = footer.slice(footer.lastIndexOf("<", at), at);
    expect(opening).toContain("text-ink-dim");
    expect(opening).not.toContain("text-ink-faint");
    expect(opening).toContain("whitespace-nowrap");
  });
});
