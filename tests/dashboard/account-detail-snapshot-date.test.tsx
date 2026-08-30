import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountDetail } from "@/app/dashboard/components/AccountDetail";
import { PrivacyProvider } from "@/lib/privacy/context";
import type { Account } from "@/lib/types";
import type { HoldingWithSecurity } from "@/lib/queries/holdings";

// getHoldingsByAccount's default read keys "latest" per (account, security)
// — not a single account-wide date — and orders the rows by SYMBOL, not by
// date. AccountDetail used to read `holdings[0]?.as_of_date` for the
// snapshot-age chip, which assumed every row shared one latest date. A
// statement-only bond (older as_of_date, alphabetically first symbol) sitting
// beside daily-synced rows (newer as_of_date) made the chip paint a false
// "stale" warning off the bond's date instead of the account's true latest
// sync. Fixed by taking the max as_of_date across all rows.
//
// next/navigation's useRouter/useSearchParams are mocked because
// TransactionHistory's useSortParam hook calls both, and they throw outside
// a real App Router tree. Same renderToStaticMarkup approach as
// tests/dashboard/nearby-levels-privacy.test.tsx (no @testing-library/react,
// no jsdom in this repo).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function vanguardAccount(): Account {
  return { id: 1, name: "Vanguard Taxable" };
}

function sampleHolding(overrides: Partial<HoldingWithSecurity>): HoldingWithSecurity {
  return {
    id: 1,
    account_id: 1,
    security_id: 1,
    quantity: 10,
    cost_basis: 1000,
    as_of_date: "2026-08-01",
    import_batch_id: null,
    source_key: null,
    symbol: "AAA",
    security_name: "Sample Co",
    security_type: "Stock",
    account_name: "Vanguard Taxable",
    underlying_symbol: null,
    strike_price: null,
    expiration_date: null,
    option_type: null,
    multiplier: 1,
    ...overrides,
  };
}

function renderAccountDetail(holdings: HoldingWithSecurity[]) {
  return renderToStaticMarkup(
    <PrivacyProvider>
      <AccountDetail
        selectedAccount={vanguardAccount()}
        holdings={holdings}
        transactions={[]}
        snapshots={[]}
      />
    </PrivacyProvider>
  );
}

describe("AccountDetail snapshot-age date (mixed-date holdings rows)", () => {
  it("uses the newest as_of_date across all rows, not holdings[0] (rows ordered by symbol, not date)", () => {
    // Ordered by symbol (as the real query does): "AAA" (older, statement
    // bond) sorts first even though "ZZZ" (newer, live-synced) is the
    // account's true latest snapshot.
    const holdings = [
      sampleHolding({ id: 1, symbol: "AAA", as_of_date: "2026-07-31" }),
      sampleHolding({ id: 2, symbol: "ZZZ", as_of_date: "2026-08-28" }),
    ];
    const html = renderAccountDetail(holdings);
    expect(html).toContain("Snapshot");
    expect(html).toContain("Aug 28"); // SnapshotAge's short-date rendering of the newest date
    expect(html).not.toContain("Snapshot · Jul 31");
  });

  it("still works when the newest date happens to sort first alphabetically too", () => {
    const holdings = [
      sampleHolding({ id: 1, symbol: "AAA", as_of_date: "2026-08-28" }),
      sampleHolding({ id: 2, symbol: "ZZZ", as_of_date: "2026-07-31" }),
    ];
    const html = renderAccountDetail(holdings);
    expect(html).toContain("Aug 28");
  });

  it("renders nothing for the chip when there are no holdings (no snapshot date to show)", () => {
    const html = renderAccountDetail([]);
    expect(html).not.toContain("Snapshot ·");
  });
});
