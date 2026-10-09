import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getMarketSnapshot, type QuoteFetcher, type MarketMove } from "@/lib/queries/market-snapshot";

/**
 * Owner rulings 2026-10-08 (chat movers):
 *  (1) one row per (symbol, side), with quantity, account(s) and market value;
 *      a single-account chat sees only its own legs.
 *  (2) each held row carries a dollar day effect measured with the Today
 *      line's rule (quantity opened today is measured from its cost).
 * All figures are invented round numbers.
 */

let db: Database.Database;
// Migration 002 seeds: Vanguard Taxable (1), Vanguard Roth IRA (2), IBKR (3).
const TAXABLE = 1;
const ROTH = 2;
const IBKR = 3;
const PRIOR = "2026-06-04";
const LATEST = "2026-06-05";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const spy = seedSecurity("SPY");
  seedPrice(spy, PRIOR, 600);
  seedPrice(spy, LATEST, 606);
});

function seedSecurity(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'Stock', 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedPrice(securityId: number, date: string, close: number): void {
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')").run(
    securityId,
    date,
    close,
  );
}

/** Same columns the live writer fills (lib/tws/positions.ts): cost is a TOTAL. */
function seedHolding(
  accountId: number,
  securityId: number,
  date: string,
  quantity: number,
  costBasis: number | null = null,
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(accountId, securityId, quantity, costBasis, date, `tws:${accountId}:${securityId}:${date}`);
}

/** A position held unchanged across both pair dates. */
function seedHeld(accountId: number, symbol: string, quantity: number, prior: number, latest: number): number {
  const id = seedSecurity(symbol);
  seedHolding(accountId, id, PRIOR, quantity);
  seedHolding(accountId, id, LATEST, quantity);
  seedPrice(id, PRIOR, prior);
  seedPrice(id, LATEST, latest);
  return id;
}

const rowsFor = (moves: MarketMove[], symbol: string) =>
  moves.filter((m) => m.symbol === symbol && m.kind === "holding");

