/**
 * Plan v4 (Plaid session dating), ruling E1 / unit U3: a Plaid snapshot is
 * the PREVIOUS session's close, so it is never an account's "live" current
 * value. Only a TWS snapshot dated within the live window is. A Vanguard
 * account reads its daily valuation, and the readers report three dates
 * separately: the valuation row, the holdings session and the anchor.
 *
 * Both readers are checked: getAccountSummaries and getPortfolioCurrentValues
 * (which feeds the Today strip, the chat summary and the exposure base).
 * Synthetic securities and round invented figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getAccountSummaries,
  getPortfolioCurrentValues,
  getPortfolioTotals,
} from "@/lib/queries/dashboard";
import {
  currentValueLiveSnapshotSql,
  onlyLiveSnapshotsSql,
} from "@/lib/db/live-sources";
import { accountValueCaption } from "@/app/dashboard/today/basis-labels";

let db: Database.Database;
let VG: number;
let IB: number;

function accountId(name: string): number {
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function security(symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')")
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function snapshot(account: number, date: string, total: number, source: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, ?)`,
  ).run(account, date, total, source);
}

function valuation(account: number, date: string, total: number): void {
  db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value, data_quality)
     VALUES (?, ?, 0, ?, ?, 'estimated')`,
  ).run(account, date, total, total);
}

function holding(account: number, sec: number, date: string, key: string, quantity = 10): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(account, sec, quantity, date, key);
}

function freeze(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  VG = accountId("Vanguard Taxable");
  IB = accountId("IBKR");
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

/**
 * A Vanguard book read before today's open: Plaid snapshot and holdings on
 * the previous session S, a legacy-style Plaid snapshot on the run day too
 * (the old dating), daily valuations on S and today; IBKR with a TWS
 * snapshot today.
 */
function seedBook(today: string, session: string): void {
  const a = security("FAKE1");
  snapshot(VG, "2026-02-27", 100000, "vanguard-pdf");
  holding(VG, a, "2026-02-27", "vanguard-pdf:holding:FAKE1:2026-02-27");
  snapshot(VG, session, 120000, "plaid");
  holding(VG, a, session, `plaid:s:${VG}:${a}:${session}`);
  valuation(VG, session, 120000);
  valuation(VG, today, 121000);

  snapshot(IB, "2026-02-27", 40000, "ibkr-activity");
  snapshot(IB, today, 50000, "tws");
  valuation(IB, today, 49000);
}

describe.each([
  { label: "weekday", now: "2026-03-18T19:00:00Z", today: "2026-03-18", session: "2026-03-17" },
  { label: "Monday", now: "2026-03-16T19:00:00Z", today: "2026-03-16", session: "2026-03-13" },
])("live pick on a $label", ({ now, today, session }) => {
  beforeEach(() => freeze(now));

  it("a same-day TWS snapshot is the live pick in both readers", () => {
    seedBook(today, session);
    const values = getPortfolioCurrentValues(db);
    const ib = values.accounts.find((x) => x.accountId === IB)!;
    expect(ib).toMatchObject({ currentValue: 50000, asOfDate: today, sourceKind: "live" });

    const summary = getAccountSummaries(db).find((x) => x.id === IB)!;
    expect(summary).toMatchObject({ latestValue: 50000, latestDate: today, dataSource: "tws_live", dataQuality: "live" });
  });

  it("a Plaid snapshot is never the live pick, in either reader, whether dated on the session or the run day", () => {
    seedBook(today, session);
    // The legacy dating put the snapshot on the run day: still not live.
    snapshot(VG, today, 130000, "plaid");

    const values = getPortfolioCurrentValues(db);
    const vg = values.accounts.find((x) => x.accountId === VG)!;
    expect(vg.sourceKind).toBe("daily");
    expect(vg.currentValue).toBe(121000);
    expect(vg.asOfDate).toBe(today);
    expect(values.totalValue).toBe(121000 + 50000);
    expect(getPortfolioTotals(db).totalValue).toBe(121000 + 50000);

    const summary = getAccountSummaries(db).find((x) => x.id === VG)!;
    expect(summary.dataSource).toBeNull();
    expect(summary.dataQuality).toBe("estimated");
    expect(summary.latestValue).toBe(121000);
    expect(summary.latestDate).toBe(today);
  });

  it("a Vanguard account reports the valuation date, holdings session and anchor session separately", () => {
    seedBook(today, session);
    const expected = {
      valuationDate: today,
      holdingsSession: session,
      holdingsSource: "plaid",
      anchorSession: session,
      anchorSource: "plaid",
    };
    expect(getPortfolioCurrentValues(db).accounts.find((x) => x.accountId === VG)).toMatchObject(expected);
    expect(getAccountSummaries(db).find((x) => x.id === VG)).toMatchObject(expected);
    expect(getPortfolioTotals(db).accounts.find((x) => x.accountId === VG)).toMatchObject(expected);
    // IBKR's anchor is its TWS snapshot.
    expect(getPortfolioCurrentValues(db).accounts.find((x) => x.accountId === IB)).toMatchObject({
      anchorSession: today,
      anchorSource: "tws",
    });
  });
});

