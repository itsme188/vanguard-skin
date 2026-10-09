/**
 * The earnings reconciler honours suppressed dates.
 *
 * Removing a feed earnings row records a suppression for its (symbol, date):
 * "this date is wrong, keep it off the calendar". The feed upsert already
 * skips that tuple. But a second feed row on the same tuple (the other vendor
 * agreeing on the date) is still in the table, hidden. The delete path hides
 * it again after its own scoped reconcile; the next whole-book pass (every
 * calendar sync) knew nothing about suppressions and brought it back.
 *
 * The rule under test: a feed row on a suppressed (symbol, date) never wins
 * its cluster. A hand-entered row on that date is the user's own answer and
 * is exempt.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  checkManualAddWouldSupersedeVendor,
  reconcileEarningsDates,
  repointDependentsBeforeDelete,
} from "@/lib/calendar/reconcile-earnings-dates";
import {
  deleteAndSuppressCalendarEvent,
  insertCalendarEvent,
  suppressCalendarEvent,
  upsertCalendarEvents,
  type CalendarEventInput,
} from "@/lib/mutations/calendar";
import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";

let db: Database.Database;

const TODAY = "2026-06-08";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function feedRow(
  source: "finnhub" | "nasdaq",
  symbol: string,
  date: string,
  extra: Partial<CalendarEventInput> = {},
): CalendarEventInput {
  return {
    source,
    event_type: "earnings",
    event_date: date,
    event_time: null,
    title: `${symbol} earnings`,
    symbol,
    source_key: `${source}:${symbol}:${date}`,
    week_of: "2026-06-08",
    raw_json: JSON.stringify({ entry: { symbol, epsActual: null } }),
    ...extra,
  } as CalendarEventInput;
}

/** Write feed rows through the real upsert and return their ids in order. */
function writeFeed(...rows: CalendarEventInput[]): number[] {
  upsertCalendarEvents(db, rows);
  return rows.map(
    (r) =>
      (db.prepare("SELECT id FROM calendar_events WHERE source_key = ?").get(r.source_key) as { id: number })
        .id,
  );
}

function row(id: number) {
  return db
    .prepare(
      `SELECT source, event_date, date_status, date_conflict_with, actual_value,
              COALESCE(superseded, 0) AS superseded
         FROM calendar_events WHERE id = ?`,
    )
    .get(id) as {
    source: string;
    event_date: string;
    date_status: string | null;
    date_conflict_with: string | null;
    actual_value: string | null;
    superseded: number;
  };
}

function showing(symbol: string): Array<{ id: number; source: string; event_date: string }> {
  return db
    .prepare(
      `SELECT id, source, event_date FROM calendar_events
        WHERE event_type = 'earnings' AND UPPER(symbol) = ? AND COALESCE(superseded, 0) = 0
        ORDER BY event_date, id`,
    )
    .all(symbol) as Array<{ id: number; source: string; event_date: string }>;
}

function outboxCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM cloud_outbox").get() as { n: number }).n;
}

