import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";
import { mapPlaidHoldings } from "@/lib/plaid/map-holdings";
import { isPreOpenRead, writePlaidHoldings } from "@/lib/plaid/refresh";
import type { PlaidHolding, PlaidHoldingsResponse, PlaidSecurity } from "@/lib/plaid/client";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import { previousTradingDay } from "@/lib/calendar/market-holidays";

// Synthetic symbols and round numbers only. The run day is a Monday, so the
// session a pre-open Plaid read describes is the previous Friday.
const RUN_DAY = "2026-07-13";
const SESSION = "2026-07-10";

let db: Database.Database;
let acct: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Taxable')`).run();
  acct = (db.prepare(`SELECT id FROM accounts WHERE name = 'Vanguard Taxable'`).get() as { id: number }).id;
});

function holding(id: string, quantity: number, price: number | null, asOf: string | null): PlaidHolding {
  return {
    account_id: "pTax",
    security_id: id,
    quantity,
    institution_price: price,
    institution_value: price == null ? null : price * quantity,
    institution_price_as_of: asOf,
  };
}

function security(id: string, ticker: string, type: string, extra: Partial<PlaidSecurity> = {}): PlaidSecurity {
  return { security_id: id, ticker_symbol: ticker, cusip: null, name: ticker, type, is_cash_equivalent: false, ...extra };
}

function resp(holdings: PlaidHolding[], securities: PlaidSecurity[]): PlaidHoldingsResponse {
  return {
    accounts: [{ account_id: "pTax", name: "Brokerage", mask: "0000", subtype: "brokerage", balances: { current: 100000, available: null } }],
    holdings,
    securities,
  };
}

// The writer takes the session the book is dated on (plan v4 A1); the
// refresh passes previousTradingDay(run day). Same here.
function write(r: PlaidHoldingsResponse, runDay = RUN_DAY) {
  return writePlaidHoldings(db, mapPlaidHoldings(r), { pTax: acct }, previousTradingDay(runDay), { runDay });
}

function pricesFor(symbol: string): { date: string; close_price: number; source: string }[] {
  return db
    .prepare(
      `SELECT p.date, p.close_price, p.source FROM prices p JOIN securities s ON s.id = p.security_id
        WHERE s.symbol = ? ORDER BY p.date`,
    )
    .all(symbol) as { date: string; close_price: number; source: string }[];
}

describe("mapPlaidHoldings — institution prices", () => {
  it("collects stock, ETF and fund prices; rejects non-finite and non-positive prices", () => {
    const r = mapPlaidHoldings(
      resp(
        [
          holding("a", 10, 100, SESSION),
          holding("b", 10, 50, null),
          holding("c", 10, 20, SESSION),
          holding("d", 10, 0, SESSION),
          holding("e", 10, -5, SESSION),
          holding("f", 10, Number.NaN, SESSION),
          holding("g", 10, Number.POSITIVE_INFINITY, SESSION),
          holding("h", 10, null, SESSION),
        ],
        [
          security("a", "ZSTK", "equity"),
          security("b", "ZETF", "etf"),
          security("c", "ZFND", "mutual fund"),
          security("d", "ZZER", "equity"),
          security("e", "ZNEG", "equity"),
          security("f", "ZNAN", "equity"),
          security("g", "ZINF", "equity"),
          security("h", "ZNUL", "equity"),
        ],
      ),
    );
    expect(r.institutionPrices).toEqual([
      { plaidAccountId: "pTax", symbol: "ZSTK", kind: "equity", price: 100, asOf: SESSION },
      { plaidAccountId: "pTax", symbol: "ZETF", kind: "equity", price: 50, asOf: null },
      { plaidAccountId: "pTax", symbol: "ZFND", kind: "mutual_fund", price: 20, asOf: SESSION },
    ]);
    // The positions themselves are unaffected by a bad price.
    expect(r.positions.map((p) => p.symbol)).toHaveLength(8);
  });

  it("leaves out options (contract and OCC-shaped ticker) and bonds", () => {
    const r = mapPlaidHoldings(
      resp(
        [holding("o", 2, 5, SESSION), holding("q", 1, 3, SESSION), holding("t", 1000, 99, SESSION)],
        [
          security("o", "ZOPT", "derivative", {
            option_contract: { contract_type: "put", expiration_date: "2027-01-15", strike_price: 50, underlying_security_ticker: "ZOPT" },
          }),
          security("q", "ZQQ270115P00050000", "etf"),
          { security_id: "t", ticker_symbol: null, cusip: "000000AA0", name: "Bond", type: "fixed income", is_cash_equivalent: false },
        ],
      ),
    );
    expect(r.institutionPrices).toEqual([]);
  });
});

