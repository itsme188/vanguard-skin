import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getCashEstimates } from "@/lib/queries/chat-tools";

// ─── Seed helpers (mirrors tests/queries/chat-tools-fx.test.ts) ───────────

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts?: {
    name?: string;
    security_type?: string;
    fund_category?: string;
    asset_class?: string;
    currency?: string;
    multiplier?: number;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, fund_category, asset_class, currency, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      opts?.name ?? `${symbol} Corp`,
      opts?.security_type ?? "stock",
      opts?.fund_category ?? null,
      opts?.asset_class ?? "equity",
      opts?.currency ?? "USD",
      opts?.multiplier ?? 1
    );
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  costBasis?: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, costBasis ?? null, asOfDate, `hold-${accountId}-${securityId}-${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
}

function seedSnapshot(db: Database.Database, accountId: number, monthEnd: string, totalValue: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value)
     VALUES (?, ?, ?)`
  ).run(accountId, monthEnd, totalValue);
}

const TODAY = "2025-01-31";

describe("getCashEstimates — cash-equivalent exclusion", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("excludes a fund_category='Cash Equivalent' sweep fund from holdings_total (production shape)", () => {
    // Production shape: live VMFXX-style sweep rows carry security_type
    // 'Mutual Fund' with fund_category 'Cash Equivalent' — signal 1
    // (security_type = 'money_market') matches nothing here; only signal 2
    // (fund_category) does the work. See lib/compute/cash-equivalents.ts.
    const equity = seedSecurity(db, "AAPL", { security_type: "Stock", currency: "USD" });
    seedHolding(db, 1, equity, 100, TODAY);
    seedPrice(db, equity, TODAY, 250); // $25,000

    const sweep = seedSecurity(db, "VMFXX", {
      security_type: "Mutual Fund",
      fund_category: "Cash Equivalent",
      currency: "USD",
    });
    seedHolding(db, 1, sweep, 5000, TODAY);
    seedPrice(db, sweep, TODAY, 1); // $5,000

    seedSnapshot(db, 1, TODAY, 40_000);

    const estimates = getCashEstimates(db);
    const row = estimates.find((e) => e.account_name === "Vanguard Taxable");

    expect(row).toBeDefined();
    // holdings_total must be the equity position ONLY — the sweep fund is
    // cash, not a holding.
    expect(row!.holdings_total).toBeCloseTo(25_000, 2);
    // estimated_cash = snapshot_total - holdings_total, so the sweep's
    // $5,000 stays folded into cash (40,000 - 25,000 = 15,000), not
    // subtracted out on top of the equity position.
    expect(row!.estimated_cash).toBeCloseTo(15_000, 2);
  });

  it("also excludes via the security_type='money_market' signal", () => {
    const equity = seedSecurity(db, "MSFT", { security_type: "Stock", currency: "USD" });
    seedHolding(db, 2, equity, 50, TODAY);
    seedPrice(db, equity, TODAY, 400); // $20,000

    const sweep = seedSecurity(db, "VFFXX", {
      security_type: "money_market",
      currency: "USD",
    });
    seedHolding(db, 2, sweep, 3000, TODAY);
    seedPrice(db, sweep, TODAY, 1); // $3,000

    seedSnapshot(db, 2, TODAY, 30_000);

    const estimates = getCashEstimates(db);
    const row = estimates.find((e) => e.account_name === "Vanguard Roth IRA");

    expect(row).toBeDefined();
    expect(row!.holdings_total).toBeCloseTo(20_000, 2);
    expect(row!.estimated_cash).toBeCloseTo(10_000, 2);
  });

  // ─── holdings-latest-sweep: per-(account, security) LEFT JOIN (Codex F3) ──
  //
  // The next two tests use a cash-equivalent sweep fund / a tombstoned
  // non-cash security. Neither one actually discriminates the :787 JOIN
  // correlation (per-account MAX vs per-(account, security) MAX) for
  // holdings_total: a cash-equivalent's contribution is zeroed by
  // excludeCashEquivSql regardless of whether the JOIN makes its row
  // visible, and a quantity=0 tombstone contributes zero via the
  // `h.quantity > 0` CASE guard regardless of whether the JOIN makes IT
  // visible either (either the row is absent from the join, contributing
  // 0, or it's present with qty=0, also contributing 0 — same result
  // either way). Confirmed empirically: both tests below still pass
  // unmodified against the OLD per-account correlation (git show
  // 5636ece~1:lib/queries/chat-tools.ts). They remain valuable as
  // regression guards for the exclusion/quantity filters themselves — see
  // the discriminating fixture further below for a test that actually
  // fails against the old correlation.

  it("does not double-count a sweep fund once per-(account, security) keying includes its own latest row (disappearance case)", () => {
    // VMFXX's only row is January; AAPL restates in February — a
    // genuinely later, distinct date (NOT TODAY/"2025-01-31" reused, or
    // the JOIN would never actually widen and the assertion would be
    // trivial). Under the old per-account MAX(as_of_date) correlation, the
    // LEFT JOIN's single as_of_date per account would have been February,
    // so VMFXX's January row was never joined in at all (it simply
    // "disappeared" from the query). Under per-(account, security)
    // keying, VMFXX's own latest row (January) IS joined in alongside
    // AAPL's — the excludeCashEquivSql filter in the CASE expressions
    // must still keep it out of holdings_total so its value isn't
    // double-counted (once as "cash" via the snapshot residual, and again
    // as a holding). Per the file-level comment above: this test
    // exercises the exclusion filter, not the JOIN widening itself
    // (excludeCashEquivSql zeroes VMFXX's contribution either way).
    const sweep = seedSecurity(db, "VMFXX", {
      security_type: "Mutual Fund",
      fund_category: "Cash Equivalent",
      currency: "USD",
    });
    seedHolding(db, 1, sweep, 5000, "2025-01-31");
    seedPrice(db, sweep, "2025-01-31", 1); // $5,000, never restated

    const aapl = seedSecurity(db, "AAPL", { security_type: "Stock", currency: "USD" });
    seedHolding(db, 1, aapl, 100, "2025-02-28", 15000);
    seedPrice(db, aapl, "2025-02-28", 250); // $25,000

    seedSnapshot(db, 1, "2025-02-28", 40_000);

    const estimates = getCashEstimates(db);
    const row = estimates.find((e) => e.account_name === "Vanguard Taxable");

    expect(row).toBeDefined();
    // holdings_total must be AAPL only — the sweep's January row, though
    // now visible to the join, is filtered by excludeCashEquivSql.
    expect(row!.holdings_total).toBeCloseTo(25_000, 2);
    // estimated_cash = 40,000 - 25,000 = 15,000 (the sweep's $5,000 stays
    // folded into cash via the residual, never subtracted a second time).
    expect(row!.estimated_cash).toBeCloseTo(15_000, 2);
  });

  it("keeps a genuinely tombstoned (quantity=0) non-cash security out of holdings_total (sale, not disappearance)", () => {
    // MSFT is sold: its January row (qty 30) is superseded by a real
    // quantity=0 tombstone at a genuinely LATER date, "2025-02-28" — not
    // TODAY/"2025-01-31" reused, which would collide with the January row
    // under holdings' UNIQUE(account_id, security_id, as_of_date) and get
    // silently replaced via INSERT OR REPLACE, leaving nothing to
    // resurrect and making the assertion trivially true. Per-(account,
    // security) keying must land on the tombstone (the true latest row
    // for that pair) and must NOT resurrect the older non-zero row into
    // holdings_total. Per the file-level comment above: this test
    // exercises the quantity>0 CASE guard, not the JOIN widening itself
    // (a qty=0 row contributes zero whether or not the JOIN makes it
    // visible).
    const msft = seedSecurity(db, "MSFT", { security_type: "Stock", currency: "USD" });
    seedHolding(db, 1, msft, 30, "2025-01-31", 9000);
    seedPrice(db, msft, "2025-01-31", 400); // $12,000 if wrongly resurrected
    seedHolding(db, 1, msft, 0, "2025-02-28", 0); // tombstone, later date

    const aapl = seedSecurity(db, "AAPL", { security_type: "Stock", currency: "USD" });
    seedHolding(db, 1, aapl, 50, "2025-02-28", 7500);
    seedPrice(db, aapl, "2025-02-28", 250); // $12,500

    seedSnapshot(db, 1, "2025-02-28", 20_000);

    const estimates = getCashEstimates(db);
    const row = estimates.find((e) => e.account_name === "Vanguard Taxable");

    expect(row).toBeDefined();
    expect(row!.holdings_total).toBeCloseTo(12_500, 2);
    expect(row!.estimated_cash).toBeCloseTo(7_500, 2);
  });

  it("keeps a non-cash statement-lag position's value in holdings_total once per-(account, security) keying widens the JOIN — discriminating fixture", () => {
    // BND2's only row is January and it is NOT a cash equivalent, so
    // unlike the two tests above, this one DOES discriminate the :787
    // JOIN correlation: under the old per-account MAX(as_of_date)
    // correlation, BND2's January row is entirely absent from the join
    // (the account's single as_of_date is February, from AAPL's
    // restatement), so BND2's $15,000 silently falls out of
    // holdings_total and inflates estimated_cash by the same amount.
    // Under per-(account, security) keying, BND2's own latest row
    // (January) is joined in on its own terms and correctly counted as a
    // holding.
    //
    // Hand-traced empirically against both correlations (old query from
    // git show 5636ece~1:lib/queries/chat-tools.ts, run against this exact
    // seed): old correlation yields holdings_total=25000 /
    // estimated_cash=25000 (BND2 dropped); new correlation yields
    // holdings_total=40000 / estimated_cash=10000 (BND2 counted). The
    // assertions below match the NEW values and fail against the old
    // ones.
    const bnd = seedSecurity(db, "BND2", { security_type: "Stock", currency: "USD" });
    seedHolding(db, 1, bnd, 50, "2025-01-31", 12000);
    seedPrice(db, bnd, "2025-01-31", 300); // $15,000, never restated

    const aapl = seedSecurity(db, "AAPL", { security_type: "Stock", currency: "USD" });
    seedHolding(db, 1, aapl, 100, "2025-02-28", 15000);
    seedPrice(db, aapl, "2025-02-28", 250); // $25,000

    seedSnapshot(db, 1, "2025-02-28", 50_000);

    const estimates = getCashEstimates(db);
    const row = estimates.find((e) => e.account_name === "Vanguard Taxable");

    expect(row).toBeDefined();
    // BND2 ($15,000) + AAPL ($25,000) = $40,000. The old correlation would
    // give $25,000 here (BND2 dropped).
    expect(row!.holdings_total).toBeCloseTo(40_000, 2);
    // 50,000 - 40,000 = 10,000. The old correlation would give $25,000
    // here (BND2's value wrongly folded into "cash").
    expect(row!.estimated_cash).toBeCloseTo(10_000, 2);
  });
});