describe("a feed row on a date the user removed stays hidden", () => {
  it("the other vendor's row on the removed date does not come back at the next sync pass", () => {
    const [f, n] = writeFeed(feedRow("finnhub", "ZZA", "2026-06-12"), feedRow("nasdaq", "ZZA", "2026-06-12"));
    reconcileEarningsDates(db, { today: TODAY });
    expect(row(f).superseded).toBe(0);
    expect(row(n).superseded).toBe(1);

    // The user removes the showing row: the date is wrong.
    deleteAndSuppressCalendarEvent(db, f, { today: TODAY });
    expect(showing("ZZA")).toEqual([]);

    // The next calendar sync ends with a whole-book pass.
    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(showing("ZZA")).toEqual([]);
    expect(row(n).superseded).toBe(1);
    expect(row(n).date_status).toBeNull();
    // Nothing was showing before the pass, so nothing is reported as hidden
    // and the row is counted under no date status.
    expect(result.superseded).toEqual([]);
    expect(result.single + result.confirmed + result.conflict).toBe(0);
  });

  it("is idempotent: a second pass writes no outbox row", () => {
    const [f] = writeFeed(feedRow("finnhub", "ZZA", "2026-06-12"), feedRow("nasdaq", "ZZA", "2026-06-12"));
    reconcileEarningsDates(db, { today: TODAY });
    deleteAndSuppressCalendarEvent(db, f, { today: TODAY });
    reconcileEarningsDates(db, { today: TODAY });
    const after = outboxCount();
    reconcileEarningsDates(db, { today: TODAY });
    expect(outboxCount()).toBe(after);
  });

  it("a row an earlier pass brought back is hidden again and named in the result", () => {
    // The state an older build left: the row on the removed date is showing.
    const [n] = writeFeed(feedRow("nasdaq", "ZZA", "2026-06-12"));
    reconcileEarningsDates(db, { today: TODAY });
    expect(row(n).superseded).toBe(0);
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-12" });

    const before = outboxCount();
    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(n).superseded).toBe(1);
    expect(row(n).date_status).toBeNull();
    expect(result.superseded).toHaveLength(1);
    expect(result.superseded[0]).toMatchObject({ eventId: n, symbol: "ZZA", eventDate: "2026-06-12" });
    expect(result.superseded[0].reason).toMatch(/you removed/i);
    // The cloud hears about a row that stopped showing.
    expect(outboxCount()).toBe(before + 1);
  });

  it("a row on a removed date is not an email candidate once the pass has hidden it", () => {
    // A reported, armed row: a live recap candidate while it shows.
    const id = db
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, title, symbol, source_key, actual_value, raw_json,
            enriched_at, reaction_snapshot)
         VALUES ('nasdaq', 'earnings', '2026-06-05', 'ZZA earnings', 'ZZA', 'nasdaq:ZZA:2026-06-05',
                 'EPS 2.00 · Rev 800,000,000', ?, '2026-06-06 12:00:00', ?)`,
      )
      .run(
        JSON.stringify({ entry: { symbol: "ZZA", epsActual: 2 } }),
        JSON.stringify({ pct: 4.2 }),
      ).lastInsertRowid as number;
    armWorksheet(db, id);
    const now = new Date("2026-06-06T13:00:00Z");
    expect(findEmailCandidates(db, { now }).map((c) => c.eventId)).toContain(id);

    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-05" });
    reconcileEarningsDates(db, { today: "2026-06-06" });

    expect(row(id).superseded).toBe(1);
    expect(findEmailCandidates(db, { now }).map((c) => c.eventId)).not.toContain(id);
  });
});

describe("the other rows of the cluster resolve as if the removed date were not there", () => {
  it("a vendor on another date shows alone, with no conflict against the removed date", () => {
    // Finnhub's date was removed by the user; its row is still in the table.
    const [f, n] = writeFeed(feedRow("finnhub", "ZZA", "2026-06-11"), feedRow("nasdaq", "ZZA", "2026-06-13"));
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-11" });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(f).superseded).toBe(1);
    expect(row(n).superseded).toBe(0);
    expect(row(n).date_status).toBe("single");
    expect(row(n).date_conflict_with).toBeNull();
    expect(result.conflict).toBe(0);
    expect(result.single).toBe(1);
  });

  it("a removed date that would have won on agreement loses to the vendor left standing", () => {
    // Both vendors agreed on the 12th; the user removed it. Nasdaq later moved
    // to the 16th (a new row); the old Nasdaq row on the 12th is still stored.
    const [f, nOld, nNew] = writeFeed(
      feedRow("finnhub", "ZZA", "2026-06-12"),
      feedRow("nasdaq", "ZZA", "2026-06-12"),
      feedRow("nasdaq", "ZZA", "2026-06-16"),
    );
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-12" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(f).superseded).toBe(1);
    expect(row(nOld).superseded).toBe(1);
    expect(row(nNew).superseded).toBe(0);
    expect(row(nNew).date_status).toBe("single");
  });

  it("bogeys on the hidden row follow the print to the row that shows", () => {
    const [f, n] = writeFeed(feedRow("finnhub", "ZZA", "2026-06-11"), feedRow("nasdaq", "ZZA", "2026-06-13"));
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus)
       VALUES (?, 'manual', 'desk', 1.5)`,
    ).run(f);
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-11" });

    reconcileEarningsDates(db, { today: TODAY });

    const owners = db.prepare("SELECT event_id FROM earnings_bogeys").all() as { event_id: number }[];
    expect(owners).toEqual([{ event_id: n }]);
  });

  it("a share-class sibling on the same date is not hidden: the removal named one symbol", () => {
    const [a, c] = writeFeed(feedRow("finnhub", "GOOGL", "2026-06-12"), feedRow("finnhub", "GOOG", "2026-06-12"));
    suppressCalendarEvent(db, { symbol: "GOOGL", event_date: "2026-06-12" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(a).superseded).toBe(1);
    expect(row(c).superseded).toBe(0);
    expect(row(c).date_status).toBe("single");
  });

  it("a scoped pass applies the same rule", () => {
    const [n] = writeFeed(feedRow("nasdaq", "ZZA", "2026-06-12"));
    const [other] = writeFeed(feedRow("nasdaq", "ZZB", "2026-06-12"));
    reconcileEarningsDates(db, { today: TODAY });
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-12" });

    reconcileEarningsDates(db, { today: TODAY, symbols: ["ZZA"] });

    expect(row(n).superseded).toBe(1);
    expect(row(other).superseded).toBe(0);
  });
});

