import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, type ScenarioDefinition } from "@/lib/compute/scenarios";
import { loadScenarioPositions, loadScenarioPositionsByAccount } from "@/lib/compute/scenario-positions";

/**
 * Gains at risk, Task 4: the custom scenario engine's position query moved
 * into a shared loader (lib/compute/scenario-positions.ts). This pin holds
 * computeScenario's output to the figures it printed BEFORE the move,
 * generated from the unchanged code under the same seed and clock.
 *
 * Compared through a JSON round trip: the fixture is JSON, which drops keys
 * whose value is undefined. That is also the shape the API route returns.
 */

/** Fixed clock for the pin: every option's time to expiry depends on it. */
const PIN_NOW = "2026-06-01T15:00:00Z";
const PIN_TODAY = "2026-06-01";

const PIN_SCENARIOS: ScenarioDefinition[] = [
  { id: "custom-pin-a", name: "Pin A", description: "pin", category: "custom", marketMove: -0.2 },
  { id: "custom-pin-b", name: "Pin B", description: "pin", category: "custom", marketMove: 0.1, volMove: 20 },
  {
    id: "custom-pin-c",
    name: "Pin C",
    description: "pin",
    category: "custom",
    marketMove: -0.1,
    rateMove: 50,
    sectorMoves: { Technology: -0.25 },
  },
];
const PIN_SCOPES: (number[] | undefined)[] = [undefined, [1], []];

/**
 * A synthetic book with one row of every shape the custom engine reads.
 * ZZ* tickers and round made-up numbers only.
 */
