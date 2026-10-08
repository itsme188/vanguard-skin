import { describe, expect, it, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllocationByDimension } from "@/lib/queries/analysis";
import { getHoldingsInBucket } from "@/lib/queries/drill-down";

let db: Database.Database;

function seedAccount(): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES ('Identity')").run();
  return (db.prepare("SELECT id FROM accounts WHERE name = 'Identity'").get() as { id: number }).id;
}

function seedSecurity(
  symbol: string,
  opts: {
    security_type?: string;
    sector?: string | null;
    fund_category?: string | null;
    underlying_symbol?: string | null;
    multiplier?: number;
  } = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities
        (symbol, name, security_type, sector, fund_category, underlying_symbol, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      `${symbol} Inc`,
      opts.security_type ?? "Stock",
      opts.sector ?? null,
      opts.fund_category ?? null,
      opts.underlying_symbol ?? null,
      opts.multiplier ?? 1
    ).lastInsertRowid as number;
}

function seedHolding(accountId: number, securityId: number, quantity: number, price: number) {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, '2026-06-01', ?)`
  ).run(accountId, securityId, quantity, `identity:${securityId}`);
  db.prepare(
    `INSERT INTO prices (security_id, close_price, date, source)
     VALUES (?, ?, '2026-06-01', 'test')`
  ).run(securityId, price);
}

function seedWeights(symbol: string, rows: Array<[string, number]>) {
  const stmt = db.prepare(
    `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source)
     VALUES (?, ?, ?, '2026-06-01', 'test')`
  );
  for (const [sector, pct] of rows) stmt.run(symbol, sector, pct);
}

function seedFactor(securityId: number, factor: string, source = "csv_import") {
  db.prepare(
    `INSERT INTO security_factors (security_id, ai_exposure, factor_source)
     VALUES (?, ?, ?)`
  ).run(securityId, factor, source);
}

function assertIdentity(
  breakdown: { total_market_value: number; position_count: number },
  rows: Array<{ marketValue: number }>
) {
  expect(rows).toHaveLength(breakdown.position_count);
  expect(rows.reduce((sum, r) => sum + r.marketValue, 0)).toBeCloseTo(
    breakdown.total_market_value,
    6
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// ─── Full-book identity (review of 5553916a) ─────────────────────
// Every row of a breakdown must equal the panel it opens: same dollars, same
// count, and the rows must add up to the scope total. The fixture carries
// every shape that broke one of those: a name in two accounts, an unpriced
// holding with a cost basis, a matured bond, a fund with two names for one
// sector, a fund with no weights, a short, an option on a held underlying, a
// money-market fund, a foreign-currency name and an expired option.

function seedNamedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedFullSecurity(
  symbol: string,
  opts: {
    security_type?: string;
    sector?: string | null;
    fund_category?: string | null;
    underlying_symbol?: string | null;
    multiplier?: number;
    currency?: string;
    maturity_date?: string | null;
    expiration_date?: string | null;
  } = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities
        (symbol, name, security_type, sector, fund_category, underlying_symbol, multiplier,
         currency, maturity_date, expiration_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      `${symbol} Inc`,
      opts.security_type ?? "Stock",
      opts.sector ?? null,
      opts.fund_category ?? null,
      opts.underlying_symbol ?? null,
      opts.multiplier ?? 1,
      opts.currency ?? "USD",
      opts.maturity_date ?? null,
      opts.expiration_date ?? null
    ).lastInsertRowid as number;
}

function seedPosition(
  accountId: number,
  securityId: number,
  quantity: number,
  opts: { price?: number; costBasis?: number } = {}
) {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, '2026-06-01', ?)`
  ).run(accountId, securityId, quantity, opts.costBasis ?? null, `identity:${accountId}:${securityId}`);
  if (opts.price != null) {
    db.prepare(
      `INSERT OR REPLACE INTO prices (security_id, close_price, date, source)
       VALUES (?, ?, '2026-06-01', 'test')`
    ).run(securityId, opts.price);
  }
}

/** Scope total of the fixture below, added up by hand in its comments. */
const FULL_BOOK_TOTAL = 10930;

