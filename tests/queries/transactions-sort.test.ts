import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getAccountTransactionPage,
  getTransactionCount,
  getTransactionsByAccount,
  parseTransactionSort,
} from "@/lib/queries/transactions";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { displayCashEffect } from "@/lib/format/cash-effect";
import { anchorIndex } from "../helpers/source-anchor";

/**
 * QA (accounts-transactions--50-row-cap-sort-implies-full-history-
 * regression-1): the Accounts page fetched the newest 50 rows and sorted
 * them in the browser, so "Amount, largest first" answered with the largest
 * of the newest 50, not the account's largest. The sort now runs in SQL
 * before the cap, and the count uses the list's own predicate so the page
 * can say "showing 50 of N". All figures here are invented.
 */

const ACCOUNT_ID = 1;
const OTHER_ACCOUNT_ID = 2;

let seq = 0;
function seedSecurity(
  db: Database.Database,
  symbol: string,
  currency?: string,
): number {
  const id = db
    .prepare("INSERT INTO securities (symbol, name) VALUES (?, ?)")
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  if (currency) {
    db.prepare("UPDATE securities SET currency = ? WHERE id = ?").run(currency, id);
  }
  return id;
}

function seedTxn(
  db: Database.Database,
  opts: {
    accountId?: number;
    securityId?: number | null;
    type: string;
    amount: number | null;
    quantity?: number | null;
    tradeDate: string;
  },
): number {
  seq += 1;
  return db
    .prepare(
      `INSERT INTO transactions
         (account_id, security_id, trade_date, type, quantity, amount, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.accountId ?? ACCOUNT_ID,
      opts.securityId ?? null,
      opts.tradeDate,
      opts.type,
      opts.quantity ?? null,
      opts.amount,
      `test:sort:${seq}`,
    ).lastInsertRowid as number;
}

describe("getTransactionsByAccount sorts before the cap", () => {
  let db: Database.Database;
  let aaa: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    aaa = seedSecurity(db, "AAA");
  });

  it("Amount, largest first, finds a row older than the newest N", () => {
    // The largest row is the OLDEST one, outside a newest-3 window.
    const big = seedTxn(db, { type: "DEPOSIT", amount: 9000, tradeDate: "2024-01-02" });
    seedTxn(db, { securityId: aaa, type: "DIVIDEND", amount: 10, tradeDate: "2024-06-01" });
    seedTxn(db, { securityId: aaa, type: "DIVIDEND", amount: 20, tradeDate: "2024-06-02" });
    seedTxn(db, { securityId: aaa, type: "DIVIDEND", amount: 30, tradeDate: "2024-06-03" });

    const byDate = getTransactionsByAccount(db, ACCOUNT_ID, { limit: 3 });
    expect(byDate.map((r) => r.id)).not.toContain(big);

    const byAmount = getTransactionsByAccount(db, ACCOUNT_ID, {
      limit: 3,
      sort: { field: "amount", dir: "desc" },
    });
    expect(byAmount[0].id).toBe(big);
    expect(byAmount.map((r) => r.amount)).toEqual([9000, 30, 20]);
  });

  it("Date, oldest first, starts at the account's first row", () => {
    const first = seedTxn(db, { type: "DEPOSIT", amount: 100, tradeDate: "2020-01-02" });
    for (let d = 1; d <= 5; d++) {
      seedTxn(db, { type: "INTEREST", amount: 1, tradeDate: `2024-06-0${d}` });
    }
    const rows = getTransactionsByAccount(db, ACCOUNT_ID, {
      limit: 2,
      sort: { field: "trade_date", dir: "asc" },
    });
    expect(rows[0].id).toBe(first);
  });

  it("with no sort option keeps the newest-first default", () => {
    seedTxn(db, { type: "INTEREST", amount: 1, tradeDate: "2024-01-01" });
    seedTxn(db, { type: "INTEREST", amount: 1, tradeDate: "2024-03-01" });
    seedTxn(db, { type: "INTEREST", amount: 1, tradeDate: "2024-02-01" });
    expect(
      getTransactionsByAccount(db, ACCOUNT_ID).map((r) => r.trade_date),
    ).toEqual(["2024-03-01", "2024-02-01", "2024-01-01"]);
  });

  it("orders Amount by the figure the column prints (a buy is an outflow whatever sign was stored)", () => {
    const legacyBuy = seedTxn(db, { securityId: aaa, type: "BUY", amount: 500, quantity: 5, tradeDate: "2024-01-01" });
    const signedBuy = seedTxn(db, { securityId: aaa, type: "BUY", amount: -900, quantity: 9, tradeDate: "2024-01-02" });
    const sell = seedTxn(db, { securityId: aaa, type: "SELL", amount: 300, quantity: 3, tradeDate: "2024-01-03" });
    const rows = getTransactionsByAccount(db, ACCOUNT_ID, {
      sort: { field: "amount", dir: "asc" },
    });
    expect(rows.map((r) => r.id)).toEqual([signedBuy, legacyBuy, sell]);
  });

  it("the SQL amount order agrees with displayCashEffect for every type that function re-signs", () => {
    // Read the buy / sell families out of the display helper, so adding a
    // type there without the SQL twin fails here.
    const src = readFileSync(
      join(process.cwd(), "lib/format/cash-effect.ts"),
      "utf8",
    );
    const family = (name: string): string[] => {
      const start = anchorIndex(src, `const ${name} = new Set([`);
      const end = anchorIndex(src, "]);", start);
      return [...src.slice(start, end).matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    };
    const types = [
      ...family("BUY_FAMILY_TYPES"),
      ...family("SELL_FAMILY_TYPES"),
      "DIVIDEND",
      "TRANSFER",
      "REDEMPTION",
    ];
    expect(types.length).toBeGreaterThanOrEqual(10);

    // Each type twice, once stored positive and once negative, all distinct.
    const expected: { id: number; shown: number }[] = [];
    types.forEach((type, i) => {
      for (const sign of [1, -1]) {
        const amount = sign * (100 + i * 10 + (sign > 0 ? 0 : 5));
        const id = seedTxn(db, { securityId: aaa, type, amount, tradeDate: "2024-01-01" });
        expected.push({ id, shown: displayCashEffect(type, amount) as number });
      }
    });
    // Two rows may print the same figure; compare the printed figures.
    const rows = getTransactionsByAccount(db, ACCOUNT_ID, {
      sort: { field: "amount", dir: "desc" },
    });
    const shownById = new Map(expected.map((e) => [e.id, e.shown]));
    expect(rows.map((r) => shownById.get(r.id))).toEqual(
      expected.map((e) => e.shown).sort((a, b) => b - a),
    );
  });

  it("converts a foreign-currency amount before ordering it", () => {
    upsertFxRate(db, { currency: "JPY", usdPerUnit: 0.01, asOf: "2024-01-01", source: "test" });
    const jpy = seedSecurity(db, "ZZZ", "JPY");
    const yen = seedTxn(db, { securityId: jpy, type: "DIVIDEND", amount: 5000, tradeDate: "2024-01-01" });
    const usd = seedTxn(db, { securityId: aaa, type: "DIVIDEND", amount: 80, tradeDate: "2024-01-02" });
    const rows = getTransactionsByAccount(db, ACCOUNT_ID, {
      sort: { field: "amount", dir: "desc" },
    });
    // 5,000 yen is 50 dollars: it sorts BELOW the 80-dollar row.
    expect(rows.map((r) => r.id)).toEqual([usd, yen]);
    expect(rows[1].amount).toBeCloseTo(50);
  });

  it("puts missing values last in both directions", () => {
    const cash = seedTxn(db, { type: "DEPOSIT", amount: 100, quantity: null, tradeDate: "2024-01-01" });
    const b = seedTxn(db, { securityId: seedSecurity(db, "BBB"), type: "BUY", amount: -10, quantity: 2, tradeDate: "2024-01-02" });
    const a = seedTxn(db, { securityId: aaa, type: "BUY", amount: -10, quantity: 7, tradeDate: "2024-01-03" });
    for (const dir of ["asc", "desc"] as const) {
      const bySymbol = getTransactionsByAccount(db, ACCOUNT_ID, { sort: { field: "symbol", dir } });
      expect(bySymbol[bySymbol.length - 1].id).toBe(cash);
      const byQty = getTransactionsByAccount(db, ACCOUNT_ID, { sort: { field: "quantity", dir } });
      expect(byQty[byQty.length - 1].id).toBe(cash);
    }
    expect(
      getTransactionsByAccount(db, ACCOUNT_ID, { sort: { field: "symbol", dir: "asc" } }).map((r) => r.id),
    ).toEqual([a, b, cash]);
    expect(
      getTransactionsByAccount(db, ACCOUNT_ID, { sort: { field: "quantity", dir: "desc" } }).map((r) => r.id),
    ).toEqual([a, b, cash]);
  });

  it("never sorts an engine-owned RECONCILE_CLOSE row into the list, and stays inside the account", () => {
    seedTxn(db, { securityId: aaa, type: "RECONCILE_CLOSE", amount: 99999, quantity: 1, tradeDate: "2024-01-01" });
    seedTxn(db, { accountId: OTHER_ACCOUNT_ID, type: "DEPOSIT", amount: 88888, tradeDate: "2024-01-01" });
    const mine = seedTxn(db, { type: "DEPOSIT", amount: 5, tradeDate: "2024-01-01" });
    const rows = getTransactionsByAccount(db, ACCOUNT_ID, {
      sort: { field: "amount", dir: "desc" },
    });
    expect(rows.map((r) => r.id)).toEqual([mine]);
  });
});

describe("getTransactionCount matches the list", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("counts what the uncapped list returns: no RECONCILE_CLOSE, no other account", () => {
    const aaa = seedSecurity(db, "AAA");
    seedTxn(db, { securityId: aaa, type: "BUY", amount: -10, quantity: 1, tradeDate: "2024-01-01" });
    seedTxn(db, { securityId: aaa, type: "SELL", amount: 12, quantity: 1, tradeDate: "2024-01-02" });
    seedTxn(db, { securityId: aaa, type: "RECONCILE_CLOSE", amount: 1, quantity: 1, tradeDate: "2024-01-03" });
    seedTxn(db, { accountId: OTHER_ACCOUNT_ID, type: "DEPOSIT", amount: 1, tradeDate: "2024-01-01" });

    expect(getTransactionCount(db, ACCOUNT_ID)).toBe(2);
    expect(getTransactionCount(db, ACCOUNT_ID)).toBe(
      getTransactionsByAccount(db, ACCOUNT_ID).length,
    );
    expect(getTransactionCount(db, ACCOUNT_ID, { type: "BUY" })).toBe(
      getTransactionsByAccount(db, ACCOUNT_ID, { type: "BUY" }).length,
    );
  });

  it("getAccountTransactionPage returns the capped sorted rows, the full count and the parsed sort", () => {
    const big = seedTxn(db, { type: "DEPOSIT", amount: 7000, tradeDate: "2023-01-01" });
    for (let d = 1; d <= 4; d++) {
      seedTxn(db, { type: "INTEREST", amount: d, tradeDate: `2024-06-0${d}` });
    }
    const page = getAccountTransactionPage(db, ACCOUNT_ID, {
      sortParam: "amount",
      dirParam: "desc",
      limit: 2,
    });
    expect(page.total).toBe(5);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0].id).toBe(big);
    expect(page.sort).toEqual({ field: "amount", dir: "desc" });
  });
});

describe("parseTransactionSort", () => {
  it("accepts the five column fields", () => {
    for (const f of ["trade_date", "type", "symbol", "quantity", "amount"]) {
      expect(parseTransactionSort(f, "asc")).toEqual({ field: f, dir: "asc" });
    }
  });

  it("falls back to newest first for anything else (the value never reaches SQL)", () => {
    const fallback = { field: "trade_date", dir: "desc" };
    expect(parseTransactionSort(undefined, undefined)).toEqual(fallback);
    expect(parseTransactionSort("amount; DROP TABLE transactions", "sideways")).toEqual(fallback);
    expect(parseTransactionSort("toString", "desc")).toEqual(fallback);
    expect(parseTransactionSort("amount", "up")).toEqual({ field: "amount", dir: "desc" });
  });
});
