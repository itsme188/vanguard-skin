/**
 * query_holdings' "closed per live data" list over the side-aware pending
 * read model (plan docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 7, ruling R3). Both sources of `getClosedPerLiveDataForChat` (its own
 * live-zero seed and the pending index merge) drop a pair that any side
 * marks `closing_entry_missing` or `resymbol_repair_pending`, and a pair is
 * listed only when its newest holdings row is exactly zero.
 *
 * Each case states the pair's expected pending state by hand and checks the
 * read model agrees before checking the list. Synthetic symbols and small
 * round figures only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { executeTool } from "@/lib/chat/tools";
import { getClosedPerLiveDataForChat } from "@/lib/queries/chat-tools";
import { getPendingStatementPairs } from "@/lib/queries/pending-statement";
import { createPendingTestDb, seedHold, seedSec } from "../setup/pending-statement-fixtures";

// A synthetic re-symbol mapping replaces the real constant for this file.
const MAPPING = vi.hoisted(() => [
  {
    fromSymbol: "ZHRS  270115C00100000",
    toSymbol: "ZHRS  270115C00050000",
    tradeDate: "2026-05-01",
    type: "BUY_TO_OPEN",
    preQty: 1,
    ratio: 2,
  },
]);
vi.mock("@/lib/securities/option-resymbol-targets", () => ({
  OPTION_RESYMBOL_TARGETS: MAPPING,
  resymbolTargetsFrom: (fromSymbol: string) => MAPPING.filter((t) => t.fromSymbol === fromSymbol),
}));

const ACCT = 3; // "IBKR", seeded by the migrations
const OLD = "ZHRS  270115C00100000";
const NEW = "ZHRS  270115C00050000";

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createPendingTestDb();
});

function seedOpt(symbol: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date, currency)
         VALUES (?, ?, 'option', 100, '2027-01-15', 'USD')`
      )
      .run(symbol, `${symbol} contract`).lastInsertRowid
  );
}

function txn(sec: number, date: string, type: string, qty: number, price: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?)`
  ).run(ACCT, sec, date, type, qty, price, `hcr-${seq++}`);
}

function reasons(symbol: string): Array<[string, string]> {
  return getPendingStatementPairs(db)
    .filter((p) => p.symbol === symbol)
    .map((p) => [p.side, p.reason]);
}

describe("control", () => {
  it("a plain live zero is still listed", () => {
    const sec = seedSec(db, "ZHPL");
    txn(sec, "2026-08-05", "BUY", 10, 100);
    seedHold(db, ACCT, sec, "2026-08-31", "stmt", 10);
    seedHold(db, ACCT, sec, "2026-09-30", "live-zero");
    computeTaxLots(db);
    expect(reasons("ZHPL")).toEqual([["long", "awaiting_statement"]]); // hand
    expect(getClosedPerLiveDataForChat(db, { symbol: "ZHPL" })).toMatchObject([
      { account_name: "IBKR", as_of_date: "2026-08-31", quantity: 10, closed_as_of_date: "2026-09-30" },
    ]);
  });
});

describe("R3: re-symbolled option", () => {
  function seedResymbol(replacementQty: number): void {
    const old = seedOpt(OLD);
    const repl = seedOpt(NEW);
    txn(old, "2026-05-01", "BUY_TO_OPEN", 1, 6);
    seedHold(db, ACCT, old, "2026-07-01", "tws", 1);
    seedHold(db, ACCT, old, "2026-07-10", "live-zero");
    seedHold(db, ACCT, repl, "2026-07-10", "tws", replacementQty);
    computeTaxLots(db);
  }

  it("old symbol under a live zero, replacement held in the same account → not listed as closed", () => {
    seedResymbol(2);
    expect(reasons(OLD)).toEqual([["long", "resymbol_repair_pending"]]); // hand
    // The live-zero seed alone would have listed this pair.
    expect(getClosedPerLiveDataForChat(db, { symbol: OLD })).toEqual([]);
  });

  it("control: replacement not held → ordinary awaiting_statement, listed", () => {
    seedResymbol(0);
    expect(reasons(OLD)).toEqual([["long", "awaiting_statement"]]); // hand
    expect(getClosedPerLiveDataForChat(db, { symbol: OLD })).toMatchObject([
      { as_of_date: "2026-07-01", quantity: 1, closed_as_of_date: "2026-07-10" },
    ]);
  });
});

describe("R3: statement zero, then a newer live zero", () => {
  function seedShort(withStatementZero: boolean): void {
    const sec = seedSec(db, "ZHSZ");
    txn(sec, "2026-05-04", "SHORT_SELL", 10, 100);
    seedHold(db, ACCT, sec, "2026-05-31", "stmt", -10);
    if (withStatementZero) seedHold(db, ACCT, sec, "2026-06-30", "stmt-zero");
    seedHold(db, ACCT, sec, "2026-07-10", "live-zero");
    computeTaxLots(db);
  }

  it("short stock → closing_entry_missing → not listed", () => {
    seedShort(true);
    expect(reasons("ZHSZ")).toEqual([["short", "closing_entry_missing"]]); // hand
    // The live-zero seed alone would have listed this pair.
    expect(getClosedPerLiveDataForChat(db, { symbol: "ZHSZ" })).toEqual([]);
  });

  it("control: no statement zero → awaiting_statement, listed with its short quantity", () => {
    seedShort(false);
    expect(reasons("ZHSZ")).toEqual([["short", "awaiting_statement"]]); // hand
    expect(getClosedPerLiveDataForChat(db, { symbol: "ZHSZ" })).toMatchObject([
      { as_of_date: "2026-05-31", quantity: -10, closed_as_of_date: "2026-07-10" },
    ]);
  });
});

describe("R3: live-flipped pair", () => {
  it("a long lot under a live short row is not listed; the held short appears in the holdings rows", async () => {
    const sec = seedSec(db, "ZHFL");
    txn(sec, "2026-08-05", "BUY", 10, 100);
    seedHold(db, ACCT, sec, "2026-08-31", "stmt", 10);
    seedHold(db, ACCT, sec, "2026-09-30", "tws", -5);
    computeTaxLots(db);
    expect(reasons("ZHFL")).toEqual([["long", "awaiting_statement"]]); // hand (PR #123)
    expect(getClosedPerLiveDataForChat(db, { symbol: "ZHFL" })).toEqual([]);

    const result = (await executeTool(db, "query_holdings", { symbol: "ZHFL" })) as {
      error?: string;
      data: unknown;
    };
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.data)).toBe(true);
    const rows = result.data as Array<{ symbol: string; quantity: number; position_side: string }>;
    expect(rows.map((r) => [r.symbol, r.quantity, r.position_side])).toEqual([["ZHFL", -5, "short"]]);
  });
});
