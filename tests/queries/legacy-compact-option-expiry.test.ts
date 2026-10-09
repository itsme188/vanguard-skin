/**
 * An option's stored expiration comes in two spellings: dashed `YYYY-MM-DD`
 * and the legacy compact `YYYYMMDD` (stored rows are not normalized). A raw
 * string compare reads the compact form as later than every dashed day
 * (`'20260605' >= '2026-06-10'` is true), and SQLite's `date()` reads it as
 * NULL. So an expired legacy-format option stayed "held" for earnings
 * coverage and was never purged.
 *
 * Every reader here must agree with `liveOptionExpirationSql`: live through
 * the end of the Eastern expiration day, in either spelling.
 *
 * Synthetic symbols only. The clock is frozen on Date (SQLite's own clock
 * cannot be faked, which is the point: nothing here may read it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import {
  coveredForEvents,
  getHeldOptionUnderlyingSymbols,
  getSymbolStatusDetailed,
} from "@/lib/queries/briefing-symbols";
import { purgeExpiredOptionHoldings } from "@/lib/mutations/expired-options";
import { getStockTypedSweepCandidates } from "@/scripts/repair-etf-types";

const aiCalls = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => aiCalls.generate(...a),
}));

import { classifyFactors } from "@/lib/compute/classify-factors";

// 09:30 and 21:00 Eastern on 2026-06-10 (EDT, UTC-4). At 21:00 the UTC day
// has already rolled to 06-11.
const MORNING_ET = new Date("2026-06-10T13:30:00Z");
const EVENING_ET = new Date("2026-06-11T01:00:00Z");
const TODAY = "2026-06-10";
const ACCT = 1;
const IBKR = 3;

const compact = (day: string) => day.replaceAll("-", "");

let db: Database.Database;

function freeze(at: Date): void {
  vi.setSystemTime(at);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  freeze(MORNING_ET);
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  aiCalls.generate.mockReset();
  aiCalls.generate.mockRejectedValue(new Error("no AI in this test"));
});

afterEach(() => {
  vi.useRealTimers();
});

function seedOption(underlying: string, expiration: string | null): number {
  const symbol = `${underlying} OPT ${expiration ?? "none"}`;
  const existing = db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  return db
    .prepare(
      `INSERT INTO securities
         (symbol, name, security_type, asset_class, multiplier, expiration_date,
          underlying_symbol, option_type, strike_price)
       VALUES (?, ?, 'Option', 'equity', 100, ?, ?, 'call', 100)`,
    )
    .run(symbol, `${underlying} call`, expiration, underlying)
    .lastInsertRowid as number;
}

function seedStock(symbol: string): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class) VALUES (?, ?, 'Stock', 'equity')`,
    )
    .run(symbol, `${symbol} name`).lastInsertRowid as number;
}

function seedHolding(
  secId: number,
  o: { accountId?: number; asOf?: string; sourceKey?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, 1, 1000, ?, ?)`,
  ).run(o.accountId ?? ACCT, secId, o.asOf ?? addDays(TODAY, -1), o.sourceKey ?? null);
}

function heldOption(underlying: string, expiration: string | null): number {
  const id = seedOption(underlying, expiration);
  seedHolding(id);
  return id;
}

const held = (symbols: string[], opts: { today?: string } = {}) => {
  const status = getSymbolStatusDetailed(db, symbols, opts);
  return Object.fromEntries(symbols.map((s) => [s, status[s].reasons.held]));
};

describe("the frozen clocks", () => {
  it("are both 2026-06-10 in Eastern time; the evening one is 06-11 in UTC", () => {
    expect(todayET()).toBe(TODAY);
    freeze(EVENING_ET);
    expect(todayET()).toBe(TODAY);
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-06-11");
  });
});

describe("earnings coverage reads a compact-form expiration as its day", () => {
  it("a name held only through a compact-form option expired 5 days ago is not covered", () => {
    heldOption("ZZA", compact(addDays(TODAY, -5)));
    expect(held(["ZZA"])).toEqual({ ZZA: false });
    expect(getHeldOptionUnderlyingSymbols(db)).toEqual([]);
    expect(coveredForEvents(db, [{ symbol: "ZZA", eventId: 1 }]).size).toBe(0);
  });

  it("a compact-form option expiring today covers the name through the Eastern day", () => {
    heldOption("ZZA", compact(TODAY));
    heldOption("ZZB", compact(addDays(TODAY, -1)));
    heldOption("ZZC", compact(addDays(TODAY, 30)));
    for (const at of [MORNING_ET, EVENING_ET]) {
      freeze(at);
      expect(held(["ZZA", "ZZB", "ZZC"])).toEqual({ ZZA: true, ZZB: false, ZZC: true });
      expect(getHeldOptionUnderlyingSymbols(db)).toEqual(["ZZA", "ZZC"]);
      expect(coveredForEvents(db, [{ symbol: "ZZA", eventId: 1 }]).has(1)).toBe(true);
      expect(coveredForEvents(db, [{ symbol: "ZZB", eventId: 2 }]).has(2)).toBe(false);
    }
  });

  it("a dashed-form option behaves as before at 09:30 and at 21:00 Eastern", () => {
    heldOption("ZZA", TODAY);
    heldOption("ZZB", addDays(TODAY, -1));
    heldOption("ZZC", addDays(TODAY, 30));
    heldOption("ZZD", addDays(TODAY, -5));
    heldOption("ZZE", null); // unknown expiration: kept, never read as expired
    for (const at of [MORNING_ET, EVENING_ET]) {
      freeze(at);
      expect(held(["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"])).toEqual({
        ZZA: true,
        ZZB: false,
        ZZC: true,
        ZZD: false,
        ZZE: true,
      });
      expect(getHeldOptionUnderlyingSymbols(db)).toEqual(["ZZA", "ZZC", "ZZE"]);
    }
  });

  it("a stock position still covers the name when its legacy option has expired", () => {
    heldOption("ZZA", compact(addDays(TODAY, -5)));
    seedHolding(seedStock("ZZA"));
    expect(held(["ZZA"])).toEqual({ ZZA: true });
  });

  it("getSymbolStatusDetailed uses the caller's day for the option check too", () => {
    heldOption("ZZA", addDays(TODAY, -3));
    heldOption("ZZB", compact(addDays(TODAY, -3)));
    // Asked as of the expiration day, both are live; as of the day after, neither.
    expect(held(["ZZA", "ZZB"], { today: addDays(TODAY, -3) })).toEqual({ ZZA: true, ZZB: true });
    expect(held(["ZZA", "ZZB"], { today: addDays(TODAY, -2) })).toEqual({ ZZA: false, ZZB: false });
    expect(held(["ZZA", "ZZB"])).toEqual({ ZZA: false, ZZB: false });
    // A day in the future expires an option that is live today.
    heldOption("ZZC", addDays(TODAY, 2));
    expect(held(["ZZC"])).toEqual({ ZZC: true });
    expect(held(["ZZC"], { today: addDays(TODAY, 3) })).toEqual({ ZZC: false });
  });
});

describe("the other readers of a held option's underlying", () => {
  it("factor classification creates no underlying for an expired compact-form option", async () => {
    heldOption("ZZA", compact(addDays(TODAY, -5)));
    heldOption("ZZB", compact(TODAY));
    heldOption("ZZC", addDays(TODAY, -5));
    heldOption("ZZD", TODAY);
    await classifyFactors(db).catch(() => undefined);
    const underlyings = db
      .prepare("SELECT symbol FROM securities WHERE source_key LIKE 'underlying:%' ORDER BY symbol")
      .all() as Array<{ symbol: string }>;
    expect(underlyings.map((r) => r.symbol)).toEqual(["ZZB", "ZZD"]);
  });

  it("the ETF-type sweep ignores a stock reached only through an expired compact-form option", () => {
    for (const s of ["ZZA", "ZZB", "ZZC", "ZZD"]) seedStock(s);
    heldOption("ZZA", compact(addDays(TODAY, -5)));
    heldOption("ZZB", compact(TODAY));
    heldOption("ZZC", addDays(TODAY, -5));
    heldOption("ZZD", TODAY);
    for (const at of [MORNING_ET, EVENING_ET]) {
      freeze(at);
      expect(getStockTypedSweepCandidates(db).map((r) => r.symbol)).toEqual(["ZZB", "ZZD"]);
    }
  });
});

describe("the purge deletes a compact-form option on the dashed schedule", () => {
  function left(): string[] {
    return (
      db
        .prepare(
          `SELECT s.underlying_symbol AS u FROM holdings h JOIN securities s ON s.id = h.security_id
            ORDER BY u, h.account_id`,
        )
        .all() as Array<{ u: string }>
    ).map((r) => r.u);
  }

  function seedBook(o: { accountId?: number; sourceKey?: (u: string) => string | null } = {}) {
    const book: Array<[string, string]> = [
      ["ZZA", compact(addDays(TODAY, -2))], // compact, past the grace day: deleted
      ["ZZB", compact(addDays(TODAY, -1))], // compact, expired yesterday: kept
      ["ZZC", compact(TODAY)], // compact, expiring today: kept
      ["ZZD", addDays(TODAY, -2)], // dashed twin of ZZA: deleted
      ["ZZE", addDays(TODAY, -1)], // dashed twin of ZZB: kept
      ["ZZF", TODAY], // dashed twin of ZZC: kept
    ];
    for (const [u, exp] of book) {
      seedHolding(seedOption(u, exp), {
        accountId: o.accountId,
        sourceKey: o.sourceKey?.(u) ?? null,
      });
    }
  }

  it("whole-book form, at 09:30 and at 21:00 Eastern", () => {
    for (const at of [MORNING_ET, EVENING_ET]) {
      freeze(at);
      db.exec("DELETE FROM holdings; DELETE FROM securities;");
      seedBook();
      expect(purgeExpiredOptionHoldings(db)).toBe(2);
      expect(left()).toEqual(["ZZB", "ZZC", "ZZE", "ZZF"]);
      expect(purgeExpiredOptionHoldings(db)).toBe(0);
    }
  });

  it("scoped form: account scoping and the default Eastern day", () => {
    seedBook({ accountId: ACCT });
    seedBook({ accountId: IBKR });
    expect(purgeExpiredOptionHoldings(db, 1, { accountId: ACCT })).toBe(2);
    expect(left()).toEqual(["ZZA", "ZZB", "ZZB", "ZZC", "ZZC", "ZZD", "ZZE", "ZZE", "ZZF", "ZZF"]);
    // An explicit day moves the schedule for both spellings alike.
    expect(
      purgeExpiredOptionHoldings(db, 1, { accountId: IBKR, today: addDays(TODAY, 1) }),
    ).toBe(4);
    expect(left()).toEqual(["ZZB", "ZZC", "ZZC", "ZZE", "ZZF", "ZZF"]);
  });

  it("liveOnly: a statement row is preserved in either spelling", () => {
    const live = seedOption("ZZA", compact(addDays(TODAY, -2)));
    const stmt = seedOption("ZZB", compact(addDays(TODAY, -2)));
    const liveDashed = seedOption("ZZD", addDays(TODAY, -2));
    const stmtDashed = seedOption("ZZE", addDays(TODAY, -2));
    seedHolding(live, { sourceKey: `plaid:1:${live}:2026-06-09` });
    seedHolding(stmt, { sourceKey: `vanguard-pdf:holding:1:${stmt}:2026-05-31` });
    seedHolding(liveDashed, { sourceKey: `plaid:1:${liveDashed}:2026-06-09` });
    seedHolding(stmtDashed, { sourceKey: `vanguard-pdf:holding:1:${stmtDashed}:2026-05-31` });
    expect(purgeExpiredOptionHoldings(db, 1, { accountId: ACCT, liveOnly: true })).toBe(2);
    expect(left()).toEqual(["ZZB", "ZZE"]);
  });

  it("an unreadable expiration is never purged, a non-option never", () => {
    seedHolding(seedOption("ZZA", "sometime"));
    seedHolding(seedOption("ZZB", null));
    const bond = db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, expiration_date) VALUES ('ZZBOND', 'b', 'Bond', ?)`,
      )
      .run(compact(addDays(TODAY, -30))).lastInsertRowid as number;
    seedHolding(bond);
    expect(purgeExpiredOptionHoldings(db)).toBe(0);
    expect(purgeExpiredOptionHoldings(db, 1, { accountId: ACCT })).toBe(0);
  });
});
