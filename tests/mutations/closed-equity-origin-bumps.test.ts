/**
 * Origin-aware tax-generation bumps in the closed-position reconciler (spec
 * 2026-10-02 statement-only synthetic closes §2.3).
 *
 * computeTaxLots now mints synthetic closes from statement-grade evidence
 * only, so a `:live` tombstone is no longer a tax input: minting or deleting
 * one must not advance `tax_input_generation`. A `:stmt` (or legacy
 * unsuffixed) tombstone still is. Synthetic tickers only.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  reconcileClosedEquityHoldings,
  removeOrphanedReconTombstones,
  countStatementGradeRowsOnDate,
} from "@/lib/mutations/closed-equity";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function acct(name: string): number {
  return (
    db
      .prepare(`INSERT INTO accounts (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id`)
      .get(name) as { id: number }
  ).id;
}
function sec(symbol: string, type = "stock"): number {
  return (
    db.prepare(`INSERT INTO securities (symbol, security_type) VALUES (?, ?) RETURNING id`).get(symbol, type) as {
      id: number;
    }
  ).id;
}
function hold(a: number, s: number, qty: number, date: string, sourceKey: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)`,
  ).run(a, s, qty, date, sourceKey);
}
const gen = () => getTaxInputGeneration(db);

describe("reconcileClosedEquityHoldings — bumps only for statement-grade tombstones", () => {
  it("a live-pass-only mint (:live tombstone) does NOT bump", () => {
    const a = acct("ZZ1");
    const gone = sec("ZZGONE");
    const keep = sec("ZZKEEP");
    // Statement book on 07-31 holds both; a later live snapshot holds only ZZKEEP.
    hold(a, gone, 5, "2026-07-31", "canonical:hold:1");
    hold(a, keep, 5, "2026-07-31", "canonical:hold:2");
    hold(a, keep, 5, "2026-08-10", `plaid:${a}:${keep}:2026-08-10`);
    const g0 = gen();

    expect(reconcileClosedEquityHoldings(db)).toBe(1);

    const key = (
      db.prepare(`SELECT source_key FROM holdings WHERE security_id = ? AND quantity = 0`).get(gone) as {
        source_key: string;
      }
    ).source_key;
    expect(key.endsWith(":live")).toBe(true);
    expect(gen()).toBe(g0);
  });

  it("a statement-pass mint (:stmt tombstone) bumps exactly once", () => {
    const a = acct("ZZ2");
    hold(a, sec("ZZOLD"), 5, "2026-07-31", "canonical:hold:1");
    hold(a, sec("ZZHELD"), 5, "2026-08-29", "canonical:hold:2");
    const g0 = gen();

    expect(reconcileClosedEquityHoldings(db)).toBe(1);
    expect(gen()).toBe(g0 + 1);
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    expect(gen()).toBe(g0 + 1);
  });

  it("a run minting both origins bumps once (for the statement-grade one)", () => {
    const a = acct("ZZ3");
    const stmtGone = sec("ZZSGONE");
    const liveGone = sec("ZZLGONE");
    const keep = sec("ZZKEEP3");
    hold(a, stmtGone, 5, "2026-07-31", "canonical:hold:1");
    hold(a, liveGone, 5, "2026-08-29", "canonical:hold:2");
    hold(a, keep, 5, "2026-08-29", "canonical:hold:3");
    hold(a, keep, 5, "2026-09-05", `tws-${a}-${keep}-2026-09-05`);
    const g0 = gen();

    expect(reconcileClosedEquityHoldings(db)).toBe(2);
    expect(gen()).toBe(g0 + 1);
  });
});

describe("removeOrphanedReconTombstones — bumps only when a statement-grade tombstone goes", () => {
  it("deleting only :live orphans does NOT bump", () => {
    const a = acct("ZZ4");
    hold(a, sec("ZZX"), 0, "2026-08-01", "recon:closed-equity:t:live");
    const g0 = gen();
    expect(removeOrphanedReconTombstones(db)).toBe(1);
    expect(gen()).toBe(g0);
  });

  it("deleting a :stmt orphan bumps", () => {
    const a = acct("ZZ5");
    hold(a, sec("ZZY"), 0, "2026-08-01", "recon:closed-equity:t:stmt");
    const g0 = gen();
    expect(removeOrphanedReconTombstones(db)).toBe(1);
    expect(gen()).toBe(g0 + 1);
  });

  it("deleting a legacy unsuffixed orphan does NOT bump — with no same-date statement row it is live-origin (I2)", () => {
    const a = acct("ZZ6");
    hold(a, sec("ZZZ"), 0, "2026-08-01", "recon:closed-equity:1:2:2026-08-01");
    const g0 = gen();
    expect(removeOrphanedReconTombstones(db)).toBe(1);
    expect(gen()).toBe(g0);
  });

  it("deleting both origins in one call bumps once", () => {
    const a = acct("ZZ7");
    hold(a, sec("ZZP"), 0, "2026-08-01", "recon:closed-equity:p:live");
    hold(a, sec("ZZQ"), 0, "2026-08-02", "recon:closed-equity:q:stmt");
    const g0 = gen();
    expect(removeOrphanedReconTombstones(db)).toBe(2);
    expect(gen()).toBe(g0 + 1);
  });
});

describe("countStatementGradeRowsOnDate", () => {
  it("counts statement rows and :stmt/legacy tombstones, never live rows or :live tombstones", () => {
    const a = acct("ZZ8");
    const d = "2026-08-01";
    hold(a, sec("ZZA"), 5, d, "canonical:hold:a");
    hold(a, sec("ZZB"), 0, d, "recon:closed-equity:b:stmt");
    hold(a, sec("ZZC"), 0, d, "recon:closed-equity:1:3:2026-08-01");
    hold(a, sec("ZZD"), 0, d, "recon:closed-equity:d:live");
    hold(a, sec("ZZE"), 5, d, `tws-${a}-5-${d}`);
    hold(a, sec("ZZF"), 5, d, `plaid:${a}:6:${d}`);
    expect(countStatementGradeRowsOnDate(db, a, d)).toBe(3);
    expect(countStatementGradeRowsOnDate(db, a, "2026-08-02")).toBe(0);
  });
});

describe("statement pass confirms a live-only flat (2026-10-02)", () => {
  // Since synthetic closes read statement-grade evidence only, a position
  // already retired by a LIVE pass (its newest row a `:live` tombstone or a
  // live zero row) must still be retired by the next statement that omits
  // it — otherwise the statement could never confirm the flat.
  it.each([
    ["a :live tombstone", (a: number, s: number, d: string) => `recon:closed-equity:${a}:${s}:${d}:live`],
    ["a live tws- zero row", (a: number, s: number, d: string) => `tws-${a}-${s}-${d}`],
  ])("mints a :stmt tombstone when the newest row is %s dated before the statement", (_label, key) => {
    const a = acct("ZZ9");
    const gone = sec("ZZGONE9");
    const keep = sec("ZZKEEP9");
    hold(a, gone, 5, "2026-07-31", "canonical:hold:g1");
    hold(a, keep, 5, "2026-07-31", "canonical:hold:k1");
    hold(a, gone, 0, "2026-08-10", key(a, gone, "2026-08-10"));
    hold(a, keep, 5, "2026-08-31", "canonical:hold:k2"); // statement omits ZZGONE9
    const g0 = gen();

    expect(reconcileClosedEquityHoldings(db)).toBe(1);

    const tomb = db
      .prepare(`SELECT as_of_date, source_key FROM holdings WHERE security_id = ? ORDER BY as_of_date DESC LIMIT 1`)
      .get(gone) as { as_of_date: string; source_key: string };
    expect(tomb.as_of_date).toBe("2026-08-31");
    expect(tomb.source_key.endsWith(":stmt")).toBe(true);
    expect(gen()).toBe(g0 + 1);
    // Idempotent: the newest row is now statement-grade zero.
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    expect(gen()).toBe(g0 + 1);
  });

  it("does not re-mint over an existing statement-grade zero", () => {
    const a = acct("ZZ10");
    const gone = sec("ZZGONE10");
    const keep = sec("ZZKEEP10");
    hold(a, gone, 0, "2026-07-31", "recon:closed-equity:x:stmt");
    hold(a, keep, 5, "2026-07-31", "canonical:hold:k1");
    hold(a, keep, 5, "2026-08-31", "canonical:hold:k2");
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
  });

  it("still leaves a position alone when a live row NEWER than the statement shows it (unchanged)", () => {
    const a = acct("ZZ11");
    const gone = sec("ZZGONE11");
    const keep = sec("ZZKEEP11");
    hold(a, gone, 5, "2026-07-31", "canonical:hold:g1");
    hold(a, keep, 5, "2026-07-31", "canonical:hold:k1");
    hold(a, keep, 5, "2026-08-31", "canonical:hold:k2");
    hold(a, gone, 5, "2026-09-02", `plaid:${a}:${gone}:2026-09-02`);
    hold(a, keep, 5, "2026-09-02", `plaid:${a}:${keep}:2026-09-02`);
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
  });
});

describe("statement pass upgrades a same-date live flat in place (I1)", () => {
  // A month-end live sync tombstones a position on the statement date
  // itself; the month-end statement that omits it must confirm THAT row —
  // an INSERT would hit UNIQUE(account, security, as_of_date).
  function rowOf(a: number, s: number, d: string) {
    return db
      .prepare(`SELECT id, quantity, source_key, import_batch_id FROM holdings WHERE account_id=? AND security_id=? AND as_of_date=?`)
      .get(a, s, d) as { id: number; quantity: number; source_key: string; import_batch_id: number | null };
  }

  it.each([
    ["a :live tombstone", (a: number, s: number, d: string) => `recon:closed-equity:${a}:${s}:${d}:live`],
    ["a live tws- zero row", (a: number, s: number, d: string) => `tws-${a}-${s}-${d}`],
  ])("relabels %s dated ON the statement date as the :stmt tombstone and bumps", (_label, key) => {
    const a = acct("ZZ12");
    const gone = sec("ZZGONE12");
    const keep = sec("ZZKEEP12");
    hold(a, gone, 5, "2026-07-31", "canonical:hold:g1");
    hold(a, keep, 5, "2026-07-31", "canonical:hold:k1");
    hold(a, gone, 0, "2026-08-31", key(a, gone, "2026-08-31"));
    hold(a, keep, 5, "2026-08-31", "canonical:hold:k2"); // statement omits ZZGONE12
    const before = rowOf(a, gone, "2026-08-31");
    const g0 = gen();

    expect(reconcileClosedEquityHoldings(db)).toBe(1);

    const after = rowOf(a, gone, "2026-08-31");
    expect(after.id).toBe(before.id); // upgraded in place, not a second row
    expect(after.quantity).toBe(0);
    expect(after.source_key).toBe(`recon:closed-equity:${a}:${gone}:2026-08-31:stmt`);
    expect(after.import_batch_id).toBeNull();
    expect(gen()).toBe(g0 + 1);
    expect(reconcileClosedEquityHoldings(db)).toBe(0); // idempotent
    expect(gen()).toBe(g0 + 1);
  });

  it("stamps the upgraded row with the import batch only for an owned account", () => {
    const a = acct("ZZ13");
    const other = acct("ZZ13B");
    const batchId = (
      db.prepare(`INSERT INTO import_batches (source_type) VALUES ('canonical-csv') RETURNING id`).get() as { id: number }
    ).id;
    for (const acc of [a, other]) {
      const gone = sec(`ZZG13-${acc}`);
      const keep = sec(`ZZK13-${acc}`);
      hold(acc, gone, 5, "2026-07-31", `canonical:hold:g-${acc}`);
      hold(acc, keep, 5, "2026-07-31", `canonical:hold:k-${acc}`);
      hold(acc, gone, 0, "2026-08-31", `recon:closed-equity:${acc}:${gone}:2026-08-31:live`);
      hold(acc, keep, 5, "2026-08-31", `canonical:hold:k2-${acc}`);
    }
    expect(reconcileClosedEquityHoldings(db, { importBatchId: batchId, ownedAccountIds: [a] })).toBe(2);
    const stamps = db
      .prepare(`SELECT account_id, import_batch_id FROM holdings WHERE source_key LIKE '%:stmt' ORDER BY account_id`)
      .all() as { account_id: number; import_batch_id: number | null }[];
    expect(stamps).toEqual([
      { account_id: a, import_batch_id: batchId },
      { account_id: other, import_batch_id: null },
    ]);
  });

  it("orphan cleanup deletes an upgraded row once its same-date statement evidence is gone (and bumps)", () => {
    const a = acct("ZZ14");
    const gone = sec("ZZGONE14");
    const keep = sec("ZZKEEP14");
    hold(a, gone, 5, "2026-07-31", "canonical:hold:g1");
    hold(a, keep, 5, "2026-07-31", "canonical:hold:k1");
    hold(a, gone, 0, "2026-08-31", `recon:closed-equity:${a}:${gone}:2026-08-31:live`);
    hold(a, keep, 5, "2026-08-31", "canonical:hold:k2");
    reconcileClosedEquityHoldings(db);
    db.prepare(`DELETE FROM holdings WHERE source_key = 'canonical:hold:k2'`).run();
    const g0 = gen();
    expect(removeOrphanedReconTombstones(db)).toBe(1);
    expect(gen()).toBe(g0 + 1);
  });

  it("never relabels a NON-zero live row on the statement date (a held live row is not a flat)", () => {
    const a = acct("ZZ15");
    const x = sec("ZZX15");
    const keep = sec("ZZKEEP15");
    hold(a, x, 5, "2026-07-31", "canonical:hold:x1");
    hold(a, keep, 5, "2026-07-31", "canonical:hold:k1");
    hold(a, x, 5, "2026-08-31", `tws-${a}-${x}-2026-08-31`);
    hold(a, keep, 5, "2026-08-31", "canonical:hold:k2");
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
  });
});
