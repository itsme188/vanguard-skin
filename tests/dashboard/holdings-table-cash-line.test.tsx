import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { HoldingsTable } from "@/app/dashboard/components/HoldingsTable";
import { PrivacyProvider } from "@/lib/privacy/context";
import type { HoldingWithSecurity } from "@/lib/queries/holdings";
import {
  LIVE_SNAPSHOT_CASH_CAPTION,
  type AccountCashLine,
} from "@/lib/queries/account-cash-line";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

/**
 * The single-account Holdings table had no value total and no cash figure,
 * so the Equity Curve above it asserted an account total the page never
 * accounted for. The footer now states positions, cash and the account
 * total from the account's latest daily valuation, with the date.
 *
 * Fixtures are synthetic: ZZ* tickers, round numbers.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/accounts",
}));

function holding(id: number, symbol: string): HoldingWithSecurity {
  return {
    id,
    account_id: 1,
    security_id: id,
    quantity: 10,
    cost_basis: 1000,
    as_of_date: "2026-03-03",
    import_batch_id: null,
    source_key: `zz:${symbol}`,
    symbol,
    security_name: `${symbol} Corp`,
    security_type: "Stock",
    account_name: "ZZ Account",
    underlying_symbol: null,
    strike_price: null,
    expiration_date: null,
    option_type: null,
    multiplier: 1,
  } as HoldingWithSecurity;
}

function cashLine(over: Partial<AccountCashLine> = {}): AccountCashLine {
  return {
    accountId: 1,
    valuationDate: "2026-03-03",
    holdingsValue: 7000,
    cashBalance: 3000,
    totalValue: 10000,
    holdingsCount: 2,
    pricedCount: 2,
    anchorDate: "2026-02-28",
    isLiveSource: false,
    liveSourceCaption: null,
    cashEquivalentSymbols: [],
    ...over,
  };
}

function render(holdings: HoldingWithSecurity[], line: AccountCashLine | null): string {
  return renderToStaticMarkup(
    <PrivacyProvider>
      <HoldingsTable holdings={holdings} cashLine={line} />
    </PrivacyProvider>,
  );
}

const ROWS = [holding(1, "ZZAAA"), holding(2, "ZZBBB")];

describe("HoldingsTable account value footer (rendered)", () => {
  it("shows positions, cash and the account total, each with the valuation date", () => {
    const html = render(ROWS, cashLine());
    const block = html.slice(anchorIndex(html, 'data-account-value="lines"'));
    expect(block).toContain("Positions at market value");
    expect(block).toContain("$7,000.00");
    expect(block).toContain("Cash");
    expect(block).toContain("$3,000.00");
    expect(block).toContain("Account total");
    expect(block).toContain("$10,000.00");
    expect(block.match(/2026-03-03/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("adds no live or sweep caption for a statement-anchored broker account", () => {
    const html = render(ROWS, cashLine());
    expect(html).not.toContain("timing residual");
    expect(html).not.toContain("data-account-value=\"sweep-note\"");
    expect(html).not.toContain("data-account-value=\"unpriced-note\"");
  });

  it("carries the live-snapshot caption on a live-source day", () => {
    const html = render(
      ROWS,
      cashLine({ isLiveSource: true, liveSourceCaption: LIVE_SNAPSHOT_CASH_CAPTION, anchorDate: "2026-03-03" }),
    );
    const note = sliceBetween(html, 'data-account-value="live-note"', "</p>");
    expect(note).toContain(
      "live-snapshot timing residual (intraday broker total vs close-priced holdings)",
    );
  });

  it("says sweep funds listed as rows are already inside Cash, so they are not stated twice", () => {
    const html = render(
      [...ROWS, holding(3, "ZZSWEEP")],
      cashLine({ cashEquivalentSymbols: ["ZZSWEEP"] }),
    );
    const note = sliceBetween(html, 'data-account-value="sweep-note"', "</p>");
    expect(note).toContain("ZZSWEEP");
    expect(note).toContain("counted in Cash");
    expect(note).toContain("not in Positions");
  });

  it("says so when some positions had no price on the valuation date", () => {
    const html = render(ROWS, cashLine({ holdingsCount: 4, pricedCount: 3 }));
    const note = sliceBetween(html, 'data-account-value="unpriced-note"', "</p>");
    expect(note).toMatch(/>3</);
    expect(note).toMatch(/>4</);
    expect(note).toContain("not in the Positions figure");
  });

  it("explains the gap instead of rendering nothing when there is no daily valuation", () => {
    const html = render(ROWS, null);
    const note = sliceBetween(html, 'data-account-value="none"', "</p>");
    expect(note).toContain("No daily valuation");
    expect(html).not.toContain('data-account-value="lines"');
  });

  it("still shows the cash figure for an account with no holdings rows", () => {
    const html = render([], cashLine({ holdingsValue: 0, cashBalance: 500, totalValue: 500, holdingsCount: 0, pricedCount: 0 }));
    expect(html).toContain("No holdings data");
    expect(html).toContain('data-account-value="lines"');
    expect(html).toContain("$500.00");
  });

  it("never invents a holdings row for cash", () => {
    const html = render(ROWS, cashLine());
    expect(sliceBetween(html, "<tbody", "</tbody>").match(/<tr/g)!.length).toBe(ROWS.length);
  });
});

describe("HoldingsTable account value footer (source)", () => {
  const src = () => readFileSync("app/dashboard/components/HoldingsTable.tsx", "utf8");

  it("renders every figure through the privacy components", () => {
    const text = src();
    expect(text).toContain("<Money value={cashLine.holdingsValue} precise />");
    expect(text).toContain("<Money value={cashLine.cashBalance} precise />");
    expect(text).toContain("<Money value={cashLine.totalValue} precise />");
    expect(text).toContain("<Count value={cashLine.pricedCount} />");
    expect(text).toContain("<Count value={cashLine.holdingsCount} />");
    expect(text).not.toMatch(/formatUSD|toLocaleString|toFixed/);
  });

  it("takes the live caption from the query, never a second wording in the component", () => {
    const text = src();
    expect(text).toContain("{cashLine.liveSourceCaption}");
    expect(text).not.toContain("timing residual");
  });

  it("uses no hover-only affordance and no caret in the new footer", () => {
    const text = src();
    const block = text.slice(anchorIndex(text, "function AccountValueLines"), anchorIndex(text, "export function HoldingsTable"));
    expect(block).not.toContain("title=");
    expect(block).not.toContain("cursor-help");
    expect(block).not.toMatch(/[▾▸▼▲^]/);
    expect(block).not.toContain("text-ink-faint");
  });

  it("the accounts page loads the cash line for the selected account and stays force-dynamic", () => {
    const page = readFileSync("app/dashboard/accounts/page.tsx", "utf8");
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toContain("getAccountCashLine(db, selectedAccount.id)");
    const detail = readFileSync("app/dashboard/components/AccountDetail.tsx", "utf8");
    expect(detail).toContain("<HoldingsTable holdings={holdings} cashLine={cashLine ?? null} />");
  });
});
