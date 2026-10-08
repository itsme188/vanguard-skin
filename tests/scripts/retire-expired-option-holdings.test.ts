/**
 * U24 — scripts/retire-expired-option-holdings.ts. Synthetic symbols and
 * invented round numbers only; every DB is :memory: or a throwaway temp file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import { removeOrphanedReconTombstones } from "@/lib/mutations/closed-equity";
import {
  formatExpiredOptionReport,
  planExpiredOptionHoldings,
  runExpiredOptionRetirement,
} from "@/scripts/retire-expired-option-holdings";

const TODAY = "2026-10-07";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function acct(d: Database.Database, name: string): number {
  return d.prepare("INSERT INTO accounts (name) VALUES (?)").run(name).lastInsertRowid as number;
}
function option(d: Database.Database, symbol: string, expiration: string | null, type = "Option"): number {
  return d
    .prepare("INSERT INTO securities (symbol, security_type, expiration_date) VALUES (?, ?, ?)")
    .run(symbol, type, expiration).lastInsertRowid as number;
}
function hold(d: Database.Database, a: number, s: number, qty: number, date: string, sourceKey: string): number {
  return d
    .prepare("INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)")
    .run(a, s, qty, date, sourceKey).lastInsertRowid as number;
}
const holdingsSnapshot = (d: Database.Database) =>
  d.prepare("SELECT id, account_id, security_id, quantity, cost_basis, as_of_date, source_key FROM holdings ORDER BY id").all();

/** One statement account and one live account, each with an expired contract and a newer snapshot. */
function seedBook(d: Database.Database) {
  const stmtAcct = acct(d, "ZZ Statement");
  const liveAcct = acct(d, "ZZ Live");
  const stock = d.prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZKEEP', 'Stock')").run()
    .lastInsertRowid as number;
  const legacy = option(d, "ZZA   261002C00100000", "20261002"); // legacy compact spelling
  const iso = option(d, "ZZB   261002P00050000", "2026-10-02", "option");
  const stmtRow = hold(d, stmtAcct, legacy, 7777, "2026-09-30", "canonical:hold:zz-1");
  hold(d, stmtAcct, stock, 10, "2026-09-30", "canonical:hold:zz-2");
  hold(d, stmtAcct, stock, 10, "2026-10-05", `plaid:${stmtAcct}:${stock}:2026-10-05`);
  const liveRow = hold(d, liveAcct, iso, -3, "2026-10-01", `tws-${liveAcct}-${iso}-2026-10-01`);
  hold(d, liveAcct, stock, 5, "2026-10-06", `tws-${liveAcct}-${stock}-2026-10-06`);
  return { stmtAcct, liveAcct, stock, legacy, iso, stmtRow, liveRow };
}

describe("planExpiredOptionHoldings", () => {
  it("lists expired contracts per account and source class, legacy and ISO spellings alike", () => {
    const b = seedBook(db);
    const plan = planExpiredOptionHoldings(db, TODAY);

    expect(plan.rows.map((r) => [r.holdingId, r.sourceClass, r.expiration, r.retireDate, r.skipReason])).toEqual([
      [b.stmtRow, "statement", "2026-10-02", "2026-10-05", null],
      [b.liveRow, "live", "2026-10-02", "2026-10-06", null],
    ]);
    expect(plan.groups).toEqual([
      { accountId: b.stmtAcct, sourceClass: "statement", expired: 1, retirable: 1, skipped: 0 },
      { accountId: b.liveAcct, sourceClass: "live", expired: 1, retirable: 1, skipped: 0 },
    ]);
  });

  it("treats a contract expiring today (Eastern) as live, in both spellings", () => {
    const a = acct(db, "ZZ Today");
    const stock = option(db, "ZZKEEP", null, "Stock");
    hold(db, a, option(db, "ZZC   261007C00100000", "2026-10-07"), 1, "2026-09-30", "canonical:hold:zz-3");
    hold(db, a, option(db, "ZZD   261007P00100000", "20261007"), 1, "2026-09-30", "canonical:hold:zz-4");
    hold(db, a, stock, 1, "2026-10-06", `plaid:${a}:${stock}:2026-10-06`);

    expect(planExpiredOptionHoldings(db, TODAY).rows).toEqual([]);
    // The next Eastern day both are expired — but the newest snapshot is not
    // after the expiration day, so neither is retirable yet.
    const next = planExpiredOptionHoldings(db, "2026-10-08");
    expect(next.rows.map((r) => r.skipReason)).toEqual(["no_snapshot_after_expiry", "no_snapshot_after_expiry"]);
  });

  it("leaves alone a row on the account's newest snapshot, and ignores another account's newer snapshot", () => {
    const a = acct(db, "ZZ Stale");
    const other = acct(db, "ZZ Other");
    const stock = option(db, "ZZKEEP", null, "Stock");
    const row = hold(db, a, option(db, "ZZE   260918C00100000", "2026-09-18"), 2, "2026-08-31", "ibkr:pos:zz-5");
    hold(db, other, stock, 1, "2026-10-06", `tws-${other}-${stock}-2026-10-06`);

    const plan = planExpiredOptionHoldings(db, TODAY);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({ holdingId: row, retireDate: null, skipReason: "no_newer_snapshot" });
  });

  it("never lists non-options, already-flat pairs, or rows that are not the pair's latest", () => {
    const a = acct(db, "ZZ Misc");
    const stock = option(db, "ZZKEEP", null, "Stock");
    const flat = option(db, "ZZF   260918C00100000", "2026-09-18");
    const rolled = option(db, "ZZG   260918P00100000", "2026-09-18");
    hold(db, a, stock, 4, "2026-08-31", "canonical:hold:zz-6");
    hold(db, a, flat, 1, "2026-08-31", "canonical:hold:zz-7");
    hold(db, a, flat, 0, "2026-09-30", `recon:closed-equity:${a}:${flat}:2026-09-30:stmt`);
    hold(db, a, rolled, 1, "2026-08-31", "canonical:hold:zz-8");
    hold(db, a, rolled, 0, "2026-10-05", `tws-${a}-${rolled}-2026-10-05`);
    hold(db, a, stock, 4, "2026-10-05", `tws-${a}-${stock}-2026-10-05`);

    expect(planExpiredOptionHoldings(db, TODAY).rows).toEqual([]);
  });

  it("a tombstone never counts as the account's newest snapshot", () => {
    const a = acct(db, "ZZ Tomb");
    const stock = option(db, "ZZKEEP", null, "Stock");
    hold(db, a, option(db, "ZZH   260918C00100000", "2026-09-18"), 1, "2026-08-31", "canonical:hold:zz-9");
    hold(db, a, stock, 0, "2026-10-05", `recon:closed-equity:${a}:${stock}:2026-10-05:live`);

    expect(planExpiredOptionHoldings(db, TODAY).rows[0].skipReason).toBe("no_newer_snapshot");
  });
});

