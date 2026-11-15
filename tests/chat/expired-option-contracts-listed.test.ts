/**
 * QA finding (chat rail, options question): the chat option tools returned
 * only a COUNT of expired contracts left out, so "did any of my options
 * expire yesterday?" could not be answered by name.
 *
 * Protects: query_options_book and query_options_greeks now list each expired
 * contract they leave out (symbol, underlying, account, dashed expiry, side),
 * with no value, gain, cost or quantity, inside exactly the tool's scope.
 * Bound: the count each tool reports equals `expired_contracts.total`, and
 * the listed rows equal the total when it is under the cap.
 *
 * Synthetic tickers and round invented figures only; every date is relative
 * to the Eastern "today".
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";
import { queryOptionsBookTool } from "@/lib/chat/composite/options-book";
import { EXPIRED_CONTRACTS_LIST_MAX, EXPIRED_CONTRACTS_NOTE } from "@/lib/chat/expired-option-contracts";
import { addDays, todayET } from "@/lib/calendar/date-utils";

const TODAY = todayET();
let db: Database.Database;
let n = 0;
let taxable = 0;
let ibkr = 0;

function accountId(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

/** An option holding; `storedExpiry` overrides the dashed expiry (legacy compact form). */
function option(
  underlying: string,
  type: "C" | "P",
  strike: number,
  daysOut: number,
  account: number,
  qty: number,
  storedExpiry?: string,
): string {
  const exp = addDays(TODAY, daysOut);
  const symbol = `${underlying} ${exp.replace(/-/g, "").slice(2)}${type}${String(strike * 1000).padStart(8, "0")}`;
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, currency, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, 'Option', 'USD', ?, ?, ?, ?, 100)`,
    )
    .run(symbol, symbol, underlying, type === "C" ? "CALL" : "PUT", strike, storedExpiry ?? exp).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, 100, ?, ?)",
  ).run(account, id, qty, TODAY, `h-${++n}`);
  db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price) VALUES (?, ?, 1)").run(id, TODAY);
  return symbol;
}

type Expired = {
  total: number;
  truncated: boolean;
  contracts: Record<string, unknown>[];
  note: string;
};
type BookOut = { error?: string; excluded: { expired_option_positions: number; expired_contracts: Expired } };
type GreeksOut = { error?: string; data: { portfolio: { expiredPositions: number }; expired_contracts: Expired } };

const VALUE_KEYS = ["market_value", "value", "current_value", "cost_basis", "unrealized_gain", "gain", "quantity", "price"];

let longExpired = "";
let shortExpired = "";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  n = 0;
  taxable = accountId("Vanguard Taxable");
  ibkr = accountId("IBKR");
  // A long call that expired yesterday in IBKR, a short put that expired
  // three days ago in the taxable account, and a live call in IBKR.
  longExpired = option("AAA", "C", 50, -1, ibkr, 2);
  shortExpired = option("ZZZ", "P", 40, -3, taxable, -1);
  option("AAA", "C", 60, 20, ibkr, 1);
});

describe("query_options_book lists the expired contracts it leaves out", () => {
  it("names both expired contracts with account, dashed expiry and side, and no value fields", () => {
    const out = queryOptionsBookTool.run(db, {}, { accountIds: undefined, today: TODAY }) as BookOut;
    const list = out.excluded.expired_contracts;
    expect(out.excluded.expired_option_positions).toBe(2);
    expect(list.total).toBe(2);
    expect(list.contracts).toHaveLength(2);
    expect(list.truncated).toBe(false);
    expect(list.note).toBe(EXPIRED_CONTRACTS_NOTE);
    // Most recently expired first.
    expect(list.contracts).toEqual([
      { symbol: longExpired, underlying: "AAA", account: "IBKR", expiration: addDays(TODAY, -1), side: "long" },
      { symbol: shortExpired, underlying: "ZZZ", account: "Vanguard Taxable", expiration: addDays(TODAY, -3), side: "short" },
    ]);
    for (const c of list.contracts) for (const k of VALUE_KEYS) expect(c).not.toHaveProperty(k);
  });

  it("lists a legacy compact YYYYMMDD expiry with a dashed date", () => {
    const exp = addDays(TODAY, -5);
    const sym = option("CCC", "C", 30, -5, ibkr, 1, exp.replace(/-/g, ""));
    const out = queryOptionsBookTool.run(db, {}, { accountIds: [ibkr], today: TODAY }) as BookOut;
    const row = out.excluded.expired_contracts.contracts.find((c) => c.symbol === sym);
    expect(row).toMatchObject({ expiration: exp, side: "long", account: "IBKR" });
    expect(out.excluded.expired_option_positions).toBe(out.excluded.expired_contracts.total);
  });

  it("never lists a live contract, and a scoped call lists only that scope's contract", () => {
    const out = queryOptionsBookTool.run(db, {}, { accountIds: [taxable], today: TODAY }) as BookOut;
    expect(out.excluded.expired_contracts.contracts.map((c) => c.symbol)).toEqual([shortExpired]);
    expect(out.excluded.expired_option_positions).toBe(1);
    expect(JSON.stringify(out)).not.toContain("IBKR");
    const ib = queryOptionsBookTool.run(db, {}, { accountIds: [ibkr], today: TODAY }) as BookOut;
    expect(ib.excluded.expired_contracts.contracts.map((c) => c.symbol)).toEqual([longExpired]);
  });

  it("an empty account list lists nothing", () => {
    const out = queryOptionsBookTool.run(db, {}, { accountIds: [], today: TODAY });
    expect(out).toEqual({ error: "No account is in this chat's scope." });
  });

  it("caps the list, most recent first, and keeps the full count in total", () => {
    for (let i = 0; i < EXPIRED_CONTRACTS_LIST_MAX + 5; i++) option(`U${i}`, "P", 10 + i, -10 - i, ibkr, 1);
    const out = queryOptionsBookTool.run(db, {}, { accountIds: undefined, today: TODAY }) as BookOut;
    const list = out.excluded.expired_contracts;
    expect(list.total).toBe(EXPIRED_CONTRACTS_LIST_MAX + 7);
    expect(out.excluded.expired_option_positions).toBe(list.total);
    expect(list.contracts).toHaveLength(EXPIRED_CONTRACTS_LIST_MAX);
    expect(list.truncated).toBe(true);
    expect(list.contracts[0].symbol).toBe(longExpired);
  });
});

describe("query_options_greeks lists the expired contracts it leaves out", () => {
  it("names both expired contracts and the list agrees with expiredPositions", async () => {
    const out = (await executeTool(db, "query_options_greeks", {})) as GreeksOut;
    expect(out.error).toBeUndefined();
    const list = out.data.expired_contracts;
    expect(out.data.portfolio.expiredPositions).toBe(2);
    expect(list.total).toBe(2);
    expect(list.contracts).toEqual([
      { symbol: longExpired, underlying: "AAA", account: "IBKR", expiration: addDays(TODAY, -1), side: "long" },
      { symbol: shortExpired, underlying: "ZZZ", account: "Vanguard Taxable", expiration: addDays(TODAY, -3), side: "short" },
    ]);
    expect(list.note).toBe(EXPIRED_CONTRACTS_NOTE);
    for (const c of list.contracts) for (const k of VALUE_KEYS) expect(c).not.toHaveProperty(k);
  });

  it("a scoped call lists only that scope's contract; a legacy expiry is dashed", async () => {
    const exp = addDays(TODAY, -5);
    const legacy = option("CCC", "C", 30, -5, taxable, 1, exp.replace(/-/g, ""));
    const out = (await executeTool(db, "query_options_greeks", { account_name: "Vanguard Taxable" })) as GreeksOut;
    expect(out.data.expired_contracts.contracts.map((c) => [c.symbol, c.expiration])).toEqual([
      [shortExpired, addDays(TODAY, -3)],
      [legacy, exp],
    ]);
    expect(out.data.portfolio.expiredPositions).toBe(out.data.expired_contracts.total);
    expect(JSON.stringify(out.data.expired_contracts)).not.toContain("IBKR");
  });

  it("an empty chat scope reads nothing", async () => {
    const out = await executeTool(db, "query_options_greeks", {}, { scopeAccountIds: [] });
    expect(out).toEqual({ error: "No account is in this chat's scope." });
  });
});
