/**
 * scripts/repair-manual-feed-earnings-pairs.ts: hide the feed copy of a print
 * that shows beside a hand-entered row on the same symbol and date.
 * [qa:today-week-ahead--duplicate-manual-and-feed-cards-same-print-regression-1]
 *
 * Tickers are synthetic (ZZ*); every figure is invented.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  planManualFeedPairRepair,
  runManualFeedPairRepair,
  formatPlan,
  parseArgs,
} from "@/scripts/repair-manual-feed-earnings-pairs";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// Far outside the reconciler's window around TODAY, like the filed pair.
const TODAY = "2026-10-07";
const OLD = "2026-07-28";

interface SeedRow {
  source: string;
  symbol: string;
  date: string;
  dateStatus?: string | null;
  superseded?: number;
  actualValue?: string | null;
  consensus?: string | null;
}

function seed(r: SeedRow): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, date_status, superseded,
          actual_value, consensus_estimate, raw_json)
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
      r.consensus ?? null,
    ).lastInsertRowid as number;
}

function email(eventId: number, phase: string, error: string | null = null): number {
  return db
    .prepare(
      "INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error) VALUES (?, ?, 'desk@example.com', '2026-07-29 12:00:00', ?)",
    )
    .run(eventId, phase, error).lastInsertRowid as number;
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

const dump = () => ({
  events: db.prepare("SELECT * FROM calendar_events ORDER BY id").all(),
  emails: db.prepare("SELECT * FROM earnings_emails ORDER BY id").all(),
  outbox: db.prepare("SELECT COUNT(*) AS n FROM cloud_outbox").get(),
});

describe("repair-manual-feed-earnings-pairs", () => {
  it("the reconciler never reaches a pair outside its window (why the script exists)", () => {
    const manual = seed({ source: "manual", symbol: "ZZA", date: OLD });
    const feed = seed({ source: "nasdaq", symbol: "ZZA", date: OLD });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(manual).superseded).toBe(0);
    expect(row(feed).superseded).toBe(0);
  });

  it("a dry run lists the pair and writes nothing", () => {
    const manual = seed({ source: "manual", symbol: "ZZA", date: OLD });
    const feed = seed({ source: "nasdaq", symbol: "ZZA", date: OLD, consensus: "EPS 1.00" });
    const before = dump();

    const result = runManualFeedPairRepair(db, {});

    expect(result.applied).toBe(false);
    expect(result.plan.pairs).toEqual([
      {
        symbol: "ZZA",
        eventDate: OLD,
        manualId: manual,
        feedRows: [{ id: feed, source: "nasdaq", emails: 0 }],
      },
    ]);
    expect(dump()).toEqual(before);
  });

  it("refuses to write without the acknowledgement", () => {
    seed({ source: "manual", symbol: "ZZA", date: OLD });
    seed({ source: "nasdaq", symbol: "ZZA", date: OLD });
    const before = dump();

    expect(() => runManualFeedPairRepair(db, { apply: true })).toThrow(/--acknowledge-repair/);
    expect(() => parseArgs(["--apply"])).toThrow(/--acknowledge-repair/);
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
    expect(parseArgs([])).toEqual({ apply: false, acknowledgeRepair: false });
    expect(dump()).toEqual(before);
  });

  it("apply hides the feed row, keeps the hand-entered row, fills only its empty columns", () => {
    const manual = seed({ source: "manual", symbol: "ZZA", date: OLD, consensus: "EPS 0.90" });
    const feed = seed({
      source: "nasdaq",
      symbol: "ZZA",
      date: OLD,
      consensus: "EPS 1.00",
      actualValue: "EPS 1.10",
      dateStatus: "single",
    });
    const bystander = seed({ source: "finnhub", symbol: "ZZB", date: OLD, dateStatus: "single" });

    const result = runManualFeedPairRepair(db, { apply: true, acknowledgeRepair: true, today: TODAY });

    expect(result.applied).toBe(true);
    expect(result.hidden).toBe(1);
    // Hand-entered row: still showing, its own value kept, the gap filled,
    // and no confirmation written.
    expect(row(manual)).toEqual({
      date_status: null,
      superseded: 0,
      actual_value: "EPS 1.10",
      consensus_estimate: "EPS 0.90",
    });
    // Feed row: hidden, never deleted, its own values intact.
    expect(row(feed)).toEqual({
      date_status: null,
      superseded: 1,
      actual_value: "EPS 1.10",
      consensus_estimate: "EPS 1.00",
    });
    expect(row(bystander)).toEqual({
      date_status: "single",
      superseded: 0,
      actual_value: null,
      consensus_estimate: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get()).toEqual({ n: 3 });
  });

  it("a confirmation already on the hand-entered row survives", () => {
    const manual = seed({ source: "manual", symbol: "ZZA", date: OLD, dateStatus: "user_confirmed" });
    seed({ source: "finnhub", symbol: "ZZA", date: OLD });

    runManualFeedPairRepair(db, { apply: true, acknowledgeRepair: true, today: TODAY });

    expect(row(manual).date_status).toBe("user_confirmed");
  });

  it("is idempotent", () => {
    seed({ source: "manual", symbol: "ZZA", date: OLD });
    seed({ source: "nasdaq", symbol: "ZZA", date: OLD });
    seed({ source: "finnhub", symbol: "ZZA", date: OLD });

    const first = runManualFeedPairRepair(db, { apply: true, acknowledgeRepair: true, today: TODAY });
    const after = dump();
    const second = runManualFeedPairRepair(db, { apply: true, acknowledgeRepair: true, today: TODAY });

    expect(first.hidden).toBe(2);
    expect(second.plan.pairs).toEqual([]);
    expect(second.hidden).toBe(0);
    expect(dump()).toEqual(after);
  });

  it("moves the sent-email record to the hand-entered row; a colliding one stays on the hidden row", () => {
    const manual = seed({ source: "manual", symbol: "ZZA", date: OLD });
    const feed = seed({ source: "finnhub", symbol: "ZZA", date: OLD, actualValue: "EPS 1.10" });
    const manualRecap = email(manual, "recap");
    const feedRecap = email(feed, "recap");
    const feedPreview = email(feed, "preview");

    const result = runManualFeedPairRepair(db, { apply: true, acknowledgeRepair: true, today: TODAY });

    expect(result.plan.pairs[0].feedRows).toEqual([{ id: feed, source: "finnhub", emails: 2 }]);
    const home = (id: number) =>
      (db.prepare("SELECT event_id FROM earnings_emails WHERE id = ?").get(id) as { event_id: number })
        .event_id;
    expect(home(manualRecap)).toBe(manual);
    expect(home(feedPreview)).toBe(manual);
    // A second delivered recap is a real delivery: kept, on the hidden row.
    expect(home(feedRecap)).toBe(feed);
    expect(db.prepare("SELECT COUNT(*) AS n FROM earnings_emails").get()).toEqual({ n: 3 });
  });

  it("skips, untouched: two hand-entered rows, a confirmed feed row, an email in flight", () => {
    // Two hand-entered rows on one date (distinct source keys).
    const twoA = seed({ source: "manual", symbol: "ZZA", date: OLD });
    const twoB = db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, raw_json)
         VALUES ('manual', 'earnings', ?, 'ZZA earnings', 'ZZA', 'manual:ZZA:moved', '{}')`,
      )
      .run(OLD).lastInsertRowid as number;
    const twoFeed = seed({ source: "nasdaq", symbol: "ZZA", date: OLD });

    const confManual = seed({ source: "manual", symbol: "ZZB", date: OLD });
    const confFeed = seed({ source: "nasdaq", symbol: "ZZB", date: OLD, dateStatus: "user_confirmed" });

    const flightManual = seed({ source: "manual", symbol: "ZZC", date: OLD });
    const flightFeed = seed({ source: "finnhub", symbol: "ZZC", date: OLD });
    email(flightFeed, "recap", "sending");
    const before = dump();

    const result = runManualFeedPairRepair(db, { apply: true, acknowledgeRepair: true, today: TODAY });

    expect(result.plan.pairs).toEqual([]);
    expect(result.plan.skipped).toEqual([
      { symbol: "ZZA", eventDate: OLD, manualIds: [twoA, twoB], feedIds: [twoFeed], reason: "several_hand_entered_rows" },
      { symbol: "ZZB", eventDate: OLD, manualIds: [confManual], feedIds: [confFeed], reason: "feed_row_user_confirmed" },
      { symbol: "ZZC", eventDate: OLD, manualIds: [flightManual], feedIds: [flightFeed], reason: "email_in_flight" },
    ]);
    expect(dump()).toEqual(before);
  });

  it("does not pair rows on different dates, hidden rows, or non-earnings rows", () => {
    seed({ source: "manual", symbol: "ZZA", date: OLD });
    seed({ source: "nasdaq", symbol: "ZZA", date: "2026-07-29" });
    seed({ source: "manual", symbol: "ZZB", date: OLD });
    seed({ source: "nasdaq", symbol: "ZZB", date: OLD, superseded: 1 });
    seed({ source: "manual", symbol: "ZZC", date: OLD, superseded: 1 });
    seed({ source: "nasdaq", symbol: "ZZC", date: OLD });
    seed({ source: "manual", symbol: "ZZD", date: OLD });
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
       VALUES ('wsh', 'analyst_meeting', ?, 'ZZD meeting', 'ZZD', 'wsh:ZZD:meeting')`,
    ).run(OLD);

    expect(planManualFeedPairRepair(db)).toEqual({ pairs: [], skipped: [] });
  });

  it("the printed plan carries ids, symbols and dates, and no stored figure", () => {
    const manual = seed({ source: "manual", symbol: "ZZA", date: OLD });
    const feed = seed({
      source: "nasdaq",
      symbol: "ZZA",
      date: OLD,
      consensus: "EPS 7.77",
      actualValue: "EPS 8.88",
    });

    const text = formatPlan(runManualFeedPairRepair(db, {})).join("\n");

    expect(text).toContain(`ZZA ${OLD}: hand-entered row ${manual} stays showing`);
    expect(text).toContain(`nasdaq row ${feed} would be hidden`);
    expect(text).not.toContain("7.77");
    expect(text).not.toContain("8.88");
  });
});