describe("chat movers: one row per (symbol, side)", () => {
  it("long in one account and short in another gives two rows, each with its own account, quantity and sign", async () => {
    const id = seedHeld(TAXABLE, "ZZA", 100, 100, 102);
    seedHolding(IBKR, id, PRIOR, -40);
    seedHolding(IBKR, id, LATEST, -40);

    const snap = await getMarketSnapshot(db, { today: LATEST });
    const rows = rowsFor(snap.moves, "ZZA");
    expect(rows).toHaveLength(2);

    const long = rows.find((r) => r.position === "long")!;
    const short = rows.find((r) => r.position === "short")!;
    expect(long.accounts).toEqual(["Vanguard Taxable"]);
    expect(long.quantity).toBe(100);
    expect(long.market_value).toBeCloseTo(10200, 6);
    expect(long.day_effect).toBeCloseTo(200, 6);
    expect(short.accounts).toEqual(["IBKR"]);
    expect(short.quantity).toBe(-40);
    expect(short.market_value).toBeCloseTo(-4080, 6);
    // The price rose 2: the short lost.
    expect(short.day_effect).toBeCloseTo(-80, 6);
    // The percent is still the PRICE move on both rows.
    expect(long.pct).toBeCloseTo(2, 6);
    expect(short.pct).toBeCloseTo(2, 6);
  });

  it("the same side in two accounts stays one row with summed quantity, value and both accounts", async () => {
    const id = seedHeld(TAXABLE, "ZZB", 100, 50, 51);
    seedHolding(ROTH, id, PRIOR, 30);
    seedHolding(ROTH, id, LATEST, 30);

    const snap = await getMarketSnapshot(db, { today: LATEST });
    const rows = rowsFor(snap.moves, "ZZB");
    expect(rows).toHaveLength(1);
    expect(rows[0].position).toBe("long");
    expect(rows[0].quantity).toBe(130);
    expect(rows[0].accounts).toEqual(["Vanguard Roth IRA", "Vanguard Taxable"]);
    expect(rows[0].market_value).toBeCloseTo(130 * 51, 6);
    expect(rows[0].day_effect).toBeCloseTo(130, 6);
    expect(rows[0].day_effect_basis).toBe("prior_close");
  });

  it("a single-account scope sees only its own legs", async () => {
    const id = seedHeld(TAXABLE, "ZZA", 100, 100, 102);
    seedHolding(IBKR, id, PRIOR, -40);
    seedHolding(IBKR, id, LATEST, -40);
    seedHeld(ROTH, "ZZB", 30, 50, 51);

    const snap = await getMarketSnapshot(db, { today: LATEST, accountName: "IBKR" });
    const held = snap.moves.filter((m) => m.kind === "holding");
    expect(held).toHaveLength(1);
    expect(held[0].symbol).toBe("ZZA");
    expect(held[0].position).toBe("short");
    expect(held[0].accounts).toEqual(["IBKR"]);
    expect(held[0].quantity).toBe(-40);
    // Benchmarks are public market data and still come back.
    expect(snap.moves.some((m) => m.symbol === "SPY" && m.kind === "benchmark")).toBe(true);
  });

  it("an account name that matches no account shows no positions (never widened)", async () => {
    seedHeld(TAXABLE, "ZZA", 100, 100, 102);
    const snap = await getMarketSnapshot(db, { today: LATEST, accountName: "No Such Account" });
    expect(snap.moves.filter((m) => m.kind === "holding")).toHaveLength(0);
  });

  it("asks Yahoo for each symbol once and counts a symbol once in the as-of vote", async () => {
    const id = seedHeld(TAXABLE, "ZZA", 100, 100, 102);
    seedHolding(IBKR, id, PRIOR, -40);
    seedHolding(IBKR, id, LATEST, -40);

    let asked: string[] = [];
    const fetchQuotes: QuoteFetcher = async (symbols) => {
      asked = symbols;
      // One benchmark dated the 12th, the two-sided name dated the 11th. Counted
      // once each the vote ties and the later date wins; counted per row the
      // two-sided name would win 2 to 1.
      return {
        SPY: { price: 610, prior: 600, asOf: "2026-06-12" },
        ZZA: { price: 105, prior: 100, asOf: "2026-06-11" },
      };
    };
    // A week after the latest local close: the local book is stale.
    const snap = await getMarketSnapshot(db, { today: "2026-06-12", fetchQuotes });

    expect(snap.source).toBe("yahoo");
    expect(asked.filter((s) => s === "ZZA")).toHaveLength(1);
    expect(new Set(asked).size).toBe(asked.length);
    expect(snap.asOf).toBe("2026-06-12");
    // Both sides still come back, each with the live percent move.
    const rows = rowsFor(snap.moves, "ZZA");
    expect(rows.map((r) => r.position).sort()).toEqual(["long", "short"]);
    for (const r of rows) {
      expect(r.pct).toBeCloseTo(5, 6);
      // The local book is behind, so what was opened this session is not known:
      // no dollar effect, with the reason.
      expect(r.day_effect).toBeNull();
      expect(r.day_effect_reason).toMatch(/local book/i);
    }
  });

  it("a benchmark that is also held gets a holding row beside its benchmark row", async () => {
    const spy = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;
    seedHolding(TAXABLE, spy, PRIOR, 10);
    seedHolding(TAXABLE, spy, LATEST, 10);

    const snap = await getMarketSnapshot(db, { today: LATEST });
    const spyRows = snap.moves.filter((m) => m.symbol === "SPY");
    expect(spyRows.map((r) => r.kind)).toEqual(["benchmark", "holding"]);
    expect(spyRows[0].day_effect).toBeUndefined();
    expect(spyRows[1].day_effect).toBeCloseTo(60, 6);
  });
});