function seedFullBook() {
  const a = seedNamedAccount("Identity A");
  const b = seedNamedAccount("Identity B");
  db.prepare(
    "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('KRW', 0.001, '2026-06-01', 'test')"
  ).run();

  // One name in TWO accounts: 1000 + 500 = 1500, one position.
  const dual = seedFullSecurity("DUALX", { sector: "Technology" });
  seedPosition(a, dual, 10, { price: 100 });
  seedPosition(b, dual, 5, { price: 100 });
  // Unpriced, with a cost basis: 700 by the cost-basis fallback.
  const unpriced = seedFullSecurity("UNPRX", { sector: "Healthcare" });
  seedPosition(a, unpriced, 7, { costBasis: 700 });
  // Stored sector is a raw vendor alias: 300, lands in "Technology".
  const alias = seedFullSecurity("ALIASX", { sector: "Information Technology" });
  seedPosition(a, alias, 3, { price: 100 });
  // Matured bond still in holdings: not a position any more (0).
  const matured = seedFullSecurity("MATBX", { security_type: "Bond", maturity_date: "2020-01-15" });
  seedPosition(a, matured, 1000, { price: 100 });
  // Live bond, no sector: 2000 face at 99 = 1980, "Fixed Income".
  const bond = seedFullSecurity("LIVEBX", { security_type: "Bond", maturity_date: "2099-01-15" });
  seedPosition(a, bond, 2000, { price: 99 });
  // Fund whose weights carry TWO names for one sector: 1000 = 600 Technology + 400 Financials.
  const twoName = seedFullSecurity("TWONMX", { security_type: "ETF", fund_category: "US Equity" });
  seedPosition(a, twoName, 10, { price: 100 });
  seedWeights("TWONMX", [
    ["Information Technology", 30],
    ["Technology", 30],
    ["Financials", 40],
  ]);
  // Fund with no weights: 200 in its own fund_category bucket.
  const noWeights = seedFullSecurity("NOWTX", { security_type: "ETF", fund_category: "US Equity" });
  seedPosition(b, noWeights, 4, { price: 50 });
  // Short: -100.
  const short = seedFullSecurity("SHRTX", { sector: "Financials" });
  seedPosition(a, short, -5, { price: 20 });
  // Held underlying 100, and an option on it 1 x 2 x 100 = 200.
  const underlying = seedFullSecurity("UNDX", { sector: "Technology" });
  seedPosition(a, underlying, 2, { price: 50 });
  const option = seedFullSecurity("UNDX  991217C00100000", {
    security_type: "Option",
    sector: "Technology",
    underlying_symbol: "UNDX",
    multiplier: 100,
    expiration_date: "2099-12-17",
  });
  seedPosition(a, option, 1, { price: 2 });
  // Money-market fund: 50.
  const cash = seedFullSecurity("CASHX", {
    security_type: "Mutual Fund",
    fund_category: "Cash Equivalent",
  });
  seedPosition(b, cash, 50, { price: 1 });
  // Foreign-currency name: 100 x 50,000 KRW x 0.001 = 5000.
  const foreign = seedFullSecurity("FRGNX", { sector: "Industrials", currency: "KRW" });
  seedPosition(b, foreign, 100, { price: 50000 });
  // Expired option: not a position any more (0).
  const expired = seedFullSecurity("UNDX  200117C00100000", {
    security_type: "Option",
    sector: "Technology",
    underlying_symbol: "UNDX",
    multiplier: 100,
    expiration_date: "2020-01-17",
  });
  seedPosition(a, expired, 1, { price: 3 });

  // ai_exposure: three names carry a value, everything else is "Unknown".
  seedFactor(dual, "High");
  seedFactor(underlying, "High", "auto_underlying"); // the option inherits it
  seedFactor(twoName, "Low");

  return { a, b, dual, twoName, matured, expired, unpriced };
}

type Panel = ReturnType<typeof getHoldingsInBucket>;

function assertEveryRow(
  label: string,
  breakdown: ReturnType<typeof getAllocationByDimension>,
  panelFor: (bucket: string) => Panel,
  expectedTotal: number
) {
  expect(breakdown.length, `${label}: breakdown has rows`).toBeGreaterThan(0);
  let dollars = 0;
  let weight = 0;
  for (const row of breakdown) {
    const panel = panelFor(row.group_name);
    expect(panel.length, `${label} / ${row.group_name}: count`).toBe(row.position_count);
    expect(
      panel.reduce((sum, r) => sum + r.marketValue, 0),
      `${label} / ${row.group_name}: dollars`
    ).toBeCloseTo(row.total_market_value, 6);
    expect(new Set(panel.map((r) => r.securityId)).size, `${label} / ${row.group_name}: one row per security`).toBe(
      panel.length
    );
    dollars += row.total_market_value;
    weight += panel.reduce((sum, r) => sum + r.weight, 0);
  }
  expect(dollars, `${label}: rows add up to the scope total`).toBeCloseTo(expectedTotal, 6);
  // The panel weights use the drill-down's OWN scope total, so this holds
  // only when that total equals the breakdown's.
  expect(weight, `${label}: panel weights add up to 1`).toBeCloseTo(1, 9);
}