describe("a hand-entered row is exempt", () => {
  it("a hand-entered row on the removed date itself still shows and still locks its cluster", () => {
    // "Fix date" on the same day (a slot fix) removes the feed row and mints a
    // hand-entered row on the very date it suppresses.
    const [n] = writeFeed(feedRow("nasdaq", "ZZA", "2026-06-12"));
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-12" });
    const manual = insertCalendarEvent(db, {
      symbol: "ZZA",
      event_date: "2026-06-12",
      week_of: "2026-06-08",
    });

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(row(manual.id).superseded).toBe(0);
    expect(row(n).superseded).toBe(1);
    // A sync never writes a confirmation onto a hand-entered row.
    expect(row(manual.id).date_status).toBeNull();
    expect(result.handEntered).toBe(1);
  });

  it("a hand-entered row on another date wins and the hidden feed row folds into it as before", () => {
    const [f] = writeFeed(
      feedRow("finnhub", "ZZA", "2026-06-12", { consensus_estimate: "EPS 2.00" } as Partial<CalendarEventInput>),
    );
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-12" });
    const manual = insertCalendarEvent(db, {
      symbol: "ZZA",
      event_date: "2026-06-15",
      week_of: "2026-06-15",
    });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(manual.id).superseded).toBe(0);
    expect(row(f).superseded).toBe(1);
    const consensus = db
      .prepare("SELECT consensus_estimate FROM calendar_events WHERE id = ?")
      .get(manual.id) as { consensus_estimate: string | null };
    expect(consensus.consensus_estimate).toBe("EPS 2.00");
  });
});

