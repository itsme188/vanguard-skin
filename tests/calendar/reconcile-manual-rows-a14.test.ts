import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileEarningsDates, createTwinFolder } from "@/lib/calendar/reconcile-earnings-dates";
import { confirmEarningsDate } from "@/lib/mutations/confirm-earnings-date";

/**
 * Unit A14 — calendar sync and hand-entered rows.
 *
 * [qa:today-earningshub-refresh--stamps-user-confirmed-on-every-manual-row]
 * Owner ruling 2026-09-14: a sync never asserts a human confirmation. A
 * hand-entered row still LOCKS its cluster (that is a property of its source),
 * but `date_status = 'user_confirmed'` is written only by the confirm-date
 * route. The reconciler keeps the stamp on a row that already carries it and
 * never puts it on a row that does not.
 *
 * [qa:today-week-ahead--duplicate-manual-and-feed-cards-same-print-regression-1]
 * Owner rulings 2026-08-15 (one of the pair is superseded) and 2026-10-02 (a
 * same-date hand-entered row IS the print): the hand-entered row stays, the
 * feed row is hidden and folded into it.
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
  consensus?: string | null;
  createdAt?: string;
}

function seed(r: SeedRow): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, date_status, superseded,
          actual_value, consensus_estimate, raw_json, created_at)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
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
      r.consensus ?? null,
      r.createdAt ?? "2026-06-01 12:00:00",
    ).lastInsertRowid as number;
}

function row(id: number) {
  return db
    .prepare(
      "SELECT date_status, superseded, actual_value, consensus_estimate FROM calendar_events WHERE id = ?",
    )
    .get(id) as {
    date_status: string | null;
    superseded: number;
    actual_value: string | null;
    consensus_estimate: string | null;
  };
}

describe("a sync never asserts a human confirmation", () => {
  it("leaves a lone hand-entered row unstamped", () => {
    const manual = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(manual).date_status).toBeNull();
    expect(row(manual).superseded).toBe(0);
    expect(result.userConfirmed).toBe(0);
    expect(result.handEntered).toBe(1);
  });

  it("does not stamp hand-entered rows outside the week being looked at, pass after pass", () => {
    const near = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    const far = seed({ source: "manual", symbol: "ZZB", date: "2026-06-24" });

    reconcileEarningsDates(db, { today: TODAY });
    reconcileEarningsDates(db, { today: TODAY });

    expect(row(near).date_status).toBeNull();
    expect(row(far).date_status).toBeNull();
  });

  it("an unstamped hand-entered row still locks its cluster against the vendor date", () => {
    const manual = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    const vendor = seed({ source: "finnhub", symbol: "ZZA", date: "2026-06-12" });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(manual).superseded).toBe(0);
    expect(row(manual).date_status).toBeNull();
    expect(row(vendor).superseded).toBe(1);
    expect(result.superseded.map((s) => s.reason)).toEqual([
      "the date you entered (2026-06-10) takes its place",
    ]);
    // A second pass changes nothing and still does not stamp.
    const again = reconcileEarningsDates(db, { today: TODAY });
    expect(again.superseded).toEqual([]);
    expect(row(manual).date_status).toBeNull();
    expect(row(vendor).superseded).toBe(1);
  });

  it("keeps a confirmation the confirm-date route wrote", () => {
    const vendor = seed({ source: "finnhub", symbol: "ZZA", date: "2026-06-12" });
    const outcome = confirmEarningsDate(db, {
      symbol: "ZZA",
      confirmedDate: "2026-06-10",
      confirmedTime: null,
      today: TODAY,
    });
    expect(outcome.ok).toBe(true);

    // The whole-book pass a refresh runs, twice.
    reconcileEarningsDates(db, { today: TODAY });
    const result = reconcileEarningsDates(db, { today: TODAY });

    const confirmed = db
      .prepare(
        "SELECT date_status, superseded FROM calendar_events WHERE source = 'manual' AND symbol = 'ZZA'",
      )
      .get() as { date_status: string | null; superseded: number };
    expect(confirmed).toEqual({ date_status: "user_confirmed", superseded: 0 });
    expect(row(vendor).superseded).toBe(1);
    expect(result.userConfirmed).toBe(1);
    expect(result.handEntered).toBe(0);
  });

  it("two hand-entered rows: the confirmed one keeps its stamp, the other gets none", () => {
    const typed = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    const confirmed = seed({
      source: "manual",
      symbol: "ZZA",
      date: "2026-06-11",
      dateStatus: "user_confirmed",
    });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(typed).superseded).toBe(0);
    expect(row(confirmed).superseded).toBe(0);
    expect(row(typed).date_status).toBeNull();
    expect(row(confirmed).date_status).toBe("user_confirmed");
    expect(result.userConfirmed).toBe(1);
    expect(result.handEntered).toBe(1);
  });

  it("a hidden hand-entered twin that comes back is not stamped", () => {
    const wed = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    const thu = seed({ source: "manual", symbol: "ZZA", date: "2026-06-11", superseded: 1 });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(result.restored.map((r) => r.eventId)).toEqual([thu]);
    expect(row(thu).superseded).toBe(0);
    expect(row(wed).date_status).toBeNull();
    expect(row(thu).date_status).toBeNull();
  });

  it("a hidden hand-entered twin that was confirmed comes back still confirmed", () => {
    // Hiding a row used to clear its status, and the pass no longer re-stamps
    // a restored twin, so the person's confirmation would be lost for good.
    const wed = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    const thu = seed({
      source: "manual",
      symbol: "ZZA",
      date: "2026-06-11",
      superseded: 1,
      dateStatus: "user_confirmed",
    });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(result.restored.map((r) => r.eventId)).toEqual([thu]);
    expect(row(thu).superseded).toBe(0);
    expect(row(thu).date_status).toBe("user_confirmed");
    expect(row(wed).date_status).toBeNull();
  });

  it("hiding a row keeps a hand-entered confirmation and clears any other status", () => {
    const manual = seed({ source: "manual", symbol: "ZZB", date: "2026-06-10", dateStatus: "user_confirmed" });
    const vendor = seed({ source: "finnhub", symbol: "ZZC", date: "2026-06-10", dateStatus: "user_confirmed" });
    const fold = createTwinFolder(db);
    const keepM = seed({ source: "manual", symbol: "ZZB", date: "2026-06-12" });
    const keepV = seed({ source: "manual", symbol: "ZZC", date: "2026-06-12" });
    const donor = (id: number) =>
      db
        .prepare(
          `SELECT id, consensus_estimate, consensus_value, actual_value, manual_actuals_at,
                  reaction_snapshot, enriched_at FROM calendar_events WHERE id = ?`,
        )
        .get(id) as Parameters<typeof fold>[0];
    db.transaction(() => {
      fold(donor(manual), keepM, "2026-06-12");
      fold(donor(vendor), keepV, "2026-06-12");
    })();
    expect(row(manual).superseded).toBe(1);
    expect(row(manual).date_status).toBe("user_confirmed");
    expect(row(vendor).superseded).toBe(1);
    expect(row(vendor).date_status).toBeNull();
  });

  it("a vendor row the user confirmed in place keeps its stamp and its lock", () => {
    const confirmedVendor = seed({
      source: "nasdaq",
      symbol: "ZZA",
      date: "2026-06-10",
      dateStatus: "user_confirmed",
    });
    const other = seed({ source: "finnhub", symbol: "ZZA", date: "2026-06-12" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(confirmedVendor).date_status).toBe("user_confirmed");
    expect(row(confirmedVendor).superseded).toBe(0);
    expect(row(other).superseded).toBe(1);
  });

  it("vendor trust statuses are still written", () => {
    const finnhub = seed({ source: "finnhub", symbol: "ZZA", date: "2026-06-10" });
    seed({ source: "nasdaq", symbol: "ZZA", date: "2026-06-10" });
    const lone = seed({ source: "finnhub", symbol: "ZZB", date: "2026-06-10" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(finnhub).date_status).toBe("confirmed");
    expect(row(lone).date_status).toBe("single");
  });
});

describe("a feed row on the same symbol and date as a hand-entered row", () => {
  it("upcoming print: the hand-entered row stays, the feed row is hidden, its consensus carries over", () => {
    const manual = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    // The feed row arrives later (higher id), as in the filed pair.
    const feed = seed({ source: "nasdaq", symbol: "ZZA", date: "2026-06-10", consensus: "EPS 1.00" });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(manual).superseded).toBe(0);
    expect(row(feed).superseded).toBe(1);
    expect(row(manual).consensus_estimate).toBe("EPS 1.00");
    expect(result.superseded.map((s) => [s.eventId, s.reason])).toEqual([
      [feed, "the date you entered (2026-06-10) takes its place"],
    ]);
  });

  it("the feed row landing first makes no difference", () => {
    const feed = seed({ source: "finnhub", symbol: "ZZA", date: "2026-06-10" });
    const manual = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(manual).superseded).toBe(0);
    expect(row(feed).superseded).toBe(1);
  });

  it("both feeds on the date: one visible row, the hand-entered one", () => {
    const manual = seed({ source: "manual", symbol: "ZZA", date: "2026-06-10" });
    const finnhub = seed({ source: "finnhub", symbol: "ZZA", date: "2026-06-10" });
    const nasdaq = seed({ source: "nasdaq", symbol: "ZZA", date: "2026-06-10" });

    reconcileEarningsDates(db, { today: TODAY });

    const visible = db
      .prepare(
        "SELECT id FROM calendar_events WHERE symbol = 'ZZA' AND COALESCE(superseded, 0) = 0",
      )
      .all() as { id: number }[];
    expect(visible.map((r) => r.id)).toEqual([manual]);
    expect(row(finnhub).superseded).toBe(1);
    expect(row(nasdaq).superseded).toBe(1);
  });

  it("reported print typed BEFORE the print (the filed shape): hand-entered row stays and takes the actual", () => {
    // 2026-10-02 ruling: same date = the print, whatever the creation time.
    const manual = seed({
      source: "manual",
      symbol: "ZZA",
      date: "2026-06-02",
      createdAt: "2026-05-31 21:25:00",
    });
    const feed = seed({
      source: "nasdaq",
      symbol: "ZZA",
      date: "2026-06-02",
      actualValue: "EPS 1.10",
      createdAt: "2026-05-31 21:32:00",
    });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(manual).superseded).toBe(0);
    expect(row(feed).superseded).toBe(1);
    expect(row(manual).actual_value).toBe("EPS 1.10");
    // The feed row keeps its own copy: nothing is deleted or blanked.
    expect(row(feed).actual_value).toBe("EPS 1.10");
  });

  it("the sent recap follows the print onto the hand-entered row; nothing is lost", () => {
    const manual = seed({ source: "manual", symbol: "ZZA", date: "2026-06-02" });
    const feed = seed({
      source: "finnhub",
      symbol: "ZZA",
      date: "2026-06-02",
      actualValue: "EPS 1.10",
    });
    db.prepare(
      "INSERT INTO earnings_emails (event_id, phase, recipient, sent_at) VALUES (?, 'recap', 'desk@example.com', '2026-06-03 12:00:00')",
    ).run(feed);

    reconcileEarningsDates(db, { today: TODAY });

    const emails = db
      .prepare("SELECT event_id, phase FROM earnings_emails ORDER BY id")
      .all() as { event_id: number; phase: string }[];
    expect(emails).toEqual([{ event_id: manual, phase: "recap" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get()).toEqual({ n: 2 });
  });
});