describe("analysis drill-down identity — every row of a full book", () => {
  it("every sector row equals its panel, and the rows add up to the scope total", () => {
    seedFullBook();
    assertEveryRow(
      "sector",
      getAllocationByDimension(db, "sector"),
      (bucket) => getHoldingsInBucket(db, "all", { kind: "classification", dimension: "sector", bucket }),
      FULL_BOOK_TOTAL
    );
  });

  it("every asset-class row equals its panel, and the rows add up to the scope total", () => {
    seedFullBook();
    assertEveryRow(
      "asset_class",
      getAllocationByDimension(db, "asset_class"),
      (bucket) =>
        getHoldingsInBucket(db, "all", { kind: "classification", dimension: "asset_class", bucket }),
      FULL_BOOK_TOTAL
    );
  });

  it("every factor row, 'Unknown' included, equals its panel, and the rows add up to the scope total", () => {
    seedFullBook();
    const breakdown = getAllocationByDimension(db, "ai_exposure");
    expect(breakdown.map((r) => r.group_name).sort()).toEqual(["High", "Low", "Unknown"]);
    assertEveryRow(
      "ai_exposure",
      breakdown,
      (bucket) => getHoldingsInBucket(db, "all", { kind: "factor", factor: "ai_exposure", bucket }),
      FULL_BOOK_TOTAL
    );
    // A5: the 'Unknown' row opens a panel with holdings in it.
    const unknown = getHoldingsInBucket(db, "all", { kind: "factor", factor: "ai_exposure", bucket: "Unknown" });
    expect(unknown.length).toBeGreaterThan(0);
  });

  it("the identity also holds inside one account's scope", () => {
    const { a } = seedFullBook();
    // Account A: 1000 + 700 + 300 + 1980 + 1000 - 100 + 100 + 200 = 5180.
    assertEveryRow(
      "sector (account A)",
      getAllocationByDimension(db, "sector", [a]),
      (bucket) =>
        getHoldingsInBucket(db, "all", { kind: "classification", dimension: "sector", bucket }, [a]),
      5180
    );
  });

  it("A2: a name held in two accounts is ONE position in the row, as in the panel", () => {
    const { dual } = seedFullBook();
    const stock = getAllocationByDimension(db, "asset_class").find((r) => r.group_name === "Stock")!;
    // DUALX, UNPRX, ALIASX, SHRTX, UNDX, FRGNX — six names, seven holdings rows.
    expect(stock.position_count).toBe(6);
    expect(stock.total_market_value).toBeCloseTo(1500 + 700 + 300 - 100 + 100 + 5000, 6);
    const high = getAllocationByDimension(db, "ai_exposure").find((r) => r.group_name === "High")!;
    // DUALX (two accounts), UNDX and the option that inherits from it.
    expect(high.position_count).toBe(3);
    const panel = getHoldingsInBucket(db, "all", { kind: "factor", factor: "ai_exposure", bucket: "High" });
    expect(panel.find((r) => r.securityId === dual)!.marketValue).toBeCloseTo(1500, 6);
  });

  it("A3: an unpriced holding with a cost basis shows that cost basis in the panel too", () => {
    const { unpriced } = seedFullBook();
    const row = getAllocationByDimension(db, "sector").find((r) => r.group_name === "Healthcare")!;
    expect(row.total_market_value).toBeCloseTo(700, 6);
    const panel = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "sector",
      bucket: "Healthcare",
    });
    expect(panel).toHaveLength(1);
    expect(panel[0].securityId).toBe(unpriced);
    expect(panel[0].marketValue).toBeCloseTo(700, 6);
  });

  it("A4: a matured bond and an expired option are in neither the row nor the panel", () => {
    const { matured, expired } = seedFullBook();
    const fixedIncome = getAllocationByDimension(db, "sector").find((r) => r.group_name === "Fixed Income")!;
    expect(fixedIncome.position_count).toBe(1);
    expect(fixedIncome.total_market_value).toBeCloseTo(1980, 6);
    const bonds = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "asset_class",
      bucket: "Bond",
    });
    expect(bonds.map((r) => r.securityId)).not.toContain(matured);
    expect(bonds).toHaveLength(1);
    const options = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "asset_class",
      bucket: "Option",
    });
    expect(options.map((r) => r.securityId)).not.toContain(expired);
    expect(options).toHaveLength(1);
  });

  it("A6: a fund with two names for one sector is one row of that sector, counted once", () => {
    const { twoName } = seedFullBook();
    const tech = getAllocationByDimension(db, "sector").find((r) => r.group_name === "Technology")!;
    // DUALX, ALIASX, TWONMX, UNDX and its option.
    expect(tech.position_count).toBe(5);
    expect(tech.total_market_value).toBeCloseTo(1500 + 300 + 600 + 100 + 200, 6);
    const panel = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "sector",
      bucket: "Technology",
    });
    const fundRows = panel.filter((r) => r.securityId === twoName);
    expect(fundRows).toHaveLength(1);
    expect(fundRows[0].marketValue).toBeCloseTo(600, 6);
  });

  it("A7 (declared): a stored raw vendor sector merges into the normalised bucket", () => {
    seedFullBook();
    const sectors = getAllocationByDimension(db, "sector").map((r) => r.group_name);
    expect(sectors).toContain("Technology");
    // Never a second bucket under the raw vendor string.
    expect(sectors).not.toContain("Information Technology");
    const panel = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "sector",
      bucket: "Technology",
    });
    const aliasRow = panel.find((r) => r.symbol === "ALIASX")!;
    expect(aliasRow.marketValue).toBeCloseTo(300, 6);
    expect(aliasRow.sector).toBe("Technology");
    // Opening the row by the raw vendor name reaches the same panel.
    const byRawName = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "sector",
      bucket: "Information Technology",
    });
    expect(byRawName.map((r) => r.symbol).sort()).toEqual(panel.map((r) => r.symbol).sort());
  });
});

