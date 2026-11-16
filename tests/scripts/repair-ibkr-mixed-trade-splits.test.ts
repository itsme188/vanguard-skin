/**
 * Synthetic figures only (the repo is public). The real rows live in the
 * gitignored data/repair-configs/ibkr-mixed-trade-splits.json.
 *
 * Shape: long 500; the statement lists SELL 500 (C;O) before SELL 100 (C),
 * then BUY 100 (C). The broker booked the SELL 100 first, so the SELL 500
 * closed 400 and opened a 100 short that the BUY 100 covered: flat.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { readIbkrTradeDirection } from "@/lib/import/ibkr-trade-direction";
import {
  backupPathFor,
  backupStamp,
  takeFreshBackup,
  parseRepairConfig,
  planMixedTradeSplits,
  runMixedTradeSplits,
  splitOpenSourceKey,
  type RepairConfig,
} from "@/scripts/repair-ibkr-mixed-trade-splits";

const ACCOUNT = "ZZ Broker";
const TODAY = "2026-01-15";
const MIXED_KEY = "ibkr:trade:2025-03-10:ZZA:-500:5000";

function dir(open: boolean, close: boolean, time: string): string {
  return `IBKR trade direction: ${JSON.stringify({ open, close, time })}`;
}

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

let db: Database.Database;
let mixedId: number;

function seed(): void {
  db.prepare("INSERT INTO accounts (name) VALUES (?)").run(ACCOUNT);
  const acct = (db.prepare("SELECT id FROM accounts WHERE name = ?").get(ACCOUNT) as { id: number }).id;
  db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('ZZA', 'ZZA Corp', 'Stock')").run();
  const sec = (db.prepare("SELECT id FROM securities WHERE symbol = 'ZZA'").get() as { id: number }).id;
  const ins = db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, fees, source_key, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run(acct, sec, "2025-03-03", "BUY", 500, -4000, 8, 2, "ibkr:trade:2025-03-03:ZZA:500:-4000", dir(true, false, "2025-03-03 10:00:00"));
  mixedId = Number(
    ins.run(acct, sec, "2025-03-10", "SELL", 500, 5000, 10, 3, MIXED_KEY, dir(true, true, "2025-03-10 10:00:00")).lastInsertRowid,
  );
  ins.run(acct, sec, "2025-03-10", "SELL", 100, 900, 9, 1, "ibkr:trade:2025-03-10:ZZA:-100:900", dir(false, true, "2025-03-10 10:05:00"));
  ins.run(acct, sec, "2025-03-10", "BUY", 100, -850, 8.5, 1, "ibkr:trade:2025-03-10:ZZA:100:-850", dir(false, true, "2025-03-10 10:30:00"));
}

function config(overrides: Partial<RepairConfig["splits"][number]> = {}): RepairConfig {
  return parseRepairConfig({
    accountName: ACCOUNT,
    splits: [
      {
        transactionId: mixedId,
        sourceKey: MIXED_KEY,
        symbol: "ZZA",
        tradeDate: "2025-03-10",
        type: "SELL",
        quantity: 500,
        amount: 5000,
        fees: 3,
        closeQuantity: 400,
        openQuantity: 100,
        evidence: "synthetic",
        ...overrides,
      },
    ],
  });
}

function openLots(): Array<{ quantity_remaining: number; is_short: number }> {
  return db
    .prepare("SELECT quantity_remaining, is_short FROM tax_lots WHERE quantity_remaining > 1e-9")
    .all() as Array<{ quantity_remaining: number; is_short: number }>;
}

function cashSum(): number {
  return (db.prepare("SELECT SUM(amount) AS s FROM transactions WHERE type <> 'RECONCILE_CLOSE'").get() as { s: number }).s;
}

function generation(): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'tax_input_generation'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

beforeEach(() => {
  db = createDb();
  seed();
});

describe("repair-ibkr-mixed-trade-splits", () => {
  it("before the repair the replay drops the mixed trade and leaves phantom shares open", () => {
    const r = computeTaxLots(db);
    expect(r.replayWarnings.some((w) => w.includes("cannot be split"))).toBe(true);
    expect(openLots()).toEqual([{ quantity_remaining: 400, is_short: 0 }]);
  });

  it("dry run plans the split and writes nothing", () => {
    const res = runMixedTradeSplits(db, config(), { apply: false, today: TODAY });
    expect(res.plan.refusals).toEqual([]);
    expect(res.plan.splits.map((s) => s.state)).toEqual(["needs-repair"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 4 });
  });

  it("apply splits the row, keeps cash exact, bumps the generation, and the replay ends flat", () => {
    const cashBefore = cashSum();
    const genBefore = generation();
    const res = runMixedTradeSplits(db, config(), { apply: true, today: TODAY });
    expect(res.split).toBe(1);
    expect(cashSum()).toBeCloseTo(cashBefore, 9);
    expect(generation()).toBe(genBefore + 1);

    const close = db.prepare("SELECT * FROM transactions WHERE id = ?").get(mixedId) as {
      quantity: number; amount: number; fees: number; source_key: string; notes: string;
    };
    const open = db.prepare("SELECT * FROM transactions WHERE source_key = ?").get(splitOpenSourceKey(MIXED_KEY)) as {
      id: number; quantity: number; amount: number; fees: number; notes: string;
    };
    expect(close.source_key).toBe(MIXED_KEY);
    expect(close.quantity).toBe(400);
    expect(close.amount).toBeCloseTo(4000, 9);
    expect(open.quantity).toBe(100);
    expect(close.amount + open.amount).toBeCloseTo(5000, 9);
    expect(close.fees + open.fees).toBeCloseTo(3, 9);
    expect(open.id).toBeGreaterThan(mixedId);
    expect(readIbkrTradeDirection(close.notes)).toEqual({ open: false, close: true, time: "2025-03-10 10:00:00" });
    expect(readIbkrTradeDirection(open.notes)).toEqual({ open: true, close: false, time: "2025-03-10 10:00:00" });

    const r = computeTaxLots(db);
    expect(r.replayWarnings).toEqual([]);
    expect(openLots()).toEqual([]);
    const shortLots = db.prepare("SELECT quantity_acquired FROM tax_lots WHERE is_short = 1").all();
    expect(shortLots).toEqual([{ quantity_acquired: 100 }]);
  });

  it("is idempotent: a second run finds the row already split and writes nothing", () => {
    runMixedTradeSplits(db, config(), { apply: true, today: TODAY });
    const gen = generation();
    const again = runMixedTradeSplits(db, config(), { apply: true, today: TODAY });
    expect(again.plan.splits.map((s) => s.state)).toEqual(["already-repaired"]);
    expect(again.split).toBe(0);
    expect(generation()).toBe(gen);
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 5 });
  });

  it("refuses the whole run when a row is in neither state", () => {
    db.prepare("UPDATE transactions SET amount = 4999 WHERE id = ?").run(mixedId);
    expect(() => runMixedTradeSplits(db, config(), { apply: true, today: TODAY })).toThrow(/refusing to write/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 4 });
  });

  it("refuses a config whose legs do not add up to the trade", () => {
    expect(() => config({ closeQuantity: 300 })).toThrow(/must equal quantity/);
  });

  it("refuses when the account name does not match", () => {
    const plan = planMixedTradeSplits(db, { ...config(), accountName: "Nope" });
    expect(plan.refusals[0]).toMatch(/no account named/);
  });

  it("every --apply takes a fresh, time-stamped backup and refuses an existing one", () => {
    // 2026-07-01 23:59:59 UTC is 19:59:59 Eastern (daylight time).
    expect(backupStamp(new Date("2026-07-01T23:59:59Z"))).toBe("2026-07-01_19-59-59");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-mixed-splits-backup-"));
    try {
      const dbFile = path.join(dir, "copy.db");
      const fileDb = new Database(dbFile);
      fileDb.exec("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);");
      const first = backupPathFor(dbFile, new Date("2026-07-01T23:59:59Z"));
      expect(first).toBe(path.join(dir, "backups", "pre-ibkr-mixed-trade-splits-2026-07-01_19-59-59.db"));
      const second = backupPathFor(dbFile, new Date("2026-07-02T00:00:00Z"));
      expect(second).not.toBe(first);
      takeFreshBackup(fileDb, first);
      fileDb.exec("INSERT INTO t VALUES (2);");
      expect(() => takeFreshBackup(fileDb, first)).toThrow(/already exists; refusing/);
      const old = new Database(first, { readonly: true });
      expect((old.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n).toBe(1); // untouched
      old.close();
      takeFreshBackup(fileDb, second);
      const fresh = new Database(second, { readonly: true });
      expect((fresh.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n).toBe(2);
      fresh.close();
      fileDb.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
