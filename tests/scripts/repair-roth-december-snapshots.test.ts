/**
 * Synthetic figures only (the repo is public). The real figures live in the
 * gitignored data/repair-configs/roth-december-snapshots.json.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTwr } from "@/lib/compute/twr";
import {
  parseRepairConfig,
  planRothDecemberRepair,
  runRothDecemberRepair,
  type RepairConfig,
} from "@/scripts/repair-roth-december-snapshots";

const ACCOUNT = "Vanguard Roth IRA";
const TODAY = "2026-01-15";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function accountId(db: Database.Database, name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seed(
  db: Database.Database,
  acct: number,
  date: string,
  v: {
    total: number;
    start?: number | null;
    dw?: number | null;
    twr?: number | null;
    gain?: number | null;
    div?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO monthly_snapshots
       (account_id, month_end_date, total_value, starting_value, deposits_withdrawals,
        twr, investment_gain, dividends, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'canonical')`,
  ).run(acct, date, v.total, v.start ?? null, v.dw ?? null, v.twr ?? null, v.gain ?? null, v.div ?? null);
}

/** Two broken Decembers: one with starting_value NULL, one with the year-start value. */
function config(): RepairConfig {
  return parseRepairConfig({
    accountName: ACCOUNT,
    rows: [
      {
        monthEndDate: "2024-12-31",
        before: {
          total_value: 10300,
          starting_value: null,
          deposits_withdrawals: 1200,
          twr: null,
          investment_gain: null,
          dividends: 150,
        },
        after: {
          starting_value: 10000,
          deposits_withdrawals: 100,
          twr: 0.02,
          investment_gain: 200,
          dividends: null,
        },
      },
      {
        monthEndDate: "2025-12-31",
        before: {
          total_value: 20500,
          starting_value: 10300,
          deposits_withdrawals: 900,
          twr: null,
          investment_gain: 9300,
          dividends: 160,
        },
        after: {
          starting_value: 20000,
          deposits_withdrawals: 100,
          twr: 0.02,
          investment_gain: 400,
          dividends: null,
        },
      },
    ],
  });
}

function snapshotDigest(db: Database.Database): string {
  return JSON.stringify(
    db
      .prepare(
        `SELECT account_id, month_end_date, total_value, starting_value, deposits_withdrawals,
                twr, investment_gain, dividends, notes
           FROM monthly_snapshots ORDER BY account_id, month_end_date`,
      )
      .all(),
  );
}

