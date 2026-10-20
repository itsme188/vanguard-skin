// A symbol-filtered query_holdings that finds no live row must not answer
// with a bare empty list when the pair's newest holdings row is a live-origin
// zero (a `:live` reconciler tombstone): the position was closed per live
// broker data and awaits the statement. query_transactions must say where
// the ledger ends, so the model never reads "no rows after X" as "flat
// since X". Synthetic symbol and round invented figures only.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS } from "@/lib/chat/tools";
import {
  getClosedPerLiveDataForChat,
  getLedgerEndByAccountForChat,
  getLedgerLastDateForChat,
  PENDING_STATEMENT_CHAT_NOTE,
} from "@/lib/queries/chat-tools";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function accountId(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedStock(symbol: string): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, currency, multiplier)
       VALUES (?, ?, 'stock', 'equity', 'USD', 1)`,
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedHolding(acct: number, sec: number, qty: number, date: string, key: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(acct, sec, qty, date, key);
}

function seedTxn(acct: number, sec: number, date: string, type: string, qty: number, key: string): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, fees, source_key)
     VALUES (?, ?, ?, ?, ?, ?, 100, 0, ?)`,
  ).run(acct, sec, date, type, qty, qty * 100, key);
}

/** Two accounts: IBKR shows a live position then a live tombstone; the other account holds nothing in ZZZ. */
function seedScenario(): { ibkr: number; other: number; zzz: number } {
  const ibkr = accountId("IBKR");
  const other = accountId("Other Acct");
  const zzz = seedStock("ZZZ");
  // Statement month: bought 200, sold 100.
  seedTxn(ibkr, zzz, "2026-08-05", "BUY", 200, "t1");
  seedTxn(ibkr, zzz, "2026-08-20", "SELL", -100, "t2");
  seedHolding(ibkr, zzz, 100, "2026-08-31", "ibkr:pos:ZZZ:2026-08-31");
  // Live data: still 100 into late September, then closed per live data.
  seedHolding(ibkr, zzz, 100, "2026-09-25", "tws-ZZZ-2026-09-25");
  seedHolding(ibkr, zzz, 0, "2026-09-30", `recon:closed-equity:${ibkr}:${zzz}:2026-09-30:live`);
  return { ibkr, other, zzz };
}

describe("getClosedPerLiveDataForChat", () => {
  it("returns the pair's last non-zero row, flagged pending statement", () => {
    seedScenario();
    const rows = getClosedPerLiveDataForChat(db, { symbol: "ZZZ" });
    expect(rows).toEqual([
      {
        account_name: "IBKR",
        symbol: "ZZZ",
        as_of_date: "2026-09-25",
        quantity: 100,
        closed_as_of_date: "2026-09-30",
        account_ledger_last_date: "2026-08-20",
        pending_statement: true,
        status_note: PENDING_STATEMENT_CHAT_NOTE,
      },
    ]);
  });

  it("respects the account filter", () => {
    seedScenario();
    expect(getClosedPerLiveDataForChat(db, { symbol: "ZZZ", account_name: "Other Acct" })).toEqual([]);
    expect(getClosedPerLiveDataForChat(db, { symbol: "ZZZ", account_name: "IBKR" })).toHaveLength(1);
    expect(getClosedPerLiveDataForChat(db, { symbol: "ZZZ", account_name: "No Such" })).toEqual([]);
  });

  it("does not report a pair closed by a statement-grade zero", () => {
    const { ibkr, zzz } = seedScenario();
    seedHolding(ibkr, zzz, 0, "2026-10-31", `recon:closed-equity:${ibkr}:${zzz}:2026-10-31:stmt`);
    expect(getClosedPerLiveDataForChat(db, { symbol: "ZZZ" })).toEqual([]);
  });

  it("does not report a pair whose newest row is non-zero", () => {
    const { ibkr, zzz } = seedScenario();
    seedHolding(ibkr, zzz, 100, "2026-10-02", "tws-ZZZ-2026-10-02");
    expect(getClosedPerLiveDataForChat(db, { symbol: "ZZZ" })).toEqual([]);
  });

  it("reports one row per account when two accounts were closed per live data", () => {
    const { other, zzz } = seedScenario();
    seedHolding(other, zzz, 100, "2026-09-10", "tws-ZZZ-other-2026-09-10");
    seedHolding(other, zzz, 0, "2026-09-12", `recon:closed-equity:${other}:${zzz}:2026-09-12:live`);
    const rows = getClosedPerLiveDataForChat(db, { symbol: "ZZZ" });
    expect(rows.map((r) => [r.account_name, r.as_of_date, r.quantity])).toEqual([
      ["IBKR", "2026-09-25", 100],
      ["Other Acct", "2026-09-10", 100],
    ]);
  });
});