describe("analysis drill-down identity", () => {
  it("sector, asset-class, and factor drill-down rows sum back to their breakdown row", () => {
    const account = seedAccount();
    const mix = seedSecurity("MIXETF", { security_type: "ETF", fund_category: "US Equity" });
    const short = seedSecurity("SHORTX", { security_type: "Stock", sector: "Technology" });
    const underlying = seedSecurity("UNDX", { security_type: "Stock", sector: "Technology" });
    const option = seedSecurity("UNDX  260320C00100000", {
      security_type: "Option",
      sector: "Technology",
      underlying_symbol: "UNDX",
      multiplier: 100,
    });
    const cash = seedSecurity("CASHX", {
      security_type: "Mutual Fund",
      fund_category: "Cash Equivalent",
    });

    seedHolding(account, mix, 10, 100); // 1000 split 60/40
    seedWeights("MIXETF", [
      ["Technology", 60],
      ["Financials", 40],
    ]);
    seedHolding(account, short, -5, 20); // -100 in Technology
    seedHolding(account, option, 1, 2); // 200 in Technology
    seedHolding(account, cash, 50, 1); // cash-equivalent fund, own bucket
    seedFactor(mix, "High", "csv_import");
    seedFactor(underlying, "High", "auto_underlying");

    const sectorBreakdown = getAllocationByDimension(db, "sector");
    const tech = sectorBreakdown.find((r) => r.group_name === "Technology")!;
    const financials = sectorBreakdown.find((r) => r.group_name === "Financials")!;
    const cashBucket = sectorBreakdown.find((r) => r.group_name === "Cash Equivalent")!;

    assertIdentity(
      tech,
      getHoldingsInBucket(db, "all", {
        kind: "classification",
        dimension: "sector",
        bucket: "Technology",
      })
    );
    assertIdentity(
      financials,
      getHoldingsInBucket(db, "all", {
        kind: "classification",
        dimension: "sector",
        bucket: "Financials",
      })
    );
    assertIdentity(
      cashBucket,
      getHoldingsInBucket(db, "all", {
        kind: "classification",
        dimension: "sector",
        bucket: "Cash Equivalent",
      })
    );

    const asset = getAllocationByDimension(db, "asset_class").find(
      (r) => r.group_name === "Option"
    )!;
    assertIdentity(
      asset,
      getHoldingsInBucket(db, "all", {
        kind: "classification",
        dimension: "asset_class",
        bucket: "Option",
      })
    );

    const factor = getAllocationByDimension(db, "ai_exposure").find(
      (r) => r.group_name === "High"
    )!;
    assertIdentity(
      factor,
      getHoldingsInBucket(db, "all", {
        kind: "factor",
        factor: "ai_exposure",
        bucket: "High",
      })
    );
  });
});
