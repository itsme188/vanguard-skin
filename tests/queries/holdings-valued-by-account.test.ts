import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getAllHoldings, getValuedHoldingsByAccount } from "@/lib/queries/holdings";
import { summarizeHoldingsFooter } from "@/app/dashboard/components/AllHoldingsTable";

/**
 * QA finding accounts-holdings-single--value-gain-alloc-columns-dropped-regression-2
 * (ruling 2026-08-30): the single-account Holdings table reads the same
 * priced rows as the All Accounts table, bound to one account.
 *
 * The identity this file protects: the footer totals are the sum of the rows
 * shown, and each row is valued the way the All Accounts table values it
 * (bond / 100, option x multiplier, native currency x FX, shorts negative).
 *
 * Fixtures are synthetic: ZZ* tickers, round invented numbers. Dates derive
 * from todayET() so the pin never goes wall-clock stale.
 */
let db: Database.Database;
const ACCOUNT = 1;
const OTHER_ACCOUNT = 2;
const TODAY = todayET();
const OLDER = addDays(TODAY, -30);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(
  symbol: string,
  f: {
    type?: string;
    currency?: string;
    multiplier?: number;
    expiration?: string;
    maturity?: string;
    fundCategory?: string;
  } = {},
): number {
  return db
    .prepare(
      `INSERT INTO securities
         (symbol, name, security_type, currency, multiplier, expiration_date, maturity_date,
          fund_category, underlying_symbol, option_type, strike_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      symbol,
      `${symbol} Corp`,
      f.type ?? "Stock",
      f.currency ?? "USD",
      f.multiplier ?? 1,
      f.expiration ?? null,
      f.maturity ?? null,
      f.fundCategory ?? null,
      f.type === "Option" ? "ZZAAA" : null,
      f.type === "Option" ? "CALL" : null,
      f.type === "Option" ? 50 : null,
    ).lastInsertRowid as number;
}

function seedHolding(
  accountId: number,
  securityId: number,
  quantity: number,
  costBasis: number | null,
  asOfDate: string = TODAY,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(accountId, securityId, quantity, costBasis, asOfDate, `zz-${accountId}-${securityId}-${asOfDate}`);
}

function seedPrice(securityId: number, price: number): void {
  db.prepare("INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(
    securityId,
    TODAY,
    price,
  );
}

/** A stock, a bond, an option, a short and a foreign-currency row, plus one
 *  position with no price and one row that belongs to another account. */
function seedBook(): void {
  const stock = seedSecurity("ZZAAA");
  // An older row with a different quantity: only the latest row may count.
  seedHolding(ACCOUNT, stock, 99, 3960, OLDER);
  seedHolding(ACCOUNT, stock, 10, 400);
  seedPrice(stock, 50); // 10 x 50 = 500

  const bond = seedSecurity("ZZBOND", { type: "Bond", maturity: addDays(TODAY, 400) });
  // Restated only on the monthly statement: an older as-of date, still live.
  seedHolding(ACCOUNT, bond, 10000, 9800, OLDER);
  seedPrice(bond, 99); // 10,000 face x 99 / 100 = 9,900

  const option = seedSecurity("ZZOPT", {
    type: "Option",
    multiplier: 100,
    expiration: addDays(TODAY, 30),
  });
  seedHolding(ACCOUNT, option, 2, 500);
  seedPrice(option, 3); // 2 x 3 x 100 = 600

  const short = seedSecurity("ZZSHT");
  seedHolding(ACCOUNT, short, -10, -600);
  seedPrice(short, 50); // -10 x 50 = -500, bought back for less than the 600 received

  const foreign = seedSecurity("ZZJPY", { currency: "JPY" });
  seedHolding(ACCOUNT, foreign, 100, 80000); // basis in yen
  seedPrice(foreign, 1000); // price in yen
  upsertFxRate(db, { currency: "JPY", usdPerUnit: 0.007, asOf: TODAY, source: "test" });
  // 100 x 1,000 x 0.007 = 700; basis 80,000 x 0.007 = 560

  const dark = seedSecurity("ZZDRK");
  seedHolding(ACCOUNT, dark, 5, null); // no price, no basis

  const other = seedSecurity("ZZOTH");
  seedHolding(OTHER_ACCOUNT, other, 7, 700);
  seedPrice(other, 200);
}

describe("getValuedHoldingsByAccount", () => {
  it("values a bond, an option, a short and a foreign-currency row in dollars", () => {
    seedBook();
    const bySymbol = new Map(getValuedHoldingsByAccount(db, ACCOUNT).map((r) => [r.symbol, r]));

    expect(bySymbol.get("ZZAAA")!.quantity).toBe(10);
    expect(bySymbol.get("ZZAAA")!.current_value).toBe(500);
    expect(bySymbol.get("ZZAAA")!.unrealized_gain).toBe(100);

    expect(bySymbol.get("ZZBOND")!.current_value).toBe(9900);
    expect(bySymbol.get("ZZBOND")!.unrealized_gain).toBe(100);
    expect(bySymbol.get("ZZBOND")!.as_of_date).toBe(OLDER);

    expect(bySymbol.get("ZZOPT")!.current_value).toBe(600);
    expect(bySymbol.get("ZZOPT")!.unrealized_gain).toBe(100);
    expect(bySymbol.get("ZZOPT")!.underlying_symbol).toBe("ZZAAA");

    expect(bySymbol.get("ZZSHT")!.current_value).toBe(-500);
    expect(bySymbol.get("ZZSHT")!.cost_basis).toBe(-600);
    expect(bySymbol.get("ZZSHT")!.unrealized_gain).toBe(100);

    expect(bySymbol.get("ZZJPY")!.current_value).toBeCloseTo(700, 6);
    expect(bySymbol.get("ZZJPY")!.cost_basis).toBeCloseTo(560, 6);
    expect(bySymbol.get("ZZJPY")!.unrealized_gain).toBeCloseTo(140, 6);

    // Unknown is not zero.
    expect(bySymbol.get("ZZDRK")!.current_value).toBeNull();
    expect(bySymbol.get("ZZDRK")!.unrealized_gain).toBeNull();
  });

  it("returns only the selected account's rows", () => {
    seedBook();
    const rows = getValuedHoldingsByAccount(db, ACCOUNT);
    expect(rows.map((r) => r.symbol).sort()).toEqual(
      ["ZZAAA", "ZZBOND", "ZZDRK", "ZZJPY", "ZZOPT", "ZZSHT"],
    );
    expect(rows.every((r) => r.account_id === ACCOUNT)).toBe(true);
    expect(getValuedHoldingsByAccount(db, OTHER_ACCOUNT).map((r) => r.symbol)).toEqual(["ZZOTH"]);
  });

  it("the footer totals equal the sum of the rows shown", () => {
    seedBook();
    const rows = getValuedHoldingsByAccount(db, ACCOUNT);
    const footer = summarizeHoldingsFooter(rows);

    const sumOf = (pick: (r: (typeof rows)[number]) => number | null) =>
      rows.reduce((total, r) => total + (pick(r) ?? 0), 0);

    expect(footer.totalValue).toBeCloseTo(sumOf((r) => r.current_value), 6);
    expect(footer.totalGain).toBeCloseTo(sumOf((r) => r.unrealized_gain), 6);
    expect(footer.totalCostBasis).toBeCloseTo(sumOf((r) => r.cost_basis), 6);

    // And the sums are the figures worked by hand above.
    expect(footer.totalValue).toBeCloseTo(500 + 9900 + 600 - 500 + 700, 6);
    expect(footer.totalCostBasis).toBeCloseTo(400 + 9800 + 500 - 600 + 560, 6);
    expect(footer.totalGain).toBeCloseTo(100 + 100 + 100 + 100 + 140, 6);
    // Every priced row here has a basis, so the three columns subtract.
    expect(footer.totalValue - footer.totalCostBasis!).toBeCloseTo(footer.totalGain!, 6);
    // The unpriced, basis-less row is counted, not valued at zero.
    expect(footer.noBasisUnpricedCount).toBe(1);
  });

  it("a filtered subset still sums to its own rows (bond + short)", () => {
    seedBook();
    const subset = getValuedHoldingsByAccount(db, ACCOUNT).filter(
      (r) => r.symbol === "ZZBOND" || r.symbol === "ZZSHT",
    );
    const footer = summarizeHoldingsFooter(subset);
    expect(footer.totalValue).toBe(9900 - 500);
    expect(footer.totalGain).toBe(200);
  });

  it("matches the All Accounts table row for row on value, cost basis and gain", () => {
    seedBook();
    const all = new Map(
      getAllHoldings(db)
        .filter((r) => r.account_id === ACCOUNT)
        .map((r) => [r.security_id, r]),
    );
    const rows = getValuedHoldingsByAccount(db, ACCOUNT);
    expect(rows.length).toBe(all.size);
    for (const r of rows) {
      const twin = all.get(r.security_id)!;
      expect(r.quantity).toBe(twin.quantity);
      expect(r.as_of_date).toBe(twin.as_of_date);
      expect(r.current_value).toBe(twin.current_value);
      expect(r.cost_basis).toBe(twin.cost_basis);
      expect(r.unrealized_gain).toBe(twin.unrealized_gain);
    }
  });

  it("leaves out a matured bond, an expired option and a closed position, as All Accounts does", () => {
    const matured = seedSecurity("ZZMAT", { type: "Bond", maturity: addDays(TODAY, -40) });
    seedHolding(ACCOUNT, matured, 5000, 4900);
    const expired = seedSecurity("ZZEXP", {
      type: "Option",
      multiplier: 100,
      expiration: addDays(TODAY, -40),
    });
    seedHolding(ACCOUNT, expired, 1, 100);
    const closed = seedSecurity("ZZCLS");
    seedHolding(ACCOUNT, closed, 10, 100, OLDER);
    seedHolding(ACCOUNT, closed, 0, null); // the reconciler's tombstone
    const live = seedSecurity("ZZLIV");
    seedHolding(ACCOUNT, live, 1, 10);

    expect(getValuedHoldingsByAccount(db, ACCOUNT).map((r) => r.symbol)).toEqual(["ZZLIV"]);
    expect(getAllHoldings(db).map((r) => r.symbol)).toEqual(["ZZLIV"]);
  });
});