describe("a removed date that shows reported figures", () => {
  it("is hidden, and its figures are not moved onto a vendor row dated today or later", () => {
    // The removed date is in the past and its stored row carries an actual;
    // the other vendor lists a date still ahead.
    const f = db
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, title, symbol, source_key, actual_value, raw_json, enriched_at)
         VALUES ('finnhub', 'earnings', '2026-06-04', 'ZZA earnings', 'ZZA', 'finnhub:ZZA:2026-06-04',
                 'EPS 1.00', ?, '2026-06-05 01:00:00')`,
      )
      .run(JSON.stringify({ entry: { symbol: "ZZA", epsActual: 1 } })).lastInsertRowid as number;
    const [n] = writeFeed(feedRow("nasdaq", "ZZA", "2026-06-10"));
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-04" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(f).superseded).toBe(1);
    expect(row(f).actual_value).toBe("EPS 1.00");
    expect(row(n).superseded).toBe(0);
    expect(row(n).date_status).toBe("single");
    // A row for a print still ahead never carries a result.
    expect(row(n).actual_value).toBeNull();
  });

  it("with no other row in the cluster, it is hidden and keeps its own records", () => {
    const f = db
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, title, symbol, source_key, actual_value, raw_json)
         VALUES ('finnhub', 'earnings', '2026-06-04', 'ZZA earnings', 'ZZA', 'finnhub:ZZA:2026-06-04',
                 'EPS 1.00', ?)`,
      )
      .run(JSON.stringify({ entry: { symbol: "ZZA", epsActual: 1 } })).lastInsertRowid as number;
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-04" });

    reconcileEarningsDates(db, { today: TODAY });

    expect(row(f).superseded).toBe(1);
    expect(row(f).actual_value).toBe("EPS 1.00");
  });
});

describe("the dry runs that share the reconciler's rules", () => {
  it("a hand-entered add is not refused over a feed row the next pass hides anyway", () => {
    // Showing only because an older build brought it back.
    const [n] = writeFeed(feedRow("nasdaq", "ZZA", "2026-06-12"));
    reconcileEarningsDates(db, { today: "2026-06-01" });
    db.prepare("UPDATE calendar_events SET superseded = 0 WHERE id = ?").run(n);
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-12" });

    const check = checkManualAddWouldSupersedeVendor(db, {
      symbol: "ZZA",
      event_date: "2026-06-16",
      today: TODAY,
    });

    expect(check.ok).toBe(true);
  });

  it("the add is still refused over a feed row on a date nobody removed", () => {
    writeFeed(feedRow("nasdaq", "ZZA", "2026-06-12"));
    reconcileEarningsDates(db, { today: TODAY });
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-11" });

    const check = checkManualAddWouldSupersedeVendor(db, {
      symbol: "ZZA",
      event_date: "2026-06-16",
      today: TODAY,
    });

    expect(check.ok).toBe(false);
  });

  it("a deleted row's records go to a row that will show, not to one on a removed date", () => {
    const [f, nOld, nNew] = writeFeed(
      feedRow("finnhub", "ZZA", "2026-06-12"),
      feedRow("nasdaq", "ZZA", "2026-06-12"),
      feedRow("nasdaq", "ZZA", "2026-06-16"),
    );
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus)
       VALUES (?, 'manual', 'desk', 1.5)`,
    ).run(f);
    suppressCalendarEvent(db, { symbol: "ZZA", event_date: "2026-06-12" });

    const handed = repointDependentsBeforeDelete(db, { eventId: f, today: TODAY });

    expect(handed.targetId).toBe(nNew);
    expect(handed.targetId).not.toBe(nOld);
  });

  it("with only a removed-date row left, the records still go to it and are not lost", () => {
    const [f, n] = writeFeed(feedRow("finnhub", "ZZA", "2026-06-12"), feedRow("nasdaq", "ZZA", "2026-06-12"));
    reconcileEarningsDates(db, { today: TODAY });
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus)
       VALUES (?, 'manual', 'desk', 1.5)`,
    ).run(f);

    deleteAndSuppressCalendarEvent(db, f, { today: TODAY });

    const owners = db.prepare("SELECT event_id FROM earnings_bogeys").all() as { event_id: number }[];
    expect(owners).toEqual([{ event_id: n }]);
    expect(row(n).superseded).toBe(1);
  });
});