describe("writePlaidHoldings — Vanguard price when the broker feed has none", () => {
  it("dates a stock price on the previous session, never on the run day", () => {
    const r = write(resp([holding("a", 10, 100, SESSION)], [security("a", "ZSTK", "equity")]));
    expect(pricesFor("ZSTK")).toEqual([{ date: SESSION, close_price: 100, source: "plaid" }]);
    expect(r.pricesWritten).toBe(1);
    expect(r.priceAsOfMismatches).toBe(0);
  });

  it("ignores Plaid's as-of date for a stock and counts the mismatch", () => {
    // as-of one session early (the measured fund shape) and as-of the run
    // day both land on the session; a null as-of lands there too, uncounted.
    const r = write(
      resp(
        [holding("a", 10, 100, "2026-07-09"), holding("b", 10, 50, RUN_DAY), holding("c", 10, 20, null)],
        [security("a", "ZSTK", "equity"), security("b", "ZETF", "etf"), security("c", "ZTHR", "equity")],
      ),
    );
    expect(pricesFor("ZSTK")).toEqual([{ date: SESSION, close_price: 100, source: "plaid" }]);
    expect(pricesFor("ZETF")).toEqual([{ date: SESSION, close_price: 50, source: "plaid" }]);
    expect(pricesFor("ZTHR")).toEqual([{ date: SESSION, close_price: 20, source: "plaid" }]);
    expect(r.priceAsOfMismatches).toBe(2);
    expect(r.pricesWritten).toBe(3);
  });

  it("a tws price on the session date wins; a stock with no row gets the Plaid price", () => {
    const priced = upsertSecurity(db, { symbol: "ZTWS", securityType: "Stock" });
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 111, 'tws')`).run(priced, SESSION);

    const r = write(
      resp(
        [holding("a", 10, 100, null), holding("b", 10, 40, null)],
        [security("a", "ZTWS", "equity"), security("b", "ZNEW", "equity")],
      ),
    );
    expect(pricesFor("ZTWS")).toEqual([{ date: SESSION, close_price: 111, source: "tws" }]);
    expect(pricesFor("ZNEW")).toEqual([{ date: SESSION, close_price: 40, source: "plaid" }]);
    expect(r.pricesWritten).toBe(1); // the tws-blocked write is not counted
  });

  it("a statement price on the session date wins", () => {
    const id = upsertSecurity(db, { symbol: "ZSTM", securityType: "Stock" });
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 222, 'vanguard-pdf')`).run(id, SESSION);
    const r = write(resp([holding("a", 10, 100, null)], [security("a", "ZSTM", "equity")]));
    expect(pricesFor("ZSTM")).toEqual([{ date: SESSION, close_price: 222, source: "vanguard-pdf" }]);
    expect(r.pricesWritten).toBe(0);
  });

  it("a later Plaid read may replace an earlier Plaid price on the same session", () => {
    write(resp([holding("a", 10, 100, null)], [security("a", "ZSTK", "equity")]));
    write(resp([holding("a", 10, 101, null)], [security("a", "ZSTK", "equity")]));
    expect(pricesFor("ZSTK")).toEqual([{ date: SESSION, close_price: 101, source: "plaid" }]);
  });

  it("never dates a stock price on a closed market day (forced weekend run)", () => {
    write(resp([holding("a", 10, 100, null)], [security("a", "ZSTK", "equity")]), "2026-07-12");
    expect(pricesFor("ZSTK")).toEqual([{ date: SESSION, close_price: 100, source: "plaid" }]);
    // The day after a holiday steps over it (Mon 2026-06-22 → Thu 06-18).
    write(resp([holding("a", 10, 102, null)], [security("a", "ZSTK", "equity")]), "2026-06-22");
    expect(pricesFor("ZSTK")[0]).toEqual({ date: "2026-06-18", close_price: 102, source: "plaid" });
  });

  it("dates a mutual-fund price on the session too; a mismatching as-of is only counted (plan v4 A1)", () => {
    const r = write(
      resp(
        [holding("a", 10, 20, "2026-07-09"), holding("b", 10, 30, null)],
        [security("a", "ZFND", "mutual fund"), security("b", "ZFNN", "mutual fund")],
      ),
    );
    expect(pricesFor("ZFND")).toEqual([{ date: SESSION, close_price: 20, source: "plaid" }]);
    expect(pricesFor("ZFNN")).toEqual([{ date: SESSION, close_price: 30, source: "plaid" }]);
    expect(r.priceAsOfMismatches).toBe(1);
  });

  it("a dotted share-class price lands on the slash-form security the holding uses", () => {
    const slashId = upsertSecurity(db, { symbol: "ZBR/B", securityType: "Stock" });
    const r = write(resp([holding("a", 10, 300, null)], [security("a", "ZBR.B", "equity")]));
    expect(db.prepare(`SELECT COUNT(*) AS c FROM securities WHERE symbol = 'ZBR.B'`).get()).toEqual({ c: 0 });
    const holdingRow = db
      .prepare(`SELECT security_id FROM holdings WHERE account_id = ? AND as_of_date = ?`)
      .get(acct, SESSION) as { security_id: number };
    expect(holdingRow.security_id).toBe(slashId);
    expect(
      db.prepare(`SELECT security_id, date, close_price FROM prices WHERE security_id = ?`).all(slashId),
    ).toEqual([{ security_id: slashId, date: SESSION, close_price: 300 }]);
    expect(r.pricesWritten).toBe(1);
  });

  it("writes no option price", () => {
    write(
      resp(
        [holding("a", 10, 100, null), holding("o", 1, 5, null)],
        [
          security("a", "ZSTK", "equity"),
          security("o", "ZOPT", "derivative", {
            option_contract: { contract_type: "call", expiration_date: "2027-01-15", strike_price: 50, underlying_security_ticker: "ZOPT" },
          }),
        ],
      ),
    );
    const optionPrices = db
      .prepare(`SELECT COUNT(*) AS c FROM prices p JOIN securities s ON s.id = p.security_id WHERE LOWER(s.security_type) = 'option'`)
      .get() as { c: number };
    expect(optionPrices.c).toBe(0);
  });

  it("a stock price on a statement-closed pair still bumps the tax generation", () => {
    const id = upsertSecurity(db, { symbol: "ZCLS", securityType: "Stock" });
    // A statement-grade zero (closed) on the session date: a new price on or
    // before that date can change a synthetic close.
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 0, 0, ?, 'vanguard-pdf:holding:z:1')`,
    ).run(acct, id, SESSION);
    const before = getTaxInputGeneration(db);
    write(
      resp(
        [holding("k", 10, 10, null), holding("c", 1, 100, null)],
        [security("k", "ZKEP", "equity"), security("c", "ZCLS", "equity")],
      ),
    );
    expect(getTaxInputGeneration(db)).toBeGreaterThan(before);
  });
});

// The refresh stores nothing outside the pre-open window (plan v4 A2;
// tests/plaid/refresh-session-dating.test.ts), so the writer has no
// "skip stock prices" switch any more. isPreOpenRead stays as an alias.
describe("the pre-open window", () => {
  it("isPreOpenRead: a trading day from 07:30 to before 09:30 Eastern only", () => {
    // 2026-07-13 is a Monday; July is UTC-4.
    expect(isPreOpenRead(new Date("2026-07-13T11:29:00Z"))).toBe(false); // 07:29 ET
    expect(isPreOpenRead(new Date("2026-07-13T11:30:00Z"))).toBe(true); // 07:30 ET
    expect(isPreOpenRead(new Date("2026-07-13T13:29:00Z"))).toBe(true); // 09:29 ET
    expect(isPreOpenRead(new Date("2026-07-13T13:30:00Z"))).toBe(false); // 09:30 ET
    expect(isPreOpenRead(new Date("2026-07-13T19:00:00Z"))).toBe(false); // 15:00 ET
    expect(isPreOpenRead(new Date("2026-07-12T11:30:00Z"))).toBe(false); // Sunday
    expect(isPreOpenRead(new Date("2026-07-03T11:30:00Z"))).toBe(false); // holiday observed
  });
});
