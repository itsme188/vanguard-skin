import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  reconcileEarningsDates,
  repointDependentsBeforeDelete,
} from "@/lib/calendar/reconcile-earnings-dates";

/**
 * Owner ruling 2026-10-06
 * [qa:dashboard-today-earningshub-refresh-from-finnhub-refresh-silently-supersedes-a-user-added-earnings-row-the-hub]
 *
 *  1. The reconciler never supersedes a hand-entered row against another
 *     hand-entered row. Two dates the user typed for one name both stay
 *     visible; choosing between them is the user's call (delete one).
 *  2. Every row a pass DOES hide is reported back (`result.superseded`) with a
 *     short reason, so the refresh outcome line can name it.
 *
 * Vendor-vs-vendor and manual-vs-vendor resolution is unchanged.
 *
 * Fixtures are synthetic (ZZ* tickers, round numbers).
 */

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const TODAY = "2026-06-08";

interface SeedRow {
  source: string;
  symbol: string;
  date: string;
  dateStatus?: string | null;
  superseded?: number;
  actualValue?: string | null;
  manualActualsAt?: string | null;
}

function seed(r: SeedRow): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, date_status, superseded,
          actual_value, manual_actuals_at, raw_json)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    )
    .run(
      r.source,
      r.date,
      `${r.symbol} earnings`,
      r.symbol,
      `${r.source}:${r.symbol}:${r.date}`,
      r.dateStatus ?? null,
      r.superseded ?? 0,
      r.actualValue ?? null,
      r.manualActualsAt ?? null,
    ).lastInsertRowid as number;
}

function row(id: number) {
  return db
    .prepare(
      "SELECT date_status, superseded, actual_value, manual_actuals_at FROM calendar_events WHERE id = ?",
    )
    .get(id) as {
    date_status: string | null;
    superseded: number;
    actual_value: string | null;
    manual_actuals_at: string | null;
  };
}

describe("reconcileEarningsDates — two hand-entered rows for one name", () => {
  it("keeps both rows visible and supersedes neither", () => {
    const wed = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    const thu = seed({ source: "manual", symbol: "ZZA", date: "2026-06-11" });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(wed).superseded).toBe(0);
    expect(row(thu).superseded).toBe(0);
    expect(row(wed).date_status).toBe("user_confirmed");
    expect(row(thu).date_status).toBe("user_confirmed");
    expect(result.superseded).toEqual([]);
  });

  it("does not copy one hand-entered row's actual onto the other", () => {
    const wed = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    const thu = seed({
      source: "manual",
      symbol: "ZZA",
      date: "2026-06-11",
      actualValue: "EPS 1.00",
      manualActualsAt: "2026-06-08 12:00:00",
    });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(wed).actual_value).toBeNull();
    expect(row(wed).manual_actuals_at).toBeNull();
    expect(row(thu).actual_value).toBe("EPS 1.00");
    expect(row(thu).superseded).toBe(0);
  });

  it("brings back a hand-entered row an earlier pass had hidden behind its hand-entered twin", () => {
    const wed = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10", dateStatus: "user_confirmed" });
    const thu = seed({ source: "manual", symbol: "ZZA", date: "2026-06-11", superseded: 1 });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(wed).superseded).toBe(0);
    expect(row(thu).superseded).toBe(0);
    expect(result.superseded).toEqual([]);
  });

  it("still supersedes the vendor rows around two hand-entered rows, and names them", () => {
    const wed = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    const thu = seed({ source: "manual", symbol: "ZZA", date: "2026-06-11" });
    const vendor = seed({ source: "finnhub", symbol: "ZZA", date: "2026-06-12" });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(wed).superseded).toBe(0);
    expect(row(thu).superseded).toBe(0);
    expect(row(vendor).superseded).toBe(1);
    expect(result.superseded.map((s) => s.eventId)).toEqual([vendor]);
  });

  it("is idempotent — a second pass changes nothing and reports nothing", () => {
    const wed = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    const thu = seed({ source: "manual", symbol: "ZZA", date: "2026-06-11" });
    seed({ source: "finnhub", symbol: "ZZA", date: "2026-06-12" });

    reconcileEarningsDates(db, { today: TODAY });
    const second = reconcileEarningsDates(db, { today: TODAY });

    expect(second.superseded).toEqual([]);
    expect(row(wed).superseded).toBe(0);
    expect(row(thu).superseded).toBe(0);
  });

  it("does not touch another name's rows", () => {
    seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    seed({ source: "manual", symbol: "ZZA", date: "2026-06-11" });
    const other = seed({ source: "finnhub", symbol: "ZZB", date: "2026-06-10" });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(other).superseded).toBe(0);
    expect(row(other).date_status).toBe("single");
    expect(result.superseded).toEqual([]);
  });
});

