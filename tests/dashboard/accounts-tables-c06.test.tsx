import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AllHoldingsTable,
  holdingDisplayName,
  type AllHoldingsRow,
} from "@/app/dashboard/components/AllHoldingsTable";
import { HoldingsTable } from "@/app/dashboard/components/HoldingsTable";
import { transactionTypeChipClass } from "@/app/dashboard/components/TransactionHistory";
import { PrivacyProvider } from "@/lib/privacy/context";
import type { AccountHoldingRow } from "@/lib/queries/holdings";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

/**
 * Accounts tables, QA unit C06 (decisions taken on the recommended option,
 * 2026-10-07).
 *
 * No DOM harness in this repo: behaviour is tested on the exported pure
 * functions and on static markup; the typed-filter paths are pinned in the
 * source. Fixtures are synthetic: ZZ* tickers, round invented numbers.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/accounts",
}));

const DAY = "2026-03-10";
// OCC: root padded to 6, YYMMDD, C or P, strike x 1000 padded to 8.
const ZZ_CALL = "ZZETF 261009C00190000";
const ZZ_PUT = "ZZCO  261120P00012500";

let nextId = 1;
function allRow(symbol: string, over: Partial<AllHoldingsRow> = {}): AllHoldingsRow {
  return {
    account_id: 1,
    account_name: "ZZ Account",
    security_id: nextId++,
    symbol,
    security_name: `${symbol} Corp`,
    security_type: "Stock",
    multiplier: 1,
    quantity: 10,
    cost_basis: 1000,
    as_of_date: DAY,
    current_price: 120,
    current_value: 1200,
    unrealized_gain: 200,
    ...over,
  };
}

function accountRow(symbol: string, over: Partial<AccountHoldingRow> = {}): AccountHoldingRow {
  const id = nextId++;
  return {
    id,
    account_id: 1,
    security_id: id,
    quantity: 10,
    cost_basis: 1000,
    as_of_date: DAY,
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
    fund_category: null,
    current_price: 120,
    current_value: 1200,
    unrealized_gain: 200,
    ...over,
  };
}

const wrap = (node: ReactNode) => renderToStaticMarkup(<PrivacyProvider>{node}</PrivacyProvider>);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("option trade chips follow cash direction (option 1)", () => {
  // accounts-transactions--option-trade-type-chips-neutral-grey-while-equity-buy-sell-coloured
  const NEUTRAL = "bg-raised text-ink-dim";

  it.each(["BUY_TO_OPEN", "BUY_TO_CLOSE"])("%s is coloured like an equity Buy", (type) => {
    expect(transactionTypeChipClass(type)).toBe(transactionTypeChipClass("BUY"));
    expect(transactionTypeChipClass(type)).not.toBe(NEUTRAL);
  });

  it.each(["SELL_TO_OPEN", "SELL_TO_CLOSE"])("%s is coloured like an equity Sell", (type) => {
    expect(transactionTypeChipClass(type)).toBe(transactionTypeChipClass("SELL"));
    expect(transactionTypeChipClass(type)).not.toBe(NEUTRAL);
  });

  it("a buy and a sell never share a colour", () => {
    expect(transactionTypeChipClass("BUY_TO_OPEN")).not.toBe(
      transactionTypeChipClass("SELL_TO_OPEN"),
    );
  });

  it.each(["EXPIRED", "REINVESTMENT", "SOME_FUTURE_TYPE"])("%s stays neutral", (type) => {
    expect(transactionTypeChipClass(type)).toBe(NEUTRAL);
  });

  it("both chips (desktop cell and phone tag) read the one function", () => {
    const src = readFileSync("app/dashboard/components/TransactionHistory.tsx", "utf8");
    const body = src.slice(anchorIndex(src, "<tbody>"));
    expect(body.match(/transactionTypeChipClass\(transactionDisplayType\(txn\.type, txn\.notes\)\)/g)!.length).toBe(2);
    expect(body).not.toContain("TYPE_STYLES[");
  });
});

describe("an option row never reads as its underlying (option 2, render fallback)", () => {
  // accounts-holdings-all--ibkr-option-row-name-shows-underlying-etf-name
  it("replaces an underlying's name with the contract read off the symbol", () => {
    expect(
      holdingDisplayName({
        symbol: ZZ_CALL,
        security_name: "ZZ MSCI EXAMPLE ETF",
        security_type: "Option",
      }),
    ).toBe("ZZETF 10/09/26 190.00 Call");
    expect(
      holdingDisplayName({
        symbol: ZZ_PUT,
        security_name: "ZZ COS INC-CLASS A",
        security_type: "option",
      }),
    ).toBe("ZZCO 11/20/26 12.50 Put");
  });

  it("a trust name that happens to carry a digit is still not a contract", () => {
    expect(
      holdingDisplayName({
        symbol: ZZ_CALL,
        security_name: "ZZ EXAMPLE TRUST SERIES 1",
        security_type: "Option",
      }),
    ).toBe("ZZETF 10/09/26 190.00 Call");
  });

  it("a blank option name gets the contract too, not a dash", () => {
    for (const security_name of [null, "", "   "]) {
      expect(holdingDisplayName({ symbol: ZZ_CALL, security_name, security_type: "Option" })).toBe(
        "ZZETF 10/09/26 190.00 Call",
      );
    }
  });

  it("keeps a stored name that already describes a contract, word for word", () => {
    for (const security_name of [
      "ZZETF 10/30/26 190.00 Call",
      "ZZETF OCT 30 2026 190 CALL",
      "PUT ZZCO $12.50 EXP 2026-11-20",
    ]) {
      expect(holdingDisplayName({ symbol: ZZ_CALL, security_name, security_type: "Option" })).toBe(
        security_name,
      );
    }
  });

  it("never touches a row that is not an option", () => {
    expect(
      holdingDisplayName({ symbol: "ZZETF", security_name: "ZZ MSCI EXAMPLE ETF", security_type: "ETF" }),
    ).toBe("ZZ MSCI EXAMPLE ETF");
    // An OCC-shaped symbol on a non-option type is left alone: the type decides.
    expect(
      holdingDisplayName({ symbol: ZZ_CALL, security_name: "ZZ MSCI EXAMPLE ETF", security_type: "Stock" }),
    ).toBe("ZZ MSCI EXAMPLE ETF");
    expect(holdingDisplayName({ symbol: "ZZAAA", security_name: "", security_type: null })).toBe("—");
  });

  it("an option whose symbol cannot be read keeps what is stored", () => {
    expect(
      holdingDisplayName({ symbol: "ZZETF", security_name: "ZZ MSCI EXAMPLE ETF", security_type: "Option" }),
    ).toBe("ZZ MSCI EXAMPLE ETF");
    expect(holdingDisplayName({ symbol: "ZZETF", security_name: null, security_type: "Option" })).toBe("—");
  });

  it("the All Accounts Name cell and its title show the contract", () => {
    const markup = wrap(
      <AllHoldingsTable
        holdings={[
          allRow(ZZ_CALL, { security_name: "ZZ MSCI EXAMPLE ETF", security_type: "Option" }),
        ]}
      />,
    );
    expect(markup).toContain('title="ZZETF 10/09/26 190.00 Call"');
    expect(text(markup)).toContain("ZZETF 10/09/26 190.00 Call");
    expect(markup).not.toContain("ZZ MSCI EXAMPLE ETF");
  });

  it("the single-account Name cell shows the same contract", () => {
    const markup = wrap(
      <HoldingsTable
        holdings={[
          accountRow(ZZ_PUT, { security_name: "ZZ COS INC-CLASS A", security_type: "Option" }),
        ]}
        cashLine={null}
      />,
    );
    expect(markup).toContain('title="ZZCO 11/20/26 12.50 Put"');
    expect(markup).not.toContain("ZZ COS INC-CLASS A");
  });

  it("the filter matches the name on screen as well as the stored one", () => {
    const src = readFileSync("app/dashboard/components/AllHoldingsTable.tsx", "utf8");
    const filterSrc = sliceBetween(src, "const filtered = useMemo", "[holdings, filter]");
    expect(filterSrc).toContain("holdingDisplayName(h)");
    expect(filterSrc).toContain("h.security_name");
  });
});

describe("All Accounts position counts go through <Count>", () => {
  const BOOK = [allRow("ZZAAA"), allRow("ZZBBB"), allRow("ZZCCC")];

  it("the total row prints the count, in one wording for one position or many", () => {
    const footer = (rows: AllHoldingsRow[]) =>
      text(sliceBetween(wrap(<AllHoldingsTable holdings={rows} />), "<tfoot", "</tfoot>"));
    expect(footer(BOOK)).toContain("Total (positions: 3 )");
    expect(footer([allRow("ZZAAA")])).toContain("Total (positions: 1 )");
  });

  it("no count in the table source is printed bare", () => {
    const src = readFileSync("app/dashboard/components/AllHoldingsTable.tsx", "utf8");
    const table = src.slice(anchorIndex(src, "export function AllHoldingsTable"));
    expect(table).not.toMatch(/(?<!value=)\{(filtered|holdings)\.length\}/);
    expect(table).not.toMatch(/\$\{(filtered|holdings)\.length\}/);
    // Total row, "x of y" (two) and the no-match row.
    const upTo = table.slice(0, anchorIndex(table, "export function HoldingsFooterDisclosures"));
    expect(upTo.match(/<Count value=\{(filtered|holdings)\.length\} \/>/g)!.length).toBe(4);
  });
});
