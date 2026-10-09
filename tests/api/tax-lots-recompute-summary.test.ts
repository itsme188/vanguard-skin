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

describe("tax-lot recompute summary: one basis per tax year (the sale year)", () => {
  function seedCrossYearBook(db: Database.Database) {
    const accountId = acct(db);
    const sec = db.prepare("INSERT INTO securities (symbol, security_type, sector) VALUES ('ZZZ', 'Stock', 'Technology')").run()
      .lastInsertRowid as number;
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 13, 'test')").run(sec, TODAY);
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, '2025-06-02', 'BUY', 100, 10, -1000, 0, 'buy-zzz')`
    ).run(accountId, sec);
    computeTaxLots(db);
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, '2026-02-02', 'SELL', 100, 13, 1300, 0, 'sell-zzz')`
    ).run(accountId, sec);
  }

  it("a lot acquired in 2025 and sold in 2026 shows its gain AND its closure under 2026, nothing under 2025", () => {
    const db = hoisted.db;
    seedCrossYearBook(db);

    const summary = rehearseTaxLotRecompute(db);

    expect(summary.years).toEqual([
      {
        taxYear: 2026,
        realizedGainBefore: 0,
        realizedGainAfter: 300,
        nonUsdSalesExcludedBefore: 0,
        nonUsdSalesExcludedAfter: 0,
        lotSalesAdded: 1,
        lotSalesRemoved: 0,
        engineClosesAdded: 0,
        engineClosesRemoved: 0,
      },
    ]);
    expect(summary.years.some((y) => y.taxYear === 2025)).toBe(false);
  });

  it("open lots are one total outside any tax year", () => {
    const db = hoisted.db;
    seedCrossYearBook(db);

    const summary = rehearseTaxLotRecompute(db);

    // The 2025 lot was open before and is fully sold after.
    expect(summary.openLots).toEqual({ before: 1, after: 0, added: 0, removed: 1 });
  });

  it("a partial sale counts the lot sale in the sale year and the open lot as changed, not as a year row for the purchase", () => {
    const db = hoisted.db;
    seedBook(db);

    const summary = rehearseTaxLotRecompute(db);

    expect(summary.years.map((y) => y.taxYear)).toEqual([2026]);
    expect(summary.years[0]).toMatchObject({ lotSalesAdded: 1, lotSalesRemoved: 0 });
    // Same lot, fewer shares left: one row gone, one row new.
    expect(summary.openLots).toEqual({ before: 1, after: 1, added: 1, removed: 1 });
  });

  it("an unchanged book reports no lot movement", () => {
    const db = hoisted.db;
    seedCrossYearBook(db);
    computeTaxLots(db);

    const summary = rehearseTaxLotRecompute(db);

    expect(summary.years).toEqual([
      expect.objectContaining({ taxYear: 2026, realizedGainBefore: 300, realizedGainAfter: 300, lotSalesAdded: 0, lotSalesRemoved: 0 }),
    ]);
    expect(summary.openLots).toEqual({ before: 0, after: 0, added: 0, removed: 0 });
  });
});

describe("tax-lot recompute summary: the open-lot count says what it includes", () => {
  // The preview's open-lot count is every open row in every account. The Tax
  // Lots page lists two kinds of those rows apart from its Open Lots table:
  // lots of an option past its expiration (awaiting a closing entry) and
  // currency-conversion lots. The preview names both so its count can be
  // squared with the table's. Dates are far past / far future so the fixture
  // never goes stale against the wall clock.
  function seedMixedBook(db: Database.Database) {
    const accountId = acct(db);
    const insertSecurity = db.prepare(
      "INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date) VALUES (?, ?, ?, ?, ?)"
    );
    const stock = insertSecurity.run("ZZA", "ZZA stock", "Stock", 1, null).lastInsertRowid as number;
    const expired = insertSecurity.run("ZZA   200117P00050000", "ZZA expired put", "Option", 100, "2000-01-17")
      .lastInsertRowid as number;
    // Legacy rows store the expiration compact; it must still read as expired.
    const expiredCompact = insertSecurity.run("ZZA   200117C00050000", "ZZA expired call", "Option", 100, "20000117")
      .lastInsertRowid as number;
    const live = insertSecurity.run("ZZA   991217C00050000", "ZZA live call", "Option", 100, "2999-12-17")
      .lastInsertRowid as number;
    const fx = insertSecurity.run("ZZE.USD", "ZZE.USD", "Forex", 1, null).lastInsertRowid as number;
    const buy = db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, ?, 'BUY', ?, ?, ?, 0, ?)`
    );
    buy.run(accountId, stock, "1999-06-01", 100, 10, -1000, "buy-zza");
    buy.run(accountId, stock, "1999-07-01", 50, 10, -500, "buy-zza-2");
    buy.run(accountId, expired, "1999-11-01", 2, 1, -200, "buy-expired-put");
    buy.run(accountId, expiredCompact, "1999-11-02", 1, 1, -100, "buy-expired-call");
    buy.run(accountId, live, "1999-12-01", 3, 1, -300, "buy-live-call");
    buy.run(accountId, fx, "1999-08-01", 1000, 1, -1000, "buy-fx");
  }

  it("counts expired-option lots and currency-conversion lots inside the open-lot total, before and after", () => {
    const db = hoisted.db;
    seedMixedBook(db);

    const summary = rehearseTaxLotRecompute(db);

    // Nothing was computed before; after, six lots are open.
    expect(summary.openLots).toEqual({ before: 0, after: 6, added: 6, removed: 0 });
    expect(summary.openLotBreakdown).toEqual({
      expiredOptionLots: { before: 0, after: 2 },
      currencyConversionLots: { before: 0, after: 1 },
    });
  });

  it("the breakdown agrees with what the Tax Lots page lists apart from Open Lots", async () => {
    const db = hoisted.db;
    seedMixedBook(db);
    computeTaxLots(db);
    const { getOpenTaxLots, getExpiredOptionLotsAwaitingClose, isCurrencyConversionTaxLot } = await import(
      "@/lib/queries/tax-lots"
    );

    const summary = rehearseTaxLotRecompute(db);
    const tableRows = getOpenTaxLots(db);
    const expiredRows = getExpiredOptionLotsAwaitingClose(db);
    const currencyRows = tableRows.filter(isCurrencyConversionTaxLot);

    expect(summary.openLotBreakdown.expiredOptionLots.before).toBe(expiredRows.length);
    expect(summary.openLotBreakdown.currencyConversionLots.before).toBe(currencyRows.length);
    // The identity the preview's wording rests on: the total, less the two
    // kinds listed apart, is the Open Lots table's own row count.
    expect(
      summary.openLots.before -
        summary.openLotBreakdown.expiredOptionLots.before -
        summary.openLotBreakdown.currencyConversionLots.before
    ).toBe(tableRows.length - currencyRows.length);
  });

  it("the rehearsal that reads the breakdown still writes nothing, and apply reports the same figures", () => {
    const db = hoisted.db;
    seedMixedBook(db);
    const before = dumpTables(db);

    const mixed = rehearseTaxLotRecompute(db);
    expect(mixed.openLotBreakdown.expiredOptionLots.after).toBe(2);
    expect(dumpTables(db)).toBe(before);
    expect(applyTaxLotRecompute(db).summary).toEqual(mixed);
  });

  it("a plain stock book has an empty breakdown", () => {
    const db = hoisted.db;
    seedBook(db);

    expect(rehearseTaxLotRecompute(db).openLotBreakdown).toEqual({
      expiredOptionLots: { before: 0, after: 0 },
      currencyConversionLots: { before: 0, after: 0 },
    });
  });
});
