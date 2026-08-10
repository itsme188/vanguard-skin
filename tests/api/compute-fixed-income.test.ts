/**
 * GET /api/compute/fixed-income — FX conversion regression.
 *
 * Pre-fix, bond market value (and everything derived from it — weighted avg
 * duration, credit-quality weights, portfolio total_value) was computed from
 * `close_price` with NO fx join, so a KRW bond's ₩ notional leaked through as
 * if it were USD. This mirrors the seeding pattern from
 * tests/queries/holdings-fx.test.ts / tax-lots-fx.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";

const state = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts: {
    security_type: string;
    currency?: string;
    multiplier?: number;
    duration_years?: number;
    credit_rating?: string;
    coupon_rate?: number;
    maturity_date?: string | null;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO securities
        (symbol, name, security_type, currency, multiplier, duration_years, credit_rating, coupon_rate, maturity_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      `${symbol} Corp`,
      opts.security_type,
      opts.currency ?? "USD",
      opts.multiplier ?? 1,
      opts.duration_years ?? null,
      opts.credit_rating ?? null,
      opts.coupon_rate ?? null,
      opts.maturity_date ?? null
    );
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, asOfDate, `hold-${accountId}-${securityId}-${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
}

describe("GET /api/compute/fixed-income FX conversion", () => {
  const AS_OF = "2026-06-15";
  const FUTURE_MATURITY = "2032-01-01";

  beforeEach(() => {
    state.db = new Database(":memory:");
    state.db.pragma("foreign_keys = ON");
    runMigrations(state.db);
  });

  it("converts KRW bond market value / duration / credit weights to USD; USD control unchanged", async () => {
    const db = state.db;
    const accountId = 1; // migration 002 seeds id=1 as "Vanguard Taxable"

    // USD control bond: 10,000 face @ 98.5 (percent of par) => MV = $9,850.
    const usdBond = seedSecurity(db, "TBUSD", {
      security_type: "bond",
      currency: "USD",
      duration_years: 5,
      credit_rating: "AAA",
      coupon_rate: 3.0,
      maturity_date: FUTURE_MATURITY,
    });
    seedHolding(db, accountId, usdBond, 10_000, AS_OF);
    seedPrice(db, usdBond, AS_OF, 98.5);

    // KRW bond: 1,000,000 face (won) @ par 100 => native notional ₩1,000,000.
    // Pre-fix this leaks through as if it were $1,000,000 (the phantom).
    const krwBond = seedSecurity(db, "KBOND", {
      security_type: "bond",
      currency: "KRW",
      duration_years: 3,
      credit_rating: "BBB",
      coupon_rate: 2.0,
      maturity_date: FUTURE_MATURITY,
    });
    seedHolding(db, accountId, krwBond, 1_000_000, AS_OF);
    seedPrice(db, krwBond, AS_OF, 100);

    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.000734, asOf: AS_OF, source: "test" });

    // Non-bond fillers to exercise the portfolio total_value ELSE branch too.
    const usdStock = seedSecurity(db, "USTOCK", { security_type: "stock", currency: "USD" });
    seedHolding(db, accountId, usdStock, 50, AS_OF);
    seedPrice(db, usdStock, AS_OF, 200); // $10,000

    const krwStock = seedSecurity(db, "KSTOCK", { security_type: "stock", currency: "KRW" });
    seedHolding(db, accountId, krwStock, 100, AS_OF);
    seedPrice(db, krwStock, AS_OF, 1000); // native ₩100,000 -> $73.40

    const { GET } = await import("@/app/api/compute/fixed-income/route");
    const req = new Request("http://x/api/compute/fixed-income?scope=all");
    const res = await GET(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const bonds: Array<{ symbol: string; marketValue: number; durationYears: number | null; creditRating: string | null }> =
      body.data.bonds;
    const usdRow = bonds.find((b) => b.symbol === "TBUSD");
    const krwRow = bonds.find((b) => b.symbol === "KBOND");
    expect(usdRow).toBeTruthy();
    expect(krwRow).toBeTruthy();

    // USD control byte-unchanged.
    expect(usdRow!.marketValue).toBeCloseTo(9_850, 5);

    // KRW bond valued in USD (₩1,000,000 * 0.000734 = $734), NOT the won
    // notional ($1,000,000 if FX were never applied).
    expect(krwRow!.marketValue).toBeCloseTo(734, 5);
    expect(krwRow!.marketValue).toBeLessThan(1_000);

    // Weighted avg duration must be USD-value-weighted: (5*9850 + 3*734) / 10584.
    const expectedDuration = (5 * 9_850 + 3 * 734) / (9_850 + 734);
    expect(body.data.weightedAvgDuration).toBeCloseTo(expectedDuration, 4);
    // Sanity: the phantom (unconverted) weighting would pull duration toward 3
    // because the ₩1M/₩100 par bond would dominate at $1M "value" — assert
    // we are NOT near that wrong answer.
    expect(body.data.weightedAvgDuration).toBeGreaterThan(4.5);

    // Credit quality weights must reflect USD-weighted values: AAA ~93%, BBB ~7%.
    const aaa = body.data.creditBreakdown.find((c: { rating: string }) => c.rating === "AAA");
    const bbb = body.data.creditBreakdown.find((c: { rating: string }) => c.rating === "BBB");
    expect(aaa.weight).toBeCloseTo(9_850 / (9_850 + 734), 4);
    expect(bbb.weight).toBeCloseTo(734 / (9_850 + 734), 4);
    // Phantom would have given BBB ~99% weight — assert we're nowhere near that.
    expect(bbb.weight).toBeLessThan(0.2);

    // Portfolio total value includes FX-converted non-bond holdings too.
    const expectedPortfolioValue = 9_850 + 734 + 10_000 + 73.4;
    expect(body.data.portfolioValue).toBeCloseTo(expectedPortfolioValue, 4);
    expect(body.data.totalBondValue).toBeCloseTo(9_850 + 734, 5);
  });

  it("keeps statement-maintained bonds when the same account carries newer daily equity rows", async () => {
    const db = state.db;
    const accountId = 1;

    // Treasuries stay statement-maintained (Plaid omits them), so the bond's
    // newest holdings row lags the account's newest equity row. A per-ACCOUNT
    // MAX(as_of_date) predicate drops every bond; the per-(account, security)
    // latest-holdings convention keeps it.
    const bond = seedSecurity(db, "TBLAG", {
      security_type: "bond",
      currency: "USD",
      duration_years: 7,
      credit_rating: "AAA",
      coupon_rate: 4.0,
      maturity_date: FUTURE_MATURITY,
    });
    seedHolding(db, accountId, bond, 15_000, "2026-06-30");
    seedPrice(db, bond, "2026-06-30", 98.0);

    const stock = seedSecurity(db, "EQDAILY", { security_type: "stock", currency: "USD" });
    seedHolding(db, accountId, stock, 10, "2026-07-27");
    seedPrice(db, stock, "2026-07-27", 100);

    // A bond whose LATEST row is an explicit quantity-0 close stays excluded.
    const closedBond = seedSecurity(db, "TBCLOSED", {
      security_type: "bond",
      currency: "USD",
      duration_years: 2,
      maturity_date: FUTURE_MATURITY,
    });
    seedHolding(db, accountId, closedBond, 5_000, "2026-05-31");
    seedHolding(db, accountId, closedBond, 0, "2026-06-30");
    seedPrice(db, closedBond, "2026-06-30", 99.0);

    const { GET } = await import("@/app/api/compute/fixed-income/route");
    const res = await GET(new Request("http://x/api/compute/fixed-income?scope=all") as never);
    const body = await res.json();
    expect(body.success).toBe(true);

    const symbols = body.data.bonds.map((b: { symbol: string }) => b.symbol);
    expect(symbols).toContain("TBLAG");
    expect(symbols).not.toContain("TBCLOSED");

    const lag = body.data.bonds.find((b: { symbol: string }) => b.symbol === "TBLAG");
    // 15,000 face @ 98.0 percent of par => $14,700.
    expect(lag.marketValue).toBeCloseTo(14_700, 5);
    // The portfolio denominator keeps the newer equity row too ($1,000).
    expect(body.data.portfolioValue).toBeCloseTo(14_700 + 1_000, 4);
  });
});

describe("GET /api/compute/fixed-income weighted duration with unknown-duration bonds", () => {
  const AS_OF = "2026-06-15";
  const FUTURE_MATURITY = "2032-01-01";

  beforeEach(() => {
    state.db = new Database(":memory:");
    state.db.pragma("foreign_keys = ON");
    runMigrations(state.db);
  });

  it("excludes null-duration bonds from the weighted-average denominator and discloses the unmeasured sleeve", async () => {
    const db = state.db;
    const accountId = 1;

    // Measured bond: $10,000 face @ par => MV $10,000, duration 9.
    const measured = seedSecurity(db, "TBMEAS", {
      security_type: "bond",
      currency: "USD",
      duration_years: 9,
      credit_rating: "AAA",
      maturity_date: FUTURE_MATURITY,
    });
    seedHolding(db, accountId, measured, 10_000, AS_OF);
    seedPrice(db, measured, AS_OF, 100);

    // Unknown-duration bond: $30,000 face @ par => MV $30,000, duration NULL.
    // Pre-fix its value sat in the denominator as if duration were ZERO,
    // dragging the average from 9.0 to 2.25.
    const unmeasured = seedSecurity(db, "TBNULL", {
      security_type: "bond",
      currency: "USD",
      maturity_date: FUTURE_MATURITY,
    });
    seedHolding(db, accountId, unmeasured, 30_000, AS_OF);
    seedPrice(db, unmeasured, AS_OF, 100);

    const { GET } = await import("@/app/api/compute/fixed-income/route");
    const res = await GET(new Request("http://x/api/compute/fixed-income?scope=all") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // The average is over MEASURED bonds only: 9.0, never 90000/40000 = 2.25.
    expect(body.data.weightedAvgDuration).toBeCloseTo(9.0, 6);

    // Disclosure fields so the card can caption the excluded share.
    expect(body.data.measuredBondValue).toBeCloseTo(10_000, 5);
    expect(body.data.unmeasuredBondValue).toBeCloseTo(30_000, 5);
    expect(body.data.unmeasuredBondCount).toBe(1);
    expect(body.data.totalBondValue).toBeCloseTo(40_000, 5);
  });

  it("reports zero unmeasured value when every bond has a duration", async () => {
    const db = state.db;
    const a = seedSecurity(db, "TBA", {
      security_type: "bond",
      currency: "USD",
      duration_years: 4,
      maturity_date: FUTURE_MATURITY,
    });
    seedHolding(db, 1, a, 10_000, AS_OF);
    seedPrice(db, a, AS_OF, 100);

    const { GET } = await import("@/app/api/compute/fixed-income/route");
    const body = await (await GET(new Request("http://x/api/compute/fixed-income") as never)).json();
    expect(body.data.weightedAvgDuration).toBeCloseTo(4.0, 6);
    expect(body.data.measuredBondValue).toBeCloseTo(10_000, 5);
    expect(body.data.unmeasuredBondValue).toBeCloseTo(0, 5);
    expect(body.data.unmeasuredBondCount).toBe(0);
  });
});
