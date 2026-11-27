/**
 * Plan v4 (Plaid session dating), unit U3, Data Confidence:
 *  - a Plaid holdings row dated on or after `expectedPlaidSession(now)` scores
 *    as fresh (the read runs before the open and stores the previous session,
 *    so before 07:40 Eastern the newest possible row is two sessions back);
 *  - the cash timing-residual wording says "intraday broker total" only for a
 *    TWS anchor; a Plaid day reads "previous-session broker total".
 * Synthetic securities, invented dates and round figures only.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getDataConfidence } from "@/lib/queries/data-confidence";

const FIX = "Import latest statement or sync IBKR positions";

function freshDb(): { db: Database.Database; vg: number } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const vg = (db.prepare("SELECT id FROM accounts WHERE name = 'Vanguard Taxable'").get() as { id: number }).id;
  return { db, vg };
}

function seedRow(db: Database.Database, account: number, date: string, key: (sec: number) => string): void {
  const sec = db.prepare("INSERT INTO securities (symbol, security_type) VALUES ('FAKE1', 'Stock')").run()
    .lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, 10, 100, ?, ?)",
  ).run(account, sec, date, key(sec));
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 12, 'tws')").run(sec, date);
}

function vanguardRecency(db: Database.Database, now: Date) {
  const confidence = getDataConfidence(db, now);
  return {
    account: confidence.holdingsRecency.perAccount.find((a) => a.name === "Vanguard Taxable")!,
    actionable: confidence.holdingsRecency.guidanceActionable,
    action: confidence.actions.find((a) => a.fix === FIX),
  };
}

// Wednesday 2026-03-18, 07:00 Eastern (before 07:40): the expected Plaid
// session is Monday 2026-03-16 (Tuesday's read stored Monday).
const WED_EARLY = new Date("2026-03-18T11:00:00Z");
// Tuesday 2026-03-17, 07:00 Eastern: expected session is Friday 2026-03-13.
const TUE_EARLY = new Date("2026-03-17T11:00:00Z");

describe("Data Confidence: Plaid rows on the expected session are fresh", () => {
  it("a Plaid row on the expected session is fresh before today's read has run", () => {
    const { db, vg } = freshDb();
    seedRow(db, vg, "2026-03-16", (sec) => `plaid:s:${vg}:${sec}:2026-03-16`);
    const r = vanguardRecency(db, WED_EARLY);
    expect(r.account.ageDays).toBe(1);
    expect(r.account.daysOld).toBe(2); // the printed calendar age is unchanged
    expect(r.actionable).toBe(false);
    expect(r.action).toBeUndefined();
  });

  it("across a weekend: Friday's Plaid row is fresh on Tuesday before the read", () => {
    const { db, vg } = freshDb();
    seedRow(db, vg, "2026-03-13", (sec) => `plaid:s:${vg}:${sec}:2026-03-13`);
    const r = vanguardRecency(db, TUE_EARLY);
    expect(r.account.ageDays).toBe(1);
    expect(r.action).toBeUndefined();
  });

  it("a Plaid row older than the expected session is still stale", () => {
    const { db, vg } = freshDb();
    seedRow(db, vg, "2026-03-13", (sec) => `plaid:s:${vg}:${sec}:2026-03-13`);
    const r = vanguardRecency(db, WED_EARLY);
    expect(r.account.ageDays).toBeGreaterThan(1);
    expect(r.actionable).toBe(true);
    expect(r.action).toBeDefined();
  });

  it("the rule is for Plaid rows only: a statement row of the same age is stale", () => {
    const { db, vg } = freshDb();
    seedRow(db, vg, "2026-03-16", () => "vanguard-pdf:holding:FAKE1:2026-03-16");
    const r = vanguardRecency(db, WED_EARLY);
    expect(r.account.ageDays).toBe(2);
    expect(r.actionable).toBe(true);
  });
});

describe("Data Confidence: timing-residual wording by live source", () => {
  function seedResidual(source: string): Database.Database {
    const { db, vg } = freshDb();
    // A statement anchor, then live anchors of one source (so the jump day
    // is not the statement-to-live seam), and an external-flow-shaped cash
    // jump that lands on a live anchor.
    db.prepare(
      "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (?, '2026-03-12', 340000, 'manual')",
    ).run(vg);
    const live = db.prepare(
      "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (?, ?, ?, ?)",
    );
    live.run(vg, "2026-03-13", 345000, source);
    live.run(vg, "2026-03-16", 350000, source);
    live.run(vg, "2026-03-17", 440000, source);
    const val = db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, ?, ?, ?)",
    );
    val.run(vg, "2026-03-16", 60000, 290000, 350000);
    val.run(vg, "2026-03-17", 210000, 230000, 440000);
    return db;
  }
  const NOW = new Date("2026-03-18T16:00:00Z");

  it("a Plaid anchor reads 'previous-session broker total', never 'intraday'", () => {
    const { cashAccuracy } = getDataConfidence(seedResidual("plaid"), NOW);
    expect(cashAccuracy.timingResidual).toMatchObject({ date: "2026-03-17", liveSource: "plaid" });
    expect(cashAccuracy.detail).toContain(
      "live-snapshot timing residual (previous-session broker total vs close-priced holdings)",
    );
    expect(cashAccuracy.detail).not.toContain("intraday");
  });

  it("a TWS anchor keeps 'intraday broker total'", () => {
    const { cashAccuracy } = getDataConfidence(seedResidual("tws"), NOW);
    expect(cashAccuracy.timingResidual).toMatchObject({ date: "2026-03-17", liveSource: "tws" });
    expect(cashAccuracy.detail).toContain(
      "live-snapshot timing residual (intraday broker total vs close-priced holdings)",
    );
  });
});