function seedPinBook(db: Database.Database): void {
  const today = PIN_TODAY;
  const expiry = "2026-09-18";
  // Accounts 1 and 2 are the two the migrations seed.
  const sec = db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, style, market_cap_category, fund_category,
       duration_years, maturity_date, coupon_rate, currency, leverage_factor,
       underlying_symbol, strike_price, expiration_date, option_type, multiplier)
     VALUES (@id, @symbol, @name, @type, @sector, @style, @cap, @fundCategory,
       @duration, @maturity, @coupon, @currency, @factor,
       @underlying, @strike, @expiry, @optionType, @multiplier)`,
  );
  const base = {
    name: null, sector: null, style: null, cap: null, fundCategory: null, duration: null, maturity: null,
    coupon: null, currency: "USD", factor: null, underlying: null, strike: null, expiry: null,
    optionType: null, multiplier: 1,
  };
  const price = db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')");
  let n = 0;
  const hold = (account: number, id: number, qty: number) =>
    db
      .prepare("INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)")
      .run(account, id, today, qty, `pin-${++n}`);

  // 1 stock (Technology, Growth, Large Cap)
  sec.run({ ...base, id: 1, symbol: "ZZST", name: "ZZ Systems", type: "Stock", sector: "Technology", style: "Growth", cap: "Large Cap" });
  price.run(1, today, 100);
  db.prepare("INSERT INTO security_quotes (security_id, as_of_date, iv_underlying) VALUES (1, ?, 0.3)").run(today);
  hold(1, 1, 50);
  // 2 ETF with sector weights
  sec.run({ ...base, id: 2, symbol: "ZZEF", name: "ZZ Equity Fund", type: "ETF", sector: "Diversified" });
  price.run(2, today, 200);
  db.prepare(
    "INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES ('ZZEF', 'Technology', 60, ?, 'manual'), ('ZZEF', 'Healthcare', 40, ?, 'manual')",
  ).run(today, today);
  hold(1, 2, 10);
  // 3 money-market fund
  sec.run({ ...base, id: 3, symbol: "ZZMM", name: "ZZ Cash Reserves", type: "Mutual Fund", fundCategory: "Cash Equivalent" });
  price.run(3, today, 1);
  hold(1, 3, 1000);
  // 4 bond with a stored duration
  sec.run({ ...base, id: 4, symbol: "ZZBOND31", name: "ZZ Corp 4% 2031", type: "Bond", duration: 4, maturity: "2031-06-01", coupon: 4 });
  price.run(4, today, 98);
  hold(1, 4, 1000);
  // 5 bond fund with a stored duration
  sec.run({ ...base, id: 5, symbol: "ZZBF", name: "ZZ Bond Index", type: "Mutual Fund", sector: "Fixed Income", fundCategory: "Intermediate Core Bond", duration: 6 });
  price.run(5, today, 10);
  hold(1, 5, 100);
  // 6 leveraged fund with a factor, 7 without
  sec.run({ ...base, id: 6, symbol: "ZZ3X", name: "ZZ UltraPro 3X Index Fund", type: "ETF", sector: "Technology", factor: 3 });
  price.run(6, today, 50);
  hold(2, 6, 20);
  sec.run({ ...base, id: 7, symbol: "ZZ2X", name: "ZZ Ultra 2X Fund", type: "ETF", sector: "Energy" });
  price.run(7, today, 25);
  hold(2, 7, 40);
  // 8 long put, 9 short call, 10 unpriced put (all on ZZST)
  sec.run({ ...base, id: 8, symbol: "ZZST P95", type: "Option", underlying: "ZZST", strike: 95, expiry, optionType: "PUT", multiplier: 100 });
  price.run(8, today, 3);
  hold(1, 8, 2);
  sec.run({ ...base, id: 9, symbol: "ZZST C110", type: "Option", underlying: "ZZST", strike: 110, expiry, optionType: "CALL", multiplier: 100 });
  price.run(9, today, 2);
  hold(2, 9, -1);
  sec.run({ ...base, id: 10, symbol: "ZZST P90", type: "Option", underlying: "ZZST", strike: 90, expiry, optionType: "PUT", multiplier: 100 });
  hold(1, 10, 1);
  // 11 unpriced stock, 12 short stock
  sec.run({ ...base, id: 11, symbol: "ZZNP", name: "ZZ No Price", type: "Stock", sector: "Industrials" });
  hold(1, 11, 100);
  sec.run({ ...base, id: 12, symbol: "ZZSH", name: "ZZ Shorted", type: "Stock", sector: "Consumer Discretionary" });
  price.run(12, today, 40);
  hold(2, 12, -100);
  // 13 foreign-currency stock (ZZD at 0.5 USD)
  sec.run({ ...base, id: 13, symbol: "ZZFX", name: "ZZ Overseas", type: "Stock", sector: "Utilities", currency: "ZZD" });
  price.run(13, today, 300);
  db.prepare("INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('ZZD', 0.5, ?, 'manual')").run(today);
  hold(1, 13, 10);
  // 14 the same stock long in one account and short in the other
  sec.run({ ...base, id: 14, symbol: "ZZLS", name: "ZZ Long Short Co", type: "Stock", sector: "Healthcare", style: "Value" });
  price.run(14, today, 50);
  hold(1, 14, 100);
  hold(2, 14, -40);
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/custom-scenario-loader-pin.json"), "utf8"),
) as unknown[];

describe("custom scenario output is pinned across the loader extraction", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(PIN_NOW));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedPinBook(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it("the fixture holds every case", () => {
    expect(fixture).toHaveLength(PIN_SCENARIOS.length * PIN_SCOPES.length);
  });

  let i = 0;
  for (const s of PIN_SCENARIOS) {
    for (const accountIds of PIN_SCOPES) {
      const index = i++;
      it(`${s.id} over scope ${JSON.stringify(accountIds) ?? "undefined"}`, () => {
        const result = computeScenario(db, s, { accountIds });
        expect(JSON.parse(JSON.stringify(result))).toStrictEqual(fixture[index]);
      });
    }
  }

  it("the loader keeps a row with no price (F10) and carries the dollar inputs", () => {
    const rows = loadScenarioPositions(db, undefined);
    const unpriced = rows.find((r) => r.symbol === "ZZNP");
    expect(unpriced).toMatchObject({ own_price: null, market_value: 0, total_qty: 100, multiplier: 1 });
    const put = rows.find((r) => r.symbol === "ZZST P90")!;
    expect(put).toMatchObject({ multiplier: 100, underlying_security_id: 1, stored_underlying_symbol: "ZZST", usd_per_unit: 1 });
    const fx = rows.find((r) => r.symbol === "ZZFX")!;
    expect(fx).toMatchObject({ usd_per_unit: 0.5, fx_usd_per_unit: 0.5, market_value: 1500 });
    expect(rows.find((r) => r.symbol === "ZZST")!.fx_usd_per_unit).toBeNull();
    expect(rows.find((r) => r.symbol === "ZZLS")!.total_qty).toBe(60);
  });

  it("the by-account loader keeps a long and a short of one security apart (F11)", () => {
    const rows = loadScenarioPositionsByAccount(db, undefined).filter((r) => r.symbol === "ZZLS");
    expect(rows.map((r) => [r.account_id, r.total_qty, r.market_value])).toEqual([
      [1, 100, 5000],
      [2, -40, -2000],
    ]);
    expect(rows.every((r) => typeof r.account_name === "string" && r.account_name.length > 0)).toBe(true);
    expect(loadScenarioPositionsByAccount(db, [2]).every((r) => r.account_id === 2)).toBe(true);
    expect(loadScenarioPositionsByAccount(db, [])).toEqual([]);
  });
});