describe("runExpiredOptionRetirement", () => {
  it("dry run (the default) writes nothing", () => {
    seedBook(db);
    const before = holdingsSnapshot(db);
    const result = runExpiredOptionRetirement(db, { today: TODAY });
    expect(result).toMatchObject({ applied: false, tombstones: 0 });
    expect(holdingsSnapshot(db)).toEqual(before);
  });

  it("apply adds live-origin zero rows only: no row changed or deleted, no tax input touched", () => {
    const b = seedBook(db);
    db.prepare(
      "INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount) VALUES (?, ?, '2026-09-01', 'BUY', 1, -100)",
    ).run(b.stmtAcct, b.legacy);
    const before = holdingsSnapshot(db);
    const gen = getTaxInputGeneration(db);
    const counts = () =>
      ["tax_lots", "tax_lot_sales", "transactions"].map(
        (t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
      );
    const countsBefore = counts();

    const result = runExpiredOptionRetirement(db, { apply: true, today: TODAY });
    expect(result).toMatchObject({ applied: true, tombstones: 2 });

    const after = holdingsSnapshot(db);
    expect(after.slice(0, before.length)).toEqual(before); // every prior row byte-identical
    expect(after.slice(before.length)).toEqual([
      expect.objectContaining({
        account_id: b.stmtAcct, security_id: b.legacy, quantity: 0, as_of_date: "2026-10-05",
        source_key: `recon:closed-equity:${b.stmtAcct}:${b.legacy}:2026-10-05:live`,
      }),
      expect.objectContaining({
        account_id: b.liveAcct, security_id: b.iso, quantity: 0, as_of_date: "2026-10-06",
        source_key: `recon:closed-equity:${b.liveAcct}:${b.iso}:2026-10-06:live`,
      }),
    ]);
    expect(getTaxInputGeneration(db)).toBe(gen);
    expect(counts()).toEqual(countsBefore);
    // The reconciler's own orphan sweep accepts them (a real row shares each date).
    expect(removeOrphanedReconTombstones(db)).toBe(0);
    expect(getTaxInputGeneration(db)).toBe(gen);
  });

  it("is idempotent: a second apply finds nothing and writes nothing", () => {
    seedBook(db);
    runExpiredOptionRetirement(db, { apply: true, today: TODAY });
    const after = holdingsSnapshot(db);

    const second = runExpiredOptionRetirement(db, { apply: true, today: TODAY });
    expect(second.tombstones).toBe(0);
    expect(second.plan.rows).toEqual([]);
    expect(holdingsSnapshot(db)).toEqual(after);
  });

  it("writes nothing for a skipped pair", () => {
    const a = acct(db, "ZZ Stale");
    hold(db, a, option(db, "ZZE   260918C00100000", "2026-09-18"), 2, "2026-08-31", "ibkr:pos:zz-5");
    const before = holdingsSnapshot(db);
    expect(runExpiredOptionRetirement(db, { apply: true, today: TODAY }).tombstones).toBe(0);
    expect(holdingsSnapshot(db)).toEqual(before);
  });
});

describe("report", () => {
  it("prints ids, symbols and dates but no quantity", () => {
    const b = seedBook(db);
    const text = formatExpiredOptionReport(runExpiredOptionRetirement(db, { today: TODAY })).join("\n");
    expect(text).toContain(`holding ${b.stmtRow}  ZZA   261002C00100000  expired 2026-10-02`);
    expect(text).toContain("would write a zero row at 2026-10-05");
    expect(text).toContain(`Account ${b.liveAcct}, live rows: 1 expired (1 would be retired, 0 left alone)`);
    expect(text).toContain("Dry run (default)");
    expect(text).not.toContain("7777");
  });

  it("dry run works against a read-only temp-file database", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retire-expired-options-"));
    const file = path.join(dir, "rehearsal.db");
    try {
      const rw = new Database(file);
      runMigrations(rw);
      seedBook(rw);
      rw.close();

      const ro = new Database(file, { readonly: true });
      try {
        const result = runExpiredOptionRetirement(ro, { today: TODAY });
        expect(result.plan.rows).toHaveLength(2);
        expect(result.applied).toBe(false);
      } finally {
        ro.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
