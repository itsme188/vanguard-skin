import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AllHoldingsTable,
  holdingsSortValue,
  summarizeHoldingsFooter,
  summarizeStaleRows,
  type AllHoldingsRow,
} from "@/app/dashboard/components/AllHoldingsTable";
import { HoldingsTable } from "@/app/dashboard/components/HoldingsTable";
import { PrivacyProvider } from "@/lib/privacy/context";
import { compareValues } from "@/lib/hooks/useSortParam";
import type { AccountHoldingRow } from "@/lib/queries/holdings";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

/**
 * The Accounts holdings tables (QA units A01 + B04).
 *
 * No DOM harness in this repo: behaviour is tested on the exported pure
 * functions and on static markup; interaction-only paths (a typed filter)
 * are pinned in the source. Fixtures are synthetic: ZZ* tickers, round
 * invented numbers.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/accounts",
}));

const NEWEST = "2026-03-10";
const OLDER = "2026-02-28";

let nextId = 1;
function accountRow(symbol: string, over: Partial<AccountHoldingRow> = {}): AccountHoldingRow {
  const id = nextId++;
  return {
    id,
    account_id: 1,
    security_id: id,
    quantity: 10,
    cost_basis: 1000,
    as_of_date: NEWEST,
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
    as_of_date: NEWEST,
    current_price: 120,
    current_value: 1200,
    unrealized_gain: 200,
    ...over,
  };
}

const wrap = (node: ReactNode) => renderToStaticMarkup(<PrivacyProvider>{node}</PrivacyProvider>);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const headers = (html: string) =>
  [...sliceBetween(html, "<thead", "</thead>").matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);

describe("single-account Holdings table (A01, ruling 2026-08-30)", () => {
  // A stock, a bond, an option, a short and a foreign-currency row, each
  // already valued in dollars by the query (tests/queries/
  // holdings-valued-by-account.test.ts covers the valuation itself).
  const BOOK = [
    accountRow("ZZAAA", { current_value: 500, cost_basis: 400, unrealized_gain: 100 }),
    accountRow("ZZBOND", {
      security_type: "Bond",
      quantity: 10000,
      current_value: 9900,
      cost_basis: 9800,
      unrealized_gain: 100,
      as_of_date: OLDER,
    }),
    accountRow("ZZOPT", {
      security_type: "Option",
      underlying_symbol: "ZZAAA",
      strike_price: 50,
      option_type: "CALL",
      expiration_date: "2026-06-19",
      multiplier: 100,
      quantity: 2,
      current_value: 600,
      cost_basis: 500,
      unrealized_gain: 100,
    }),
    accountRow("ZZSHT", { quantity: -10, current_value: -500, cost_basis: -600, unrealized_gain: 100 }),
    accountRow("ZZJPY", { quantity: 100, current_value: 700, cost_basis: 560, unrealized_gain: 140 }),
  ];
  const html = () => wrap(<HoldingsTable holdings={BOOK} cashLine={null} />);

  it("has the value and gain columns, sortable, and no Account or Alloc % column", () => {
    expect(headers(html())).toEqual([
      "Symbol",
      "Name",
      "Quantity",
      "Cost Basis",
      "Value",
      "Gain",
      "Gain %",
    ]);
    // Every header is a SortableHeader button.
    expect(sliceBetween(html(), "<thead", "</thead>").match(/<button/g)!.length).toBe(7);
  });

  it("prints each row's value and gain", () => {
    const body = text(sliceBetween(html(), "<tbody", "</tbody>"));
    expect(body).toContain("$9,900.00");
    expect(body).toContain("$600.00");
    expect(body).toContain("−$500.00");
    expect(body).toContain("+$140.00");
    // 140 / 560
    expect(body).toContain("+25.00%");
  });

  it("the total row is the sum of the rows shown", () => {
    const footer = text(sliceBetween(html(), "<tfoot", "</tfoot>"));
    const summary = summarizeHoldingsFooter(BOOK);
    expect(summary.totalValue).toBe(500 + 9900 + 600 - 500 + 700);
    expect(summary.totalCostBasis).toBe(400 + 9800 + 500 - 600 + 560);
    expect(summary.totalGain).toBe(540);
    expect(footer).toContain("$11,200.00");
    expect(footer).toContain("$10,660.00");
    expect(footer).toContain("+$540.00");
    expect(footer).toContain("Total (positions: 5 )");
  });

  it("has a filter input", () => {
    expect(html()).toContain('placeholder="Filter by symbol or name…"');
  });

  it("marks the row older than the newest snapshot, and says so under the table", () => {
    const markup = html();
    const rows = sliceBetween(markup, "<tbody", "</tbody>").split("<tr").slice(1);
    const bond = rows.find((r) => r.includes("ZZBOND"))!;
    expect(bond).toContain("as of 02-28");
    expect(bond).toContain(`Quantity as of ${OLDER}`);
    expect(rows.filter((r) => r.includes("as of ")).length).toBe(1);
    const caption = text(sliceBetween(markup, 'data-footer-disclosure="stale"', "</p>"));
    expect(caption).toContain(`Positions carried from a snapshot older than ${NEWEST} : 1 , the oldest as of ${OLDER} .`);
    // The old dedicated column is gone: the chip replaces it.
    expect(headers(markup)).not.toContain("As Of");
  });

  it("keeps the option description, the unit noun and the full name on hover", () => {
    const markup = html();
    expect(markup).toContain("ZZAAA $50 CALL 6/19/26");
    expect(text(markup)).toContain("2 contracts");
    expect(text(markup)).toContain("10,000 face value");
    expect(markup).toContain('title="ZZBOND Corp"');
  });

  it("masks every figure and count under Hide amounts (source: privacy components only)", () => {
    const src = readFileSync("app/dashboard/components/HoldingsTable.tsx", "utf8");
    const table = src.slice(anchorIndex(src, "export function HoldingsTable"));
    expect(table).toContain("<Money value={holding.current_value} precise />");
    expect(table).toContain("<GainCell value={holding.unrealized_gain} />");
    expect(table).toContain("<GainPercentCell value={holding.gain_pct} />");
    expect(table).toContain("<Money value={footer.totalValue} precise />");
    expect(table).toContain("<Count value={filtered.length} />");
    expect(table).not.toMatch(/formatUSD|formatPercent|toLocaleString|toFixed/);
    // No count interpolated into plain text.
    expect(table).not.toMatch(/\$\{(filtered|holdings)\.length\}/);
    expect(table).not.toMatch(/\{(filtered|holdings)\.length\}\s*(positions|of)/);
  });

  it("totals and stale marks are computed over the filtered rows", () => {
    const src = readFileSync("app/dashboard/components/HoldingsTable.tsx", "utf8");
    expect(src).toContain("summarizeHoldingsFooter(filtered)");
    expect(src).toContain("summarizeStaleRows(filtered, holdings)");
    expect(src).toContain('useSortParam<Field>("holdings", "current_value", "desc")');
  });

  it("the accounts page reads the priced per-account rows", () => {
    const page = readFileSync("app/dashboard/accounts/page.tsx", "utf8");
    expect(page).toContain("getValuedHoldingsByAccount(db, selectedAccount.id)");
  });
});

describe("All Accounts Holdings table", () => {
  it("marks only the rows older than the newest snapshot (ruling 2026-09-02)", () => {
    const markup = wrap(
      <AllHoldingsTable
        holdings={[
          allRow("ZZNEW"),
          allRow("ZZOLD", { as_of_date: OLDER }),
          allRow("ZZOLDER", { as_of_date: "2026-01-31" }),
        ]}
      />,
    );
    const rows = sliceBetween(markup, "<tbody", "</tbody>").split("<tr").slice(1);
    expect(rows.find((r) => r.includes("ZZNEW"))).not.toContain("as of ");
    expect(rows.find((r) => r.includes(">ZZOLD<"))).toContain("as of 02-28");
    expect(rows.find((r) => r.includes("ZZOLDER"))).toContain("as of 01-31");
    const caption = text(sliceBetween(markup, 'data-footer-disclosure="stale"', "</p>"));
    expect(caption).toContain(`older than ${NEWEST} : 2 , the oldest as of 2026-01-31 .`);
    // No new column.
    expect(headers(markup)).toEqual([
      "Symbol", "Name", "Account", "Qty", "Cost Basis", "Value", "Gain", "Gain %", "Alloc %",
    ]);
  });

  it("adds no chip and no caption when every row shares the newest date", () => {
    const markup = wrap(<AllHoldingsTable holdings={[allRow("ZZAAA"), allRow("ZZBBB")]} />);
    expect(markup).not.toContain("as of ");
    expect(markup).not.toContain("data-footer-disclosure");
  });

  it("the stale caption keeps one wording for one position or many", () => {
    const strip = (rows: AllHoldingsRow[]) =>
      sliceBetween(wrap(<AllHoldingsTable holdings={rows} />), 'data-footer-disclosure="stale"', "</p>")
        .replace(/<span[^>]*>[^<]*<\/span>/g, "#");
    expect(strip([allRow("ZZA"), allRow("ZZB", { as_of_date: OLDER })])).toBe(
      strip([allRow("ZZA"), allRow("ZZB", { as_of_date: OLDER }), allRow("ZZC", { as_of_date: OLDER })]),
    );
  });

  it("shows the unit beside Qty, as the per-account table does", () => {
    const markup = text(
      wrap(
        <AllHoldingsTable
          holdings={[
            allRow("ZZOPT", { security_type: "Option", quantity: 4 }),
            allRow("ZZBOND", { security_type: "Bond", quantity: 10000 }),
            allRow("ZZAAA", { quantity: 1 }),
          ]}
        />,
      ),
    );
    expect(markup).toContain("4 contracts");
    expect(markup).toContain("10,000 face value");
    expect(markup).toContain("1 share ");
    const src = readFileSync("app/dashboard/components/AllHoldingsTable.tsx", "utf8");
    expect(src).toMatch(/<QuantityUnit\s+securityType=\{h\.security_type\}\s+quantity=\{h\.quantity\}/);
  });

  it("the truncating Name cell carries the full name as its title", () => {
    const markup = wrap(
      <AllHoldingsTable holdings={[allRow("ZZAAA", { security_name: "ZZ Long Fund Name Admiral Shares" })]} />,
    );
    expect(markup).toContain('title="ZZ Long Fund Name Admiral Shares"');
  });

  it("a footer over zero rows prints no exact zero for Value or Alloc %", () => {
    const footer = sliceBetween(wrap(<AllHoldingsTable holdings={[]} />), "<tfoot", "</tfoot>");
    expect(footer).not.toContain("$0.00");
    expect(footer).not.toContain("0.00%");
    expect(footer).not.toContain("NaN");
    const src = readFileSync("app/dashboard/components/AllHoldingsTable.tsx", "utf8");
    const footerSrc = sliceBetween(src, "<tfoot>", "</tfoot>");
    // The guard is "no priced row shown" (2026-10-08): zero rows is one case
    // of it, a set of unpriced rows is the other. Behaviour for both is in
    // tests/dashboard/holdings-footer-unpriced-value.test.tsx.
    expect(footerSrc).toContain("footer.pricedCount === 0 ? (");
    expect(footerSrc).toContain("footer.pricedCount > 0 && unfilteredTotal > 0 ? (");
  });

  it("keeps the Symbol column in view while the money columns pan (desktop only)", () => {
    const src = readFileSync("app/dashboard/components/AllHoldingsTable.tsx", "utf8");
    expect(src).toContain('className="md:sticky md:left-0 md:z-10 md:bg-panel"');
    expect(src).toMatch(/<td className="[^"]*md:sticky md:left-0 md:z-10 md:bg-canvas">\s*<SymbolLink/);
  });
});

describe("holdingsSortValue (Gain sort)", () => {
  const loss = allRow("ZZLOSS", { cost_basis: 1000, current_value: 900, unrealized_gain: -100 });
  const flat = allRow("ZZFLAT", { cost_basis: 1000, current_value: 1000, unrealized_gain: 0 });
  const gain = allRow("ZZGAIN", { cost_basis: 1000, current_value: 1100, unrealized_gain: 100 });
  const noBasisNull = allRow("ZZNUL", { cost_basis: null, unrealized_gain: null });
  const noBasisZero = allRow("ZZZER", { cost_basis: 0, unrealized_gain: null });

  const order = (rows: AllHoldingsRow[], field: string, dir: "asc" | "desc") =>
    [...rows]
      .sort((a, b) => compareValues(holdingsSortValue(a, field), holdingsSortValue(b, field), dir))
      .map((r) => r.symbol);

  it("a real zero gain sorts between the losses and the gains, in both directions", () => {
    const rows = [flat, noBasisNull, gain, loss];
    expect(order(rows, "unrealized_gain", "desc")).toEqual(["ZZGAIN", "ZZFLAT", "ZZLOSS", "ZZNUL"]);
    expect(order(rows, "unrealized_gain", "asc")).toEqual(["ZZLOSS", "ZZFLAT", "ZZGAIN", "ZZNUL"]);
    expect(holdingsSortValue(flat, "unrealized_gain")).toBe(0);
  });

  it("an unknown basis sorts last however it is stored (null or zero)", () => {
    const rows = [noBasisZero, gain, noBasisNull, loss];
    for (const dir of ["asc", "desc"] as const) {
      expect(order(rows, "cost_basis", dir).slice(2).sort()).toEqual(["ZZNUL", "ZZZER"]);
      expect(order(rows, "unrealized_gain", dir).slice(2).sort()).toEqual(["ZZNUL", "ZZZER"]);
    }
    expect(holdingsSortValue(noBasisZero, "cost_basis")).toBeNull();
  });

  it("leaves every other column's value alone, zero included", () => {
    expect(holdingsSortValue(allRow("ZZQ", { current_value: 0 }), "current_value")).toBe(0);
    expect(holdingsSortValue(noBasisNull, "symbol")).toBe("ZZNUL");
  });
});

describe("summarizeStaleRows", () => {
  it("counts the rows older than the newest date and names the oldest", () => {
    const s = summarizeStaleRows([
      { as_of_date: NEWEST },
      { as_of_date: OLDER },
      { as_of_date: "2026-01-31" },
      { as_of_date: NEWEST },
    ]);
    expect(s).toEqual({ newestDate: NEWEST, staleCount: 2, oldestStaleDate: "2026-01-31" });
  });

  it("reads 'newest' from the whole set, not the filtered rows", () => {
    const all = [{ as_of_date: NEWEST }, { as_of_date: OLDER }];
    // A filter that leaves only the old row still marks it.
    expect(summarizeStaleRows([all[1]], all)).toEqual({
      newestDate: NEWEST,
      staleCount: 1,
      oldestStaleDate: OLDER,
    });
  });

  it("is quiet for one date and for no rows", () => {
    expect(summarizeStaleRows([{ as_of_date: NEWEST }, { as_of_date: NEWEST }]).staleCount).toBe(0);
    expect(summarizeStaleRows([])).toEqual({ newestDate: null, staleCount: 0, oldestStaleDate: null });
  });
});
