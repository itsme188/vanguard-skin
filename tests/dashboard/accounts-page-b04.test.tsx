import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountSelector, nextTabIndex } from "@/app/dashboard/components/AccountSelector";
import { AccountDetail } from "@/app/dashboard/components/AccountDetail";
import {
  buildSnapshotTitle,
  snapshotSourceFromKey,
  summarizeSnapshot,
  SnapshotAge,
} from "@/app/dashboard/components/SnapshotAge";
import { PrivacyProvider } from "@/lib/privacy/context";
import type { AccountHoldingRow } from "@/lib/queries/holdings";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

/**
 * Accounts page polish (QA unit B04) and the snapshot chip (A01, ruling
 * 2026-09-14). Fixtures are synthetic.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/accounts",
}));

describe("snapshotSourceFromKey", () => {
  it("classifies by the shared source_key prefix lists", () => {
    expect(snapshotSourceFromKey("vanguard-pdf:holding:zz")).toBe("statement");
    expect(snapshotSourceFromKey("canonical:hold:zz")).toBe("statement");
    expect(snapshotSourceFromKey("ibkr:pos:zz")).toBe("statement");
    expect(snapshotSourceFromKey("plaid:zz")).toBe("plaid");
    expect(snapshotSourceFromKey("tws-zz")).toBe("tws");
  });

  it("never guesses: a missing or unrecognized key is unknown", () => {
    expect(snapshotSourceFromKey(null)).toBe("unknown");
    expect(snapshotSourceFromKey(undefined)).toBe("unknown");
    expect(snapshotSourceFromKey("demo-hold-1")).toBe("unknown");
    expect(snapshotSourceFromKey("recon:closed-equity:zz")).toBe("unknown");
  });
});

describe("summarizeSnapshot", () => {
  const rows = [
    { as_of_date: "2026-03-10", source_key: "plaid:a", security_type: "Stock", fund_category: null },
    { as_of_date: "2026-03-10", source_key: "plaid:b", security_type: "ETF", fund_category: null },
    { as_of_date: "2026-02-28", source_key: "vanguard-pdf:holding:c", security_type: "Bond", fund_category: null },
    {
      as_of_date: "2026-02-28",
      source_key: "vanguard-pdf:holding:d",
      security_type: "Mutual Fund",
      fund_category: "Cash Equivalent",
    },
  ];

  it("reports the range, each sleeve's dates and the newest rows' source", () => {
    expect(summarizeSnapshot(rows)).toEqual({
      newest: "2026-03-10",
      oldest: "2026-02-28",
      source: "plaid",
      sleeves: [
        { label: "Cash funds", oldest: "2026-02-28", newest: "2026-02-28" },
        { label: "Bonds", oldest: "2026-02-28", newest: "2026-02-28" },
        { label: "Other positions", oldest: "2026-03-10", newest: "2026-03-10" },
      ],
    });
  });

  it("asserts no source when the newest rows disagree, and returns null for no rows", () => {
    const mixed = [rows[0], { ...rows[1], source_key: "tws-b" }];
    expect(summarizeSnapshot(mixed)!.source).toBe("unknown");
    expect(summarizeSnapshot([])).toBeNull();
  });
});

describe("buildSnapshotTitle", () => {
  it("phrases the sentence per source", () => {
    const at = (source: "statement" | "plaid" | "tws" | "unknown") =>
      buildSnapshotTitle({ asOfDate: "2026-03-10", source });
    expect(at("statement")).toBe(
      "Holdings as of 2026-03-10. These figures come from the last imported statement.",
    );
    expect(at("plaid")).toBe(
      "Holdings as of 2026-03-10. These figures come from the daily Plaid sync; a statement import replaces them at month-end.",
    );
    expect(at("tws")).toBe("Holdings as of 2026-03-10. These figures come from the last broker sync.");
    expect(at("unknown")).toBe("Holdings as of 2026-03-10.");
  });

  it("lists each sleeve's own date when the rows are mixed", () => {
    expect(
      buildSnapshotTitle({
        asOfDate: "2026-03-10",
        oldestAsOfDate: "2026-02-28",
        source: "plaid",
        sleeves: [
          { label: "Cash funds", oldest: "2026-02-28", newest: "2026-02-28" },
          { label: "Other positions", oldest: "2026-02-28", newest: "2026-03-10" },
        ],
      }),
    ).toBe(
      "Holdings as of 2026-02-28 to 2026-03-10. Cash funds: 2026-02-28. Other positions: 2026-02-28 to 2026-03-10. " +
        "The newest rows come from the daily Plaid sync; a statement import replaces them at month-end.",
    );
  });

  it("the hardcoded Vanguard statement sentence is gone", () => {
    const src = readFileSync("app/dashboard/components/SnapshotAge.tsx", "utf8");
    expect(src).not.toContain("Vanguard accounts update only on statement import");
    expect(src).not.toMatch(/startsWith\("(plaid|tws)/);
  });
});

describe("SnapshotAge chip", () => {
  it("shows one date when the rows agree and a range when they are mixed", () => {
    const single = renderToStaticMarkup(<SnapshotAge asOfDate="2026-03-10" alwaysShow />);
    expect(single).toContain("Snapshot · Mar 10 · ");
    expect(single).not.toContain("–");
    const same = renderToStaticMarkup(
      <SnapshotAge asOfDate="2026-03-10" oldestAsOfDate="2026-03-10" alwaysShow />,
    );
    expect(same).not.toContain("–");
    const mixed = renderToStaticMarkup(
      <SnapshotAge asOfDate="2026-03-10" oldestAsOfDate="2026-02-28" alwaysShow />,
    );
    expect(mixed).toContain("Snapshot · Feb 28 – Mar 10 · newest ");
  });
});

function row(over: Partial<AccountHoldingRow>): AccountHoldingRow {
  return {
    id: 1,
    account_id: 3,
    security_id: 1,
    quantity: 10,
    cost_basis: 1000,
    as_of_date: "2026-03-10",
    import_batch_id: null,
    source_key: "tws-zz",
    symbol: "ZZAAA",
    security_name: "ZZAAA Corp",
    security_type: "Stock",
    account_name: "IBKR",
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

describe("AccountDetail snapshot chip", () => {
  const render = (name: string, holdings: AccountHoldingRow[]) =>
    renderToStaticMarkup(
      <PrivacyProvider>
        <AccountDetail
          selectedAccount={{ id: 3, name }}
          holdings={holdings}
          transactions={[]}
          snapshots={[]}
        />
      </PrivacyProvider>,
    );

  it("renders for a non-Vanguard account too, with that account's source", () => {
    const html = render("IBKR", [row({})]);
    expect(html).toContain("Snapshot · Mar 10");
    expect(html).toContain("These figures come from the last broker sync.");
  });

  it("shows the range and the per-sleeve dates when cash and bond rows are older", () => {
    const html = render("Vanguard Taxable", [
      row({ id: 1, source_key: "plaid:a" }),
      row({
        id: 2,
        security_id: 2,
        symbol: "ZZCASH",
        security_type: "Mutual Fund",
        fund_category: "Cash Equivalent",
        as_of_date: "2026-02-28",
        source_key: "vanguard-pdf:holding:b",
      }),
      row({
        id: 3,
        security_id: 3,
        symbol: "ZZBOND",
        security_type: "Bond",
        as_of_date: "2026-02-28",
        source_key: "vanguard-pdf:holding:c",
      }),
    ]);
    expect(html).toContain("Snapshot · Feb 28 – Mar 10");
    expect(html).toContain(
      "Holdings as of 2026-02-28 to 2026-03-10. Cash funds: 2026-02-28. Bonds: 2026-02-28. Other positions: 2026-03-10. The newest rows come from the daily Plaid sync",
    );
  });

  it("no longer gates the chip on the account name", () => {
    const src = readFileSync("app/dashboard/components/AccountDetail.tsx", "utf8");
    expect(src).not.toContain("isVanguard");
    expect(src).not.toContain('includes("vanguard")');
  });
});

describe("nextTabIndex (ARIA tabs keys)", () => {
  it("steps and wraps with the arrow keys", () => {
    expect(nextTabIndex("ArrowRight", 0, 4)).toBe(1);
    expect(nextTabIndex("ArrowRight", 3, 4)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 4)).toBe(3);
    expect(nextTabIndex("ArrowLeft", 2, 4)).toBe(1);
  });

  it("jumps to the ends with Home and End, and ignores other keys", () => {
    expect(nextTabIndex("Home", 2, 4)).toBe(0);
    expect(nextTabIndex("End", 0, 4)).toBe(3);
    expect(nextTabIndex("Enter", 1, 4)).toBeNull();
    expect(nextTabIndex("Tab", 1, 4)).toBeNull();
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("AccountSelector roving tabindex", () => {
  const accounts = [
    { id: 1, name: "ZZ One" },
    { id: 2, name: "ZZ Two" },
  ];
  const tabs = (selected: number | "all") =>
    [
      ...renderToStaticMarkup(<AccountSelector accounts={accounts} selected={selected} />).matchAll(
        /<button[^>]*role="tab"[^>]*>/g,
      ),
    ].map((m) => ({
      selected: m[0].includes('aria-selected="true"'),
      tabIndex: /tabindex="(-?\d)"/.exec(m[0])![1],
    }));

  it("only the selected tab is a Tab stop", () => {
    expect(tabs(2)).toEqual([
      { selected: false, tabIndex: "-1" },
      { selected: false, tabIndex: "-1" },
      { selected: true, tabIndex: "0" },
    ]);
    expect(tabs("all").map((t) => t.tabIndex)).toEqual(["0", "-1", "-1"]);
  });

  it("an id that matches no tab still leaves one Tab stop", () => {
    expect(tabs(99).map((t) => t.tabIndex)).toEqual(["0", "-1", "-1"]);
  });

  it("every tab handles the arrow keys", () => {
    const src = readFileSync("app/dashboard/components/AccountSelector.tsx", "utf8");
    expect(src.match(/onKeyDown=\{\(e\) => onKeyDown\(e, /g)!.length).toBe(2);
    expect(src).toContain("tabRefs.current[next]?.focus()");
  });
});

describe("accounts page at the All Accounts scope", () => {
  const page = () => readFileSync("app/dashboard/accounts/page.tsx", "utf8");
  const allBranch = () => {
    const text = page();
    return text.slice(anchorIndex(text, "if (isAll) {"), anchorIndex(text, "const selectedId"));
  };

  it("masks the position count under Hide amounts", () => {
    expect(allBranch()).toContain("<Count value={holdings.length} /> positions across all accounts");
    expect(page()).not.toMatch(/\{holdings\.length\} positions/);
  });

  it("explains the three per-account sections instead of dropping them", () => {
    const branch = allBranch();
    for (const title of ["Equity Curve", "Recent Transactions", "Reconciliation"]) {
      const section = sliceBetween(branch, `title="${title}"`, "/>");
      expect(section).toContain("one account");
      expect(section).toContain("Pick an account above");
    }
    expect(branch.match(/<EmptySection/g)!.length).toBe(3);
  });
});
