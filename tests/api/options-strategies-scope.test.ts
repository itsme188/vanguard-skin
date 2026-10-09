/**
 * /api/compute/options-strategies covers the WHOLE named scope, and the
 * per-account leg grouping lives in ONE helper.
 *
 * Defect: the route resolved a scope to its first account
 * (resolveScopeToSingleId), so a scope of two accounts showed only the first
 * account's strategies. Strategy detection is account-local: a stock in one
 * account never covers a call written in another, whatever the scope.
 *
 * Every ticker, quantity and price is invented. Expirations are far in the
 * future so the fixture never expires against the wall clock.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/compute/options-strategies/route";
import {
  detectStrategiesPerAccount,
  getOptionPositions,
  getStockLegsForStrategyDetection,
  type OptionPosition,
  type StockLegRow,
} from "@/lib/queries/options";
import {
  detectStrategies,
  type DetectedStrategy,
  type PositionLeg,
} from "@/lib/compute/options-strategy";

// Migration 002 seeds Vanguard Taxable (1), Vanguard Roth IRA (2), IBKR (3).
const ROTH = 2;
const IBKR = 3;
const EXP = "2099-01-15";
const AS_OF = "2026-01-30";

let db: Database.Database;
let ibkrTwo: number;

function seedStock(id: number, symbol: string, price: number): void {
  db.prepare(
    "INSERT INTO securities (id, symbol, security_type, currency) VALUES (?, ?, 'stock', 'USD')",
  ).run(id, symbol);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(id, AS_OF, price);
}

function seedOption(
  id: number,
  underlying: string,
  type: "CALL" | "PUT",
  strike: number,
  price: number,
): void {
  db.prepare(
    `INSERT INTO securities
       (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier, currency)
     VALUES (?, ?, 'option', ?, ?, ?, ?, 100, 'USD')`,
  ).run(id, `${underlying} ${type[0]}${strike}`, type, strike, EXP, underlying);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(id, AS_OF, price);
}

function hold(accountId: number, securityId: number, quantity: number): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, 1000, ?, ?)`,
  ).run(accountId, securityId, quantity, AS_OF, `test:${accountId}:${securityId}`);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  holder.db = db;
  // A second account whose name puts it in the "ibkr" scope.
  ibkrTwo = db.prepare("INSERT INTO accounts (name) VALUES ('IBKR Two')").run()
    .lastInsertRowid as number;

  seedStock(10, "ZZA", 50);
  seedStock(11, "ZZB", 80);
  seedOption(100, "ZZA", "CALL", 55, 2);
  seedOption(101, "ZZA", "PUT", 45, 1);
  seedOption(102, "ZZB", "CALL", 90, 3);

  // IBKR: 100 ZZA shares and a long ZZA put (a protective put), nothing else.
  hold(IBKR, 10, 100);
  hold(IBKR, 101, 1);
  // IBKR Two: a short ZZA call with NO ZZA shares in this account (naked),
  // and 100 ZZB shares with a short ZZB call (a covered call).
  hold(ibkrTwo, 100, -1);
  hold(ibkrTwo, 11, 100);
  hold(ibkrTwo, 102, -1);
  // Roth: its own covered call on ZZB.
  hold(ROTH, 11, 100);
  hold(ROTH, 102, -1);
});

async function get(query: string): Promise<DetectedStrategy[]> {
  const res = await GET(new NextRequest(`http://localhost/api/compute/options-strategies${query}`));
  const body = (await res.json()) as { success: boolean; data: DetectedStrategy[] };
  expect(body.success).toBe(true);
  return body.data;
}

/** The grouping exactly as both callers wrote it inline before the move. */
function inlineReference(
  stockHoldings: StockLegRow[],
  optionPositions: OptionPosition[],
): DetectedStrategy[] {
  const legsByAccount = new Map<number, PositionLeg[]>();
  const pushLeg = (acct: number, leg: PositionLeg) => {
    const legs = legsByAccount.get(acct);
    if (legs) legs.push(leg);
    else legsByAccount.set(acct, [leg]);
  };
  for (const s of stockHoldings) {
    pushLeg(s.account_id, {
      symbol: s.symbol,
      underlying: s.symbol,
      securityType: "stock" as const,
      quantity: s.quantity,
      multiplier: 1,
      currentPrice: s.current_price,
    });
  }
  for (const o of optionPositions) {
    pushLeg(o.accountId, {
      symbol: o.symbol,
      underlying: o.underlying,
      securityType: "option" as const,
      optionType: o.optionType,
      strike: o.strike,
      expiration: o.expiration,
      quantity: o.quantity,
      multiplier: o.multiplier,
      currentPrice: o.currentPrice,
    });
  }
  return Array.from(legsByAccount.values()).flatMap((legs) => detectStrategies(legs));
}