describe("chat movers: the opened-today rule reaches the snapshot", () => {
  // The book must have been SEEN at the prior close for a change to be dated
  // to this session; this unchanged position provides that snapshot.
  beforeEach(() => {
    seedHeld(IBKR, "ZZH", 100, 100, 102);
  });

  it("an unchanged position is measured close to close", async () => {
    const snap = await getMarketSnapshot(db, { today: LATEST });
    const [row] = rowsFor(snap.moves, "ZZH");
    expect(row.day_effect).toBeCloseTo(200, 6);
    expect(row.day_effect_basis).toBe("prior_close");
    expect(row.opened_today).toBe(false);
    expect(row.added_today).toBe(false);
    expect(row.day_effect_reason).toBeNull();
  });

  it("a position opened today with a cost is measured from that cost, not from the prior close", async () => {
    const id = seedSecurity("ZZN");
    seedPrice(id, PRIOR, 90);
    seedPrice(id, LATEST, 103);
    seedHolding(IBKR, id, LATEST, 50, 5000); // bought at 100

    const snap = await getMarketSnapshot(db, { today: LATEST });
    const [row] = rowsFor(snap.moves, "ZZN");
    // (103 - 100) x 50, never (103 - 90) x 50 = 650.
    expect(row.day_effect).toBeCloseTo(150, 6);
    expect(row.day_effect_basis).toBe("cost");
    expect(row.opened_today).toBe(true);
    expect(row.added_today).toBe(false);
    // The percent stays the security's price move.
    expect(row.pct).toBeCloseTo(((103 - 90) / 90) * 100, 6);
  });

  it("a position opened today with no usable cost has a null day effect and says why", async () => {
    const id = seedSecurity("ZZX");
    seedPrice(id, PRIOR, 90);
    seedPrice(id, LATEST, 103);
    seedHolding(IBKR, id, LATEST, 50, null);

    const snap = await getMarketSnapshot(db, { today: LATEST });
    const [row] = rowsFor(snap.moves, "ZZX");
    expect(row.day_effect).toBeNull();
    expect(row.day_effect_basis).toBe("excluded");
    expect(row.opened_today).toBe(true);
    expect(row.day_effect_reason).toMatch(/cost/i);
    // Quantity and value are still reported.
    expect(row.quantity).toBe(50);
    expect(row.market_value).toBeCloseTo(5150, 6);
  });

  it("an add to an existing position measures the held part close to close and the added part from its cost", async () => {
    const id = seedSecurity("ZZD");
    seedPrice(id, PRIOR, 100);
    seedPrice(id, LATEST, 112);
    seedHolding(IBKR, id, PRIOR, 100, 10000);
    seedHolding(IBKR, id, LATEST, 150, 15500); // 50 added at 110

    const snap = await getMarketSnapshot(db, { today: LATEST });
    const [row] = rowsFor(snap.moves, "ZZD");
    // 100 x (112 - 100) + 50 x (112 - 110)
    expect(row.day_effect).toBeCloseTo(1300, 6);
    expect(row.day_effect_basis).toBe("mixed");
    expect(row.opened_today).toBe(false);
    expect(row.added_today).toBe(true);
  });

  it("an add whose cost cannot be derived measures only the quantity held before, and says so", async () => {
    const id = seedSecurity("ZZE");
    seedPrice(id, PRIOR, 100);
    seedPrice(id, LATEST, 112);
    seedHolding(IBKR, id, PRIOR, 100, null);
    seedHolding(IBKR, id, LATEST, 150, null);

    const snap = await getMarketSnapshot(db, { today: LATEST });
    const [row] = rowsFor(snap.moves, "ZZE");
    expect(row.day_effect).toBeCloseTo(1200, 6);
    expect(row.added_today).toBe(true);
    expect(row.day_effect_reason).toMatch(/added/i);
  });

  it("one side held in two accounts where one leg is left out reports the measured leg and names the other", async () => {
    const id = seedHeld(TAXABLE, "ZZP", 100, 100, 102);
    // IBKR's book was seen at the prior close (ZZH above) without this name.
    seedHolding(IBKR, id, LATEST, 50, null); // opened today, no cost

    const snap = await getMarketSnapshot(db, { today: LATEST });
    const [row] = rowsFor(snap.moves, "ZZP");
    expect(row.quantity).toBe(150);
    expect(row.accounts).toEqual(["IBKR", "Vanguard Taxable"]);
    expect(row.day_effect).toBeCloseTo(200, 6);
    expect(row.day_effect_partial).toBe(true);
    expect(row.opened_today).toBe(true);
    expect(row.day_effect_reason).toContain("IBKR");
  });

  it("benchmark rows carry no position fields", async () => {
    const snap = await getMarketSnapshot(db, { today: LATEST });
    const spy = snap.moves.find((m) => m.symbol === "SPY")!;
    expect(spy.kind).toBe("benchmark");
    expect("day_effect" in spy).toBe(false);
    expect("quantity" in spy).toBe(false);
    expect("accounts" in spy).toBe(false);
  });
});