describe("repair-roth-december-snapshots", () => {
  let db: Database.Database;
  let roth: number;
  let other: number;

  beforeEach(() => {
    db = createDb();
    roth = accountId(db, ACCOUNT);
    other = accountId(db, "Vanguard Taxable");
    seed(db, roth, "2024-11-30", { total: 10000, start: 9800, dw: 100, twr: 0.010204, gain: 100 });
    seed(db, roth, "2024-12-31", { total: 10300, dw: 1200, div: 150 });
    seed(db, roth, "2025-11-30", { total: 20000, start: 19800, dw: 100, twr: 0.005051, gain: 100 });
    seed(db, roth, "2025-12-31", { total: 20500, start: 10300, dw: 900, gain: 9300, div: 160 });
    // An unrelated account's December row must never change.
    seed(db, other, "2024-12-31", { total: 5000, dw: 700, div: 10 });
  });

  it("the dry run plans both rows and writes nothing", () => {
    const before = snapshotDigest(db);
    const result = runRothDecemberRepair(db, config(), { apply: false, today: TODAY });
    expect(result.plan.refusals).toEqual([]);
    expect(result.plan.rows.map((r) => r.state)).toEqual(["needs-repair", "needs-repair"]);
    expect(result.updated).toBe(0);
    expect(snapshotDigest(db)).toBe(before);
  });

  it("apply writes the December-only figures, keeps total_value, and appends a note", () => {
    const result = runRothDecemberRepair(db, config(), { apply: true, today: TODAY });
    expect(result.updated).toBe(2);
    const row = db
      .prepare(
        `SELECT total_value, starting_value, deposits_withdrawals, twr, investment_gain, dividends, notes
           FROM monthly_snapshots WHERE account_id = ? AND month_end_date = '2024-12-31'`,
      )
      .get(roth) as Record<string, number | string | null>;
    expect(row).toMatchObject({
      total_value: 10300,
      starting_value: 10000,
      deposits_withdrawals: 100,
      twr: 0.02,
      investment_gain: 200,
      dividends: null,
    });
    expect(String(row.notes)).toContain(`repaired ${TODAY}`);
    const untouched = db
      .prepare(`SELECT deposits_withdrawals, dividends FROM monthly_snapshots WHERE account_id = ?`)
      .get(other);
    expect(untouched).toEqual({ deposits_withdrawals: 700, dividends: 10 });
  });

  it("a second run is a no-op", () => {
    runRothDecemberRepair(db, config(), { apply: true, today: TODAY });
    const afterFirst = snapshotDigest(db);
    const second = runRothDecemberRepair(db, config(), { apply: true, today: "2026-02-01" });
    expect(second.plan.rows.map((r) => r.state)).toEqual(["already-repaired", "already-repaired"]);
    expect(second.updated).toBe(0);
    expect(snapshotDigest(db)).toBe(afterFirst);
  });

  it("refuses the whole run, writing nothing, when one row is not in its expected before-state", () => {
    db.prepare(
      `UPDATE monthly_snapshots SET deposits_withdrawals = 950 WHERE account_id = ? AND month_end_date = '2025-12-31'`,
    ).run(roth);
    const before = snapshotDigest(db);
    expect(() => runRothDecemberRepair(db, config(), { apply: true, today: TODAY })).toThrow(
      /2025-12-31: row matches neither/,
    );
    expect(snapshotDigest(db)).toBe(before);
  });

  it("refuses after-figures that do not add up against the row and the prior month", () => {
    const cfg = config();
    cfg.rows[0].after.twr = 0.03; // not gain / start
    cfg.rows[1].after.starting_value = 19000; // not the prior month-end total
    const plan = planRothDecemberRepair(db, cfg);
    expect(plan.refusals.some((r) => r.includes("2024-12-31: after.twr"))).toBe(true);
    expect(plan.refusals.some((r) => r.includes("2025-12-31: after.starting_value"))).toBe(true);
    const before = snapshotDigest(db);
    expect(() => runRothDecemberRepair(db, cfg, { apply: true, today: TODAY })).toThrow(/refusing/);
    expect(snapshotDigest(db)).toBe(before);
  });

  it("refuses an unknown account name", () => {
    const cfg = { ...config(), accountName: "No Such Account" };
    expect(planRothDecemberRepair(db, cfg).refusals[0]).toMatch(/no account named exactly/);
  });

  it("the config parser rejects a non-December row and a written total_value", () => {
    const base = JSON.parse(JSON.stringify(config()));
    base.rows[0].monthEndDate = "2024-11-30";
    expect(() => parseRepairConfig(base)).toThrow(/December month-end/);
    const withTotal = JSON.parse(JSON.stringify(config()));
    withTotal.rows[0].after.total_value = 1;
    expect(() => parseRepairConfig(withTotal)).toThrow(/total_value is never written/);
  });

  it("after the repair the TWR chain reads December as an ordinary month", () => {
    const broken = computeTwr(db, { startDate: "2024-12-01", endDate: "2024-12-31", accountId: roth });
    runRothDecemberRepair(db, config(), { apply: true, today: TODAY });
    const repaired = computeTwr(db, { startDate: "2024-12-01", endDate: "2024-12-31", accountId: roth });
    expect(repaired?.totalReturn).toBeCloseTo(0.02, 6);
    // Before the repair a year of contributions was read as one December flow.
    expect(broken?.totalReturn ?? 0).toBeLessThan(repaired!.totalReturn);
  });
});