describe("detectStrategiesPerAccount: the one per-account grouping", () => {
  it("is byte-identical to the former inline grouping, whole book and each account", () => {
    for (const scope of [undefined, IBKR, ibkrTwo, ROTH]) {
      const stocks = getStockLegsForStrategyDetection(db, scope);
      const options = getOptionPositions(db, scope);
      const moved = detectStrategiesPerAccount(stocks, options);
      expect(JSON.stringify(moved)).toBe(JSON.stringify(inlineReference(stocks, options)));
    }
    // The whole book is not vacuous: four structures across three accounts.
    const all = detectStrategiesPerAccount(
      getStockLegsForStrategyDetection(db),
      getOptionPositions(db),
    );
    expect(all.map((s) => s.type).sort()).toEqual([
      "covered_call",
      "covered_call",
      "naked_call",
      "protective_put",
    ]);
  });

  it("never pairs legs across accounts: shares in one account do not cover a call in another", () => {
    const all = detectStrategiesPerAccount(
      getStockLegsForStrategyDetection(db),
      getOptionPositions(db),
    );
    const zza = all.filter((s) => s.underlying === "ZZA");
    expect(zza.map((s) => s.type).sort()).toEqual(["naked_call", "protective_put"]);
    expect(zza.some((s) => s.type === "covered_call")).toBe(false);
    // Pooled into one bag, the same legs WOULD read as a covered position:
    // this is the mistake the grouping exists to prevent.
    const pooled = detectStrategies(
      [
        { symbol: "ZZA", underlying: "ZZA", securityType: "stock", quantity: 100, multiplier: 1, currentPrice: 50 },
        { symbol: "ZZA C55", underlying: "ZZA", securityType: "option", optionType: "CALL", strike: 55, expiration: EXP, quantity: -1, multiplier: 100, currentPrice: 2 },
      ],
    );
    expect(pooled.map((s) => s.type)).toEqual(["covered_call"]);
  });

  it("both callers use the helper and neither keeps its own copy", () => {
    const route = readFileSync("app/api/compute/options-strategies/route.ts", "utf8");
    const chat = readFileSync("lib/chat/tools.ts", "utf8");
    for (const src of [route, chat]) {
      expect(src).toContain("detectStrategiesPerAccount(");
      expect(src).not.toContain("legsByAccount");
    }
  });
});

describe("GET /api/compute/options-strategies: the whole scope", () => {
  it("a two-account scope returns both accounts' strategies, each detected in its own account", async () => {
    const data = await get("?scope=ibkr");
    expect(data.map((s) => `${s.underlying}:${s.type}`).sort()).toEqual([
      "ZZA:naked_call",
      "ZZA:protective_put",
      "ZZB:covered_call",
    ]);
  });

  it("a two-account scope is the two one-account answers, concatenated", async () => {
    const both = await get("?scope=ibkr");
    const first = await get(`?accountId=${IBKR}`);
    const second = await get(`?accountId=${ibkrTwo}`);
    expect(both).toEqual([...first, ...second]);
  });

  it("a one-account scope returns exactly what the explicit account returns", async () => {
    const scoped = await get("?scope=roth");
    const explicit = await get(`?accountId=${ROTH}`);
    expect(scoped.map((s) => s.type)).toEqual(["covered_call"]);
    expect(JSON.stringify(scoped)).toBe(JSON.stringify(explicit));
    // And exactly what the single-id read produced before the scope change.
    expect(JSON.stringify(scoped)).toBe(
      JSON.stringify(
        inlineReference(getStockLegsForStrategyDetection(db, ROTH), getOptionPositions(db, ROTH)),
      ),
    );
  });

  it("no scope and scope=all are the whole book", async () => {
    const none = await get("");
    const all = await get("?scope=all");
    expect(none).toHaveLength(4);
    expect(all).toEqual(none);
  });

  it("the route no longer collapses a scope to one account", () => {
    const route = readFileSync("app/api/compute/options-strategies/route.ts", "utf8");
    expect(route).not.toContain("resolveScopeToSingleId");
  });
});

describe("option and stock leg reads accept a list of accounts", () => {
  it("a list of two reads both accounts; a list of one equals the single id", () => {
    expect(getOptionPositions(db, [IBKR, ibkrTwo]).map((p) => p.accountId).sort()).toEqual(
      [IBKR, ibkrTwo, ibkrTwo].sort(),
    );
    expect(getOptionPositions(db, [ROTH])).toEqual(getOptionPositions(db, ROTH));
    expect(getStockLegsForStrategyDetection(db, [IBKR, ibkrTwo])).toHaveLength(2);
    expect(getStockLegsForStrategyDetection(db, [ROTH])).toEqual(
      getStockLegsForStrategyDetection(db, ROTH),
    );
  });

  it("an empty list is no accounts, never the whole book", () => {
    expect(getOptionPositions(db, [])).toEqual([]);
    expect(getStockLegsForStrategyDetection(db, [])).toEqual([]);
  });
});
