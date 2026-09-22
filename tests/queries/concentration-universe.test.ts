/**
 * `getConcentrationUniverse` is the ONE position universe every concentration
 * figure is measured over (Concentration Metrics card + Risk Decomposition).
 * Two defects in its SQL, both found in review of the universe-unification
 * change:
 *
 *   1. The maturity cutoff read SQLite's `date('now')`, which is UTC. Between
 *      20:00 ET and midnight UTC the UTC calendar is already tomorrow, so a
 *      bond maturing TODAY (ET) silently dropped out of the book four hours
 *      early — a position vanished from the Herfindahl, the position count
 *      and the top-5 share for the last four hours of every trading day.
 *      Project rule: ET-anchor every user-facing "today" (`todayET()`), never
 *      SQL `date('now')`.
 *   2. Zero-value rows were dropped with the float equality
 *      `HAVING SUM(market_value) <> 0`. A long leg and a short leg that
 *      cancel do not land on a bit-exact 0 — they land on a sub-nanodollar
 *      residual — so the netted-out position survived as a real position,
 *      carrying ~0 weight but inflating the POSITION COUNT (and therefore
 *      the "behaves like ~N equal positions" sentence) by one.
 *
 * All figures here are synthetic round numbers on synthetic tickers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import {
  getConcentrationUniverse,
  concentrationTotalValue,
} from "@/lib/queries/concentration-universe";
import { computeConcentration } from "@/lib/compute/risk";
import { todayET } from "@/lib/calendar/date-utils";

const HOLDINGS_DATE = "2026-03-02";

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (
    db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as {
      id: number;
    }
  ).id;
}

function seedSecurity(
  symbol: string,
  opts: { security_type?: string; maturity_date?: string } = {}
): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, multiplier, maturity_date) VALUES (?, ?, ?, 1, ?)"
    )
    .run(
      symbol,
      `${symbol} Test Issuer`,
      opts.security_type ?? "Stock",
      opts.maturity_date ?? null
    ).lastInsertRowid as number;
}

function seedHolding(
  accountId: number,
  securityId: number,
  quantity: number,
  costBasis: number | null = null
) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    accountId,
    securityId,
    quantity,
    costBasis,
    HOLDINGS_DATE,
    `h-${accountId}-${securityId}`
  );
}

function seedPrice(securityId: number, price: number) {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, price, HOLDINGS_DATE);
}

function freshDb() {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
}

describe("concentration universe: the maturity cutoff is ET-anchored", () => {
  /**
   * 02:30 UTC on 2026-09-22 is 22:30 ET on 2026-09-21 — inside the four-hour
   * window where the UTC calendar has already rolled over and the ET one has
   * not. `todayET()` reads the faked clock; SQLite's `date('now')` reads the
   * machine clock and cannot see it, which is exactly why a date the user
   * cares about must never be resolved in SQL.
   */
  const ET_EVENING = new Date("2026-09-22T02:30:00Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(ET_EVENING);
    freshDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a bond maturing TODAY in ET, after the UTC date has already rolled over", () => {
    const acct = seedAccount("Cutoff Account");

    // ALFA matures today (ET). It is still a position until the day is over.
    const alfa = seedSecurity("ALFA", {
      security_type: "Bond",
      maturity_date: todayET(),
    });
    seedHolding(acct, alfa, 10_000, 9_800);
    seedPrice(alfa, 100);

    // BETA matured yesterday (ET). It is not a position any more.
    const yesterdayET = new Date(ET_EVENING.getTime() - 24 * 3600 * 1000);
    const beta = seedSecurity("BETA", {
      security_type: "Bond",
      maturity_date: todayET(yesterdayET),
    });
    seedHolding(acct, beta, 20_000, 19_500);
    seedPrice(beta, 100);

    const symbols = getConcentrationUniverse(db).map((p) => p.symbol);
    expect(symbols).toContain("ALFA");
    expect(symbols).not.toContain("BETA");
  });

  it("an explicit asOfDate still moves the cutoff with it", () => {
    const acct = seedAccount("As-Of Account");
    const gama = seedSecurity("GAMA", {
      security_type: "Bond",
      maturity_date: "2026-06-30",
    });
    seedHolding(acct, gama, 10_000, 9_900);
    seedPrice(gama, 100);

    // Matured relative to today, live relative to a date before maturity.
    expect(getConcentrationUniverse(db).map((p) => p.symbol)).not.toContain("GAMA");
    expect(
      getConcentrationUniverse(db, undefined, { asOfDate: "2026-06-01" }).map(
        (p) => p.symbol
      )
    ).toContain("GAMA");
  });

  it("resolves the cutoff in JS, never with SQL date('now')", () => {
    // Source pin: the clock-skew defect above is invisible to a behavioural
    // test for most of the day, so also forbid the construct outright.
    const src = fs.readFileSync(
      path.join(
        path.resolve(__dirname, "..", ".."),
        "lib/queries/concentration-universe.ts"
      ),
      "utf-8"
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/date\(\s*['"]now['"]\s*\)/);
    expect(code).toMatch(/todayET/);
  });
});

describe("concentration universe: a netted-out position is not a position", () => {
  beforeEach(() => {
    freshDb();
  });

  it("drops a long/short pair that nets to a sub-nanodollar residual", () => {
    const acctA = seedAccount("Netting Account A");
    const acctB = seedAccount("Netting Account B");

    // DELT: a real position, so the universe is not empty.
    const delt = seedSecurity("DELT");
    seedHolding(acctA, delt, 100, 900);
    seedPrice(delt, 10);

    // EPSI: 100 shares long in one account against 99.999999999 shares short
    // in the other. The legs do NOT cancel to a bit-exact zero — they leave a
    // residual around a billionth of a dollar, which `<> 0` counts as a live
    // position.
    const epsi = seedSecurity("EPSI");
    seedHolding(acctA, epsi, 100, 1_000);
    seedHolding(acctB, epsi, -99.999999999, -1_000);
    seedPrice(epsi, 1);

    const universe = getConcentrationUniverse(db);
    const epsiRow = universe.find((p) => p.symbol === "EPSI");

    // Guard the fixture itself: if the residual were an exact 0 the old
    // `<> 0` would already have caught it and this test would prove nothing.
    const residual = 100 * 1 + -99.999999999 * 1;
    expect(residual).not.toBe(0);
    expect(Math.abs(residual)).toBeLessThan(0.005);

    expect(epsiRow).toBeUndefined();
    expect(universe.map((p) => p.symbol)).toEqual(["DELT"]);
  });

  it("the netted-out pair does not inflate positionCount on the Risk Decomposition card", () => {
    const acctA = seedAccount("Netting Account A");
    const acctB = seedAccount("Netting Account B");

    const delt = seedSecurity("DELT");
    seedHolding(acctA, delt, 100, 900);
    seedPrice(delt, 10);

    const epsi = seedSecurity("EPSI");
    seedHolding(acctA, epsi, 100, 1_000);
    seedHolding(acctB, epsi, -99.999999999, -1_000);
    seedPrice(epsi, 1);

    const risk = computeConcentration(db);
    expect(risk.positionCount).toBe(1);
    // One position => the whole book is that position.
    expect(risk.herfindahl).toBeCloseTo(1, 9);
  });

  it("still keeps a small but real position", () => {
    const acct = seedAccount("Small Position Account");

    const delt = seedSecurity("DELT");
    seedHolding(acct, delt, 100, 900);
    seedPrice(delt, 10);

    // ZETA is worth one cent — small, but a position we actually hold.
    const zeta = seedSecurity("ZETA");
    seedHolding(acct, zeta, 1, 1);
    seedPrice(zeta, 0.01);

    const universe = getConcentrationUniverse(db);
    expect(universe.map((p) => p.symbol).sort()).toEqual(["DELT", "ZETA"]);
    expect(concentrationTotalValue(universe)).toBeCloseTo(1000.01, 9);
  });
});