describe("reconcileEarningsDates — hand-entered vs vendor is unchanged", () => {
  it("a hand-entered row still wins its cluster and the vendor row is superseded", () => {
    const manual = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    const vendor = seed({ source: "finnhub", symbol: "ZZA", date: "2026-06-12" });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(manual).superseded).toBe(0);
    expect(row(manual).date_status).toBe("user_confirmed");
    expect(row(vendor).superseded).toBe(1);
    expect(result.userConfirmed).toBe(1);
    expect(result.superseded).toEqual([
      {
        eventId: vendor,
        sourceKey: "finnhub:ZZA:2026-06-12",
        symbol: "ZZA",
        title: "ZZA earnings",
        eventDate: "2026-06-12",
        source: "finnhub",
        reason: "the date you entered (2026-06-10) takes its place",
      },
    ]);
  });

  it("a vendor row the user confirmed still supersedes a later hand-entered row", () => {
    // Unchanged rung 1: the first user-confirmed / hand-entered row by date is
    // the locked canonical. Only hand-entered vs hand-entered is exempt.
    const confirmedVendor = seed({
      source: "nasdaq",
      symbol: "ZZA",
      date: "2026-06-10",
      dateStatus: "user_confirmed",
    });
    const manual = seed({ source: "manual", symbol: "ZZA", date: "2026-06-11" });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(confirmedVendor).superseded).toBe(0);
    expect(row(manual).superseded).toBe(1);
    expect(result.superseded.map((s) => s.reason)).toEqual([
      "the date you confirmed (2026-06-10) takes its place",
    ]);
  });
});

describe("reconcileEarningsDates — reports every row a pass hides", () => {
  it("names the losing vendor row of a vendor-vs-vendor date conflict", () => {
    const finnhub = seed({ source: "finnhub", symbol: "ZZA", date: "2026-06-10" });
    const nasdaq = seed({ source: "nasdaq", symbol: "ZZA", date: "2026-06-12" });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(nasdaq).superseded).toBe(0);
    expect(row(nasdaq).date_status).toBe("conflict");
    expect(row(finnhub).superseded).toBe(1);
    expect(result.superseded).toEqual([
      {
        eventId: finnhub,
        sourceKey: "finnhub:ZZA:2026-06-10",
        symbol: "ZZA",
        title: "ZZA earnings",
        eventDate: "2026-06-10",
        source: "finnhub",
        reason: "Nasdaq lists 2026-06-12 instead; that date shows until you confirm one",
      },
    ]);
  });

  it("names a same-date vendor duplicate as the same event", () => {
    seed({ source: "finnhub", symbol: "ZZA", date: "2026-06-10" });
    const nasdaq = seed({ source: "nasdaq", symbol: "ZZA", date: "2026-06-10" });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(result.superseded).toEqual([
      expect.objectContaining({
        eventId: nasdaq,
        reason: "same event as the Finnhub row for that date",
      }),
    ]);
  });

  it("does not report a row that was already hidden before the pass", () => {
    seed({ source: "finnhub", symbol: "ZZA", date: "2026-06-10" });
    seed({ source: "nasdaq", symbol: "ZZA", date: "2026-06-12" });

    reconcileEarningsDates(db, { today: TODAY });
    const second = reconcileEarningsDates(db, { today: TODAY });

    expect(second.superseded).toEqual([]);
  });
});

describe("repointDependentsBeforeDelete — hand-entered twins", () => {
  it("hands a deleted row's bogeys to the nearest hand-entered row that stays visible", () => {
    seed({ source: "manual", symbol: "ZZA", date: "2026-06-09" });
    const doomed = seed({ source: "manual", symbol: "ZZA", date: "2026-06-11" });
    const near = seed({ source: "manual", symbol: "ZZA", date: "2026-06-12" });
    db.prepare(
      "INSERT INTO earnings_bogeys (event_id, source, eps_consensus) VALUES (?, 'manual', 1)",
    ).run(doomed);

    const handed = repointDependentsBeforeDelete(db, { eventId: doomed, today: TODAY });

    expect(handed.targetId).toBe(near);
    expect(handed.bogeys).toBe(1);
  });
});
