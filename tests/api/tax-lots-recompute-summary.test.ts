import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  applyTaxLotRecompute,
  rehearseTaxLotRecompute,
} from "@/lib/compute/tax-lot-recompute-summary";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const TODAY = "2026-10-07";

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

function acct(db: Database.Database): number {
  return (db.prepare("SELECT id FROM accounts WHERE name = 'Vanguard Taxable'").get() as { id: number }).id;
}

function seedBook(db: Database.Database) {
  const accountId = acct(db);
  const sec = db.prepare("INSERT INTO securities (symbol, security_type, sector) VALUES ('AAA', 'Stock', 'Technology')").run()
    .lastInsertRowid as number;
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 12, 'test')").run(sec, TODAY);
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, '2026-01-02', 'BUY', 100, 10, -1000, 0, 'buy-aaa')`
  ).run(accountId, sec);
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, '2026-03-02', 'SELL', 40, 12, 480, 0, 'sell-aaa')`
  ).run(accountId, sec);
  computeTaxLots(db);
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, '2026-04-02', 'SELL', 10, 14, 140, 0, 'sell-aaa-new')`
  ).run(accountId, sec);
}

function dumpTables(db: Database.Database): string {
  const tables = (
    db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    ).all() as { name: string }[]
  ).map((r) => r.name);
  return JSON.stringify({
    tables: tables.map((table) => ({
      table,
      rows: db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    })),
    sqlite_sequence: db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(),
  });
}

describe("tax-lot recompute summary rehearsal", () => {
  it("rehearsal leaves every table and sqlite_sequence byte-identical", () => {
    const db = hoisted.db;
    seedBook(db);
    const before = dumpTables(db);

    const summary = rehearseTaxLotRecompute(db);

    expect(summary.years).toContainEqual(
      expect.objectContaining({
        taxYear: 2026,
        realizedGainBefore: 80,
        realizedGainAfter: 120,
      })
    );
    expect(dumpTables(db)).toBe(before);
  });

  it("rehearsal and real apply produce the same numbers", () => {
    const db = hoisted.db;
    seedBook(db);

    const rehearsal = rehearseTaxLotRecompute(db);
    const applied = applyTaxLotRecompute(db).summary;

    expect(applied).toEqual(rehearsal);
  });

  it("route rehearses first and only applies with explicit confirmation", async () => {
    const db = hoisted.db;
    seedBook(db);
    const before = dumpTables(db);
    const route = await import("@/app/api/compute/tax-lots/route");

    const rehearse = await route.POST(new NextRequest("http://test/api/compute/tax-lots", { method: "POST" }));
    expect(rehearse.status).toBe(200);
    const rehearseBody = await rehearse.json();
    expect(rehearseBody.data.requiresConfirmation).toBe(true);
    expect(dumpTables(db)).toBe(before);

    const apply = await route.POST(
      new NextRequest("http://test/api/compute/tax-lots", {
        method: "POST",
        body: JSON.stringify({ confirmRecompute: true }),
      })
    );
    expect(apply.status).toBe(200);
    const applyBody = await apply.json();
    expect(applyBody.data.requiresConfirmation).toBe(false);
    expect(applyBody.data.summary).toEqual(rehearseBody.data.summary);
    expect(dumpTables(db)).not.toBe(before);
  });
});