describe("query_holdings tool", () => {
  it("a symbol with no live row comes back under closed_per_live_data, holdings empty", async () => {
    seedScenario();
    const result = (await executeTool(db, "query_holdings", { symbol: "ZZZ" })) as {
      error?: string;
      data: { holdings: unknown[]; closed_per_live_data: Array<Record<string, unknown>> };
    };
    expect(result.error).toBeUndefined();
    expect(result.data.holdings).toEqual([]);
    expect(result.data.closed_per_live_data).toHaveLength(1);
    expect(result.data.closed_per_live_data[0]).toMatchObject({
      account_name: "IBKR",
      as_of_date: "2026-09-25",
      quantity: 100,
      pending_statement: true,
    });
  });

  it("stays a plain array when the symbol has a live row or nothing at all", async () => {
    seedScenario();
    const none = (await executeTool(db, "query_holdings", { symbol: "NOPE" })) as { data: unknown };
    expect(none.data).toEqual([]);
    const all = (await executeTool(db, "query_holdings", {})) as { data: unknown };
    expect(Array.isArray(all.data)).toBe(true);
  });

  it("the description explains the closed_per_live_data field", () => {
    const tool = CHAT_TOOLS.find((t) => t.name === "query_holdings")!;
    expect(tool.description).toContain("closed_per_live_data");
    expect(tool.description).toMatch(/awaiting the broker statement/);
  });
});

describe("held in one account, closed per live data in another", () => {
  it("query_holdings returns the held row AND the closure", async () => {
    const { other, zzz } = seedScenario();
    seedHolding(other, zzz, 50, "2026-10-02", "tws-ZZZ-other-2026-10-02");
    const result = (await executeTool(db, "query_holdings", { symbol: "ZZZ" })) as {
      error?: string;
      data: {
        holdings: Array<{ account_name: string; quantity: number }>;
        closed_per_live_data: Array<Record<string, unknown>>;
      };
      warnings?: string[];
    };
    expect(result.error).toBeUndefined();
    expect(result.data.holdings.map((h) => [h.account_name, h.quantity])).toEqual([["Other Acct", 50]]);
    expect(result.data.closed_per_live_data).toHaveLength(1);
    expect(result.data.closed_per_live_data[0]).toMatchObject({
      account_name: "IBKR",
      as_of_date: "2026-09-25",
      closed_as_of_date: "2026-09-30",
      pending_statement: true,
    });
    // The held rows are still annotated (the cash-estimate note is always added for holdings).
    expect(JSON.stringify(result)).toMatch(/Cash balances are estimated/);
  });

  it("scoped to the holding account, no closure is reported", async () => {
    const { other, zzz } = seedScenario();
    seedHolding(other, zzz, 50, "2026-10-02", "tws-ZZZ-other-2026-10-02");
    const result = (await executeTool(db, "query_holdings", { symbol: "ZZZ", account_name: "Other Acct" })) as {
      data: unknown;
    };
    expect(Array.isArray(result.data)).toBe(true);
  });
});

