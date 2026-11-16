/**
 * scripts/repair-gift-month-returns.ts (owner ruling 2026-11-15; convention
 * DECISIONS 2026-10-07 ruling 1 and the June 2026 restatement of 2026-10-12):
 * a gift of shares is an external outflow, so a restated gift month's return
 * must equal the return of an otherwise identical month with no gift.
 * Synthetic figures only.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeMonthlyDietz } from "@/lib/compute/dietz";
import { reconcileTwrAgainstStatements } from "@/lib/compute/twr-reconcile";
import {
  giftAdjustedReturn,
  parseMarker,
  planGiftMonthRestatement,
  runGiftMonthRestatement,
} from "@/scripts/repair-gift-month-returns";

const RUN = "2026-11-15";

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const acct = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Taxable')").run().lastInsertRowid as number;
  const sec = db.prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZA', 'Stock')").run()
    .lastInsertRowid as number;
  let n = 0;

  const snapshot = (
    month: string,
    start: number | null,
    end: number,
    twr: number | null,
    ig: number | null,
    dw = 0,
    notes: string | null = null,
  ) =>
    db
      .prepare(
        `INSERT INTO monthly_snapshots
           (account_id, month_end_date, total_value, starting_value, deposits_withdrawals, twr, investment_gain, notes, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'canonical')`,
      )
      .run(acct, month, end, start, dw, twr, ig, notes).lastInsertRowid as number;

  const leg = (date: string, type: "TRANSFER_OUT" | "TRANSFER_IN", amount: number | null) =>
    db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, is_external_flow, source_key)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(acct, sec, date, type, type === "TRANSFER_OUT" ? -10 : 10, amount, `zz:leg:${++n}`).lastInsertRowid as number;

  const gift = (date: string, value: number) => {
    const t = leg(date, "TRANSFER_OUT", value);
    const d = db
      .prepare(
        `INSERT INTO donations (source_key, kind, security_id, quantity, fmv_usd, received_date)
         VALUES (?, 'stock', ?, 10, ?, ?)`,
      )
      .run(`zz:gift:${n}`, sec, value, date).lastInsertRowid as number;
    db.prepare("INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (?, ?, 'out')").run(d, t);
    return t;
  };

  const cash = (date: string, amount: number) =>
    db
      .prepare(
        `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(acct, date, amount >= 0 ? "DEPOSIT" : "WITHDRAWAL", amount, `zz:cash:${++n}`);

  const row = (id: number) =>
    db.prepare("SELECT twr, investment_gain, deposits_withdrawals, notes FROM monthly_snapshots WHERE id = ?").get(id) as {
      twr: number;
      investment_gain: number;
      deposits_withdrawals: number;
      notes: string | null;
    };

  return { db, acct, snapshot, leg, gift, cash, row };
}

describe("repair-gift-month-returns: a gift is an outflow, not a loss", () => {
  it("flat market, gift mid-month: the restated return equals the no-gift month's (zero)", () => {
    const { db, snapshot, gift, row } = setup();
    snapshot("2025-03-31", null, 100000, 0, 0);
    // Shares worth 5,000 leave on day 15; nothing else moves.
    const id = snapshot("2025-04-30", 100000, 95000, -0.05, -5000);
    gift("2025-04-15", 5000);

    const res = runGiftMonthRestatement(db, { apply: true, runDate: RUN });
    expect(res.updated).toBe(1);
    // The identical month with no gift: 100,000 -> 100,000, a zero return.
    const noGiftMonth = (100000 - 100000) / 100000;
    expect(row(id).twr).toBeCloseTo(noGiftMonth, 9);
    expect(row(id).investment_gain).toBeCloseTo(0, 6);
    expect(row(id).deposits_withdrawals).toBe(0);
  });

  it("market up, gift on the last day: the restated return equals the no-gift month's exactly", () => {
    const { db, snapshot, gift, row } = setup();
    snapshot("2025-03-31", null, 100000, 0, 0);
    // The market adds 2,000; shares worth 4,000 leave on the month-end.
    const id = snapshot("2025-04-30", 100000, 98000, -0.02, -2000);
    gift("2025-04-30", 4000);

    runGiftMonthRestatement(db, { apply: true, runDate: RUN });
    const noGiftMonth = (102000 - 100000) / 100000;
    expect(row(id).twr).toBeCloseTo(noGiftMonth, 9);
  });

  it("market up, gift mid-month: equals the same month with a same-day cash withdrawal, and the ledger cross-check agrees", () => {
    const { db, snapshot, gift, row, acct } = setup();
    snapshot("2025-03-31", null, 100000, 0, 0);
    // A 6-place stored figure, so the restated one is stored at 6 places too.
    const id = snapshot("2025-04-30", 100000, 97012.34, -0.029877, -2987.66);
    gift("2025-04-10", 6000);

    // Twin account: identical month, the same value leaves as cash on the same day.
    const twin = setup();
    twin.snapshot("2025-03-31", null, 100000, 0, 0);
    twin.snapshot("2025-04-30", 100000, 97012.34, 0.030123, 3012.34, -6000);
    twin.cash("2025-04-10", -6000);
    const twinDietz = computeMonthlyDietz(twin.db, twin.acct, "2025-04-30");
    expect(twinDietz.rule).toBe("banded");

    const before = reconcileTwrAgainstStatements(db, acct, "2025-04-30");
    expect(before?.band).toBe("investigate");

    runGiftMonthRestatement(db, { apply: true, runDate: RUN });
    expect(row(id).twr).toBeCloseTo(twinDietz.dietzReturn as number, 5);
    expect(row(id).twr).toBeCloseTo(
      giftAdjustedReturn({ startValue: 100000, endValue: 97012.34, cashFlows: 0, gifts: [{ amount: 6000, weight: 20 / 30 }] }),
      5,
    );
    const after = reconcileTwrAgainstStatements(db, acct, "2025-04-30");
    expect(after?.band).toBe("consistent");
    expect(Math.abs(after?.divergenceBp ?? 99)).toBeLessThanOrEqual(1);
  });

  it("keeps a month's cash flow at the stored figure's weight and changes only the gift's effect", () => {
    const { db, snapshot, gift, cash, row } = setup();
    snapshot("2025-03-31", null, 100000, 0, 0);
    // A 10,000 deposit on day 8 and a 2,000 gift on day 20; market about +1,000.
    const id = snapshot("2025-04-30", 100000, 109012.34, -0.009877, -987.66, 10000);
    cash("2025-04-08", 10000);
    gift("2025-04-20", 2000);

    runGiftMonthRestatement(db, { apply: true, runDate: RUN });
    const expected = (109012.34 - 100000 - 10000 + 2000) / (100000 - 2000 * (10 / 30));
    expect(row(id).twr).toBeCloseTo(expected, 5);
    expect(row(id).deposits_withdrawals).toBe(10000);
    expect(row(id).investment_gain).toBeCloseTo(1012.34, 6);
  });

  it("is idempotent and keeps the statement's own figures recoverable on the row", () => {
    const { db, snapshot, gift, row } = setup();
    snapshot("2025-03-31", null, 100000, 0, 0);
    const id = snapshot("2025-04-30", 100000, 95000, -0.05, -5000, 0, "an earlier note");
    gift("2025-04-15", 5000);

    runGiftMonthRestatement(db, { apply: true, runDate: RUN });
    const first = row(id);
    const second = runGiftMonthRestatement(db, { apply: true, runDate: RUN });
    expect(second.updated).toBe(0);
    expect(second.plan.counts).toEqual({ pending: 0, restated: 1, "already-correct": 0, blocked: 0 });
    expect(row(id)).toEqual(first);
    expect(first.notes?.startsWith("an earlier note; ")).toBe(true);
    expect(parseMarker(first.notes)).toEqual({ twr: -0.05, investmentGain: -5000 });
  });

  it("leaves a month already stored under the convention alone (June / September 2026 shape)", () => {
    const { db, snapshot, gift, row } = setup();
    snapshot("2026-05-31", null, 100000, 0.01, 1000);
    const restated = giftAdjustedReturn({
      startValue: 100000,
      endValue: 96000,
      cashFlows: 0,
      gifts: [{ amount: 5000, weight: 15 / 30 }],
    });
    const stored = Math.round(restated * 1e4) / 1e4;
    const id = snapshot("2026-06-30", 100000, 96000, stored, 1000);
    gift("2026-06-15", 5000);

    const res = runGiftMonthRestatement(db, { apply: true, runDate: RUN });
    expect(res.plan.counts["already-correct"]).toBe(1);
    expect(res.updated).toBe(0);
    expect(row(id).twr).toBe(stored);
    expect(row(id).notes).toBeNull();
  });

  it("counts only linked gift legs: unlinked journals that net to zero change nothing", () => {
    const { db, snapshot, gift, leg, row } = setup();
    snapshot("2025-03-31", null, 100000, 0, 0);
    const id = snapshot("2025-04-30", 100000, 95000, -0.05, -5000);
    gift("2025-04-15", 5000);
    leg("2025-04-03", "TRANSFER_OUT", 700);
    leg("2025-04-03", "TRANSFER_IN", 700);

    runGiftMonthRestatement(db, { apply: true, runDate: RUN });
    expect(row(id).twr).toBeCloseTo(0, 9);
  });

  it("refuses --apply and writes nothing when a row matches neither state", () => {
    const { db, snapshot, gift, row } = setup();
    snapshot("2025-03-31", null, 100000, 0, 0);
    const ok = snapshot("2025-04-30", 100000, 95000, -0.05, -5000);
    gift("2025-04-15", 5000);
    const odd = snapshot("2025-05-31", 95000, 95000, 0.0123, 0);
    gift("2025-05-15", 1000);

    const plan = planGiftMonthRestatement(db, { runDate: RUN });
    expect(plan.rows.find((r) => r.snapshotId === odd)?.state).toBe("blocked");
    expect(() => runGiftMonthRestatement(db, { apply: true, runDate: RUN })).toThrow(/blocked/);
    expect(row(ok).twr).toBe(-0.05);
    expect(row(odd).twr).toBe(0.0123);
  });

  it("refuses a gift leg whose amount differs from the donation's value", () => {
    const { db, snapshot, gift } = setup();
    snapshot("2025-03-31", null, 100000, 0, 0);
    snapshot("2025-04-30", 100000, 95000, -0.05, -5000);
    const t = gift("2025-04-15", 5000);
    db.prepare("UPDATE transactions SET amount = 4000 WHERE id = ?").run(t);

    const plan = planGiftMonthRestatement(db, { runDate: RUN });
    expect(plan.rows[0].state).toBe("blocked");
    expect(plan.rows[0].reason).toMatch(/donation's value/);
  });
});