describe("the three dates", () => {
  beforeEach(() => freeze("2026-03-18T19:00:00Z"));

  it("a recon tombstone never dates the holdings session", () => {
    seedBook("2026-03-18", "2026-03-17");
    const b = security("FAKE2");
    holding(VG, b, "2026-03-18", `recon:closed-equity:${VG}:${b}:2026-03-18:live`, 0);
    const vg = getPortfolioCurrentValues(db).accounts.find((x) => x.accountId === VG)!;
    expect(vg.holdingsSession).toBe("2026-03-17");
    expect(vg.holdingsSource).toBe("plaid");
  });

  it("a statement row on the newest holdings date makes the source a statement", () => {
    const a = security("FAKE1");
    const b = security("FAKE2");
    snapshot(VG, "2026-02-27", 100000, "vanguard-pdf");
    holding(VG, a, "2026-02-27", "vanguard-pdf:holding:FAKE1:2026-02-27");
    holding(VG, b, "2026-02-27", `plaid:s:${VG}:${b}:2026-02-27`);
    valuation(VG, "2026-03-18", 101000);
    const vg = getPortfolioCurrentValues(db).accounts.find((x) => x.accountId === VG)!;
    expect(vg).toMatchObject({
      holdingsSession: "2026-02-27",
      holdingsSource: "statement",
      anchorSession: "2026-02-27",
      anchorSource: "statement",
      valuationDate: "2026-03-18",
    });
  });

  it("an account with nothing on record has no dates", () => {
    const vg = getPortfolioCurrentValues(db, [VG]).accounts[0];
    expect(vg).toMatchObject({
      currentValue: null,
      sourceKind: null,
      valuationDate: null,
      holdingsSession: null,
      holdingsSource: null,
      anchorSession: null,
      anchorSource: null,
    });
  });

  it("an empty scope reads nothing", () => {
    expect(getPortfolioCurrentValues(db, []).accounts).toEqual([]);
  });
});

describe("captions read from the readers", () => {
  beforeEach(() => freeze("2026-03-18T19:00:00Z"));

  it("a valuation dated after the Plaid anchor is never captioned as a Plaid close", () => {
    seedBook("2026-03-18", "2026-03-17");
    const vg = getPortfolioCurrentValues(db).accounts.find((x) => x.accountId === VG)!;
    const caption = accountValueCaption(vg, "2026-03-18")!;
    expect(caption).toBe("Positions from the Mar 17 close (Plaid). Valued Mar 18 at the latest prices.");
    expect(caption).not.toContain("Mar 18 close");
  });

  it("A8: a valuation older than the Plaid anchor says the value is not yet updated", () => {
    const a = security("FAKE1");
    snapshot(VG, "2026-02-27", 100000, "vanguard-pdf");
    valuation(VG, "2026-03-16", 118000);
    // The Plaid book for the Mar 17 close is stored, but the recompute failed.
    snapshot(VG, "2026-03-17", 120000, "plaid");
    holding(VG, a, "2026-03-17", `plaid:s:${VG}:${a}:2026-03-17`);

    const vg = getPortfolioCurrentValues(db).accounts.find((x) => x.accountId === VG)!;
    // The value stays the daily valuation; the Plaid total is never used.
    expect(vg).toMatchObject({ sourceKind: "daily", currentValue: 118000, valuationDate: "2026-03-16" });
    expect(accountValueCaption(vg, "2026-03-18")).toBe(
      "Positions from the Mar 17 close (Plaid). Value not yet updated for the Mar 17 close.",
    );
  });
});

describe("live-source fragments", () => {
  it("the current-value live pick is TWS only; the history fragment still covers both", () => {
    expect(currentValueLiveSnapshotSql("ms.source")).toBe("ms.source IN ('tws')");
    expect(currentValueLiveSnapshotSql()).toBe("source IN ('tws')");
    expect(onlyLiveSnapshotsSql("ms.source")).toBe("ms.source IN ('tws','plaid')");
  });
});