describe("where the ledger ends", () => {
  /** IBKR's ledger runs past ZZZ's last trade: another symbol trades later. */
  function seedLaterIbkrTrade(ibkr: number): void {
    const bbb = seedStock("BBB");
    seedTxn(ibkr, bbb, "2026-09-28", "BUY", 10, "t-bbb");
  }

  it("is per account and ignores the symbol; the symbol's last trade is a separate date", () => {
    const { ibkr, other } = seedScenario();
    seedLaterIbkrTrade(ibkr);
    const aaa = seedStock("AAA");
    seedTxn(other, aaa, "2026-10-01", "BUY", 100, "t3");

    expect(getLedgerLastDateForChat(db, { symbol: "ZZZ" })).toBe("2026-08-20");
    expect(getLedgerEndByAccountForChat(db, { symbol: "ZZZ" })).toEqual([
      { account_name: "IBKR", ledger_last_date: "2026-09-28" },
    ]);
    expect(getLedgerEndByAccountForChat(db, {})).toEqual([
      { account_name: "IBKR", ledger_last_date: "2026-09-28" },
      { account_name: "Other Acct", ledger_last_date: "2026-10-01" },
    ]);
    expect(getLedgerEndByAccountForChat(db, { accountIds: [other] })).toEqual([
      { account_name: "Other Acct", ledger_last_date: "2026-10-01" },
    ]);
    // A defined empty list is no accounts.
    expect(getLedgerEndByAccountForChat(db, { accountIds: [] })).toEqual([]);
    expect(getLedgerEndByAccountForChat(db, { symbol: "ZZZ", accountIds: [other] })).toEqual([]);
  });

  it("an account that only holds the symbol (no trade in it) is still listed", () => {
    const { ibkr, other, zzz } = seedScenario();
    seedLaterIbkrTrade(ibkr);
    seedHolding(other, zzz, 50, "2026-10-02", "tws-ZZZ-other-2026-10-02");
    expect(getLedgerEndByAccountForChat(db, { symbol: "ZZZ" })).toEqual([
      { account_name: "IBKR", ledger_last_date: "2026-09-28" },
      { account_name: "Other Acct", ledger_last_date: null },
    ]);
  });

  it("the closed-per-live-data row carries the account's ledger end, not the symbol's last trade", () => {
    const { ibkr } = seedScenario();
    seedLaterIbkrTrade(ibkr);
    const [row] = getClosedPerLiveDataForChat(db, { symbol: "ZZZ" });
    expect(row.account_ledger_last_date).toBe("2026-09-28");
  });

  it("query_transactions names the account ledger end and the symbol's last trade separately", async () => {
    const { ibkr } = seedScenario();
    seedLaterIbkrTrade(ibkr);
    const result = (await executeTool(db, "query_transactions", { symbol: "ZZZ" })) as {
      data: {
        transactions: Array<{ trade_date: string }>;
        ledger_end_by_account: Array<{ account_name: string; ledger_last_date: string | null }>;
        symbol_last_trade_date?: string | null;
        ledger_last_date?: unknown;
      };
    };
    expect(result.data.transactions.map((t) => t.trade_date)).toEqual(["2026-08-20", "2026-08-05"]);
    expect(result.data.ledger_end_by_account).toEqual([{ account_name: "IBKR", ledger_last_date: "2026-09-28" }]);
    expect(result.data.symbol_last_trade_date).toBe("2026-08-20");
    expect(result.data.ledger_last_date).toBeUndefined();
    const tool = CHAT_TOOLS.find((t) => t.name === "query_transactions")!;
    expect(tool.description).toContain("ledger_end_by_account");
    expect(tool.description).toContain("symbol_last_trade_date");
    expect(tool.description).toContain("query_holdings");
  });

  it("query_transactions without a symbol omits symbol_last_trade_date", async () => {
    seedScenario();
    const result = (await executeTool(db, "query_transactions", {})) as { data: Record<string, unknown> };
    expect("symbol_last_trade_date" in result.data).toBe(false);
    expect(result.data.ledger_end_by_account).toEqual([{ account_name: "IBKR", ledger_last_date: "2026-08-20" }]);
  });
});
