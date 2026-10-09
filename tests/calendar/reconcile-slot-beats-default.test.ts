import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  checkManualAddWouldSupersedeVendor,
  reconcileEarningsDates,
} from "@/lib/calendar/reconcile-earnings-dates";
import { insertCalendarEvent, upsertCalendarEvents } from "@/lib/mutations/calendar";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { mondayOf } from "@/lib/calendar/date-utils";

// Owner rulings 2026-10-08 (docs/DECISIONS.md):
//  (a) Two vendors list one earnings print on one date. The duplicate check
//      keeps the row that carries an explicit before-open / after-close slot;
//      a vendor's hour-unknown default never outranks it. It corrects itself
//      on the next sync through the existing fold; no row is edited in place.
//  (b) A hand-entered row and a vendor row the user confirmed, on one date:
//      the hand-entered row wins whatever the row order.
//
// Vendor rows are written through the real writer (`upsertCalendarEvents`)
// in the shapes lib/calendar/finnhub.ts and lib/calendar/nasdaq.ts produce:
// `event_time: null`, the slot in `raw_json.entry.hour`. Synthetic symbols
// and invented round figures only.

const TODAY = "2026-11-02"; // Monday
const PRINT = "2026-11-05"; // Thursday of the same week
const PAST_PRINT = "2026-10-29";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

type Hour = "bmo" | "amc" | "dmh" | undefined;

function idOf(sourceKey: string): number {
  return (
    db.prepare("SELECT id FROM calendar_events WHERE source_key = ?").get(sourceKey) as {
      id: number;
    }
  ).id;
}

/** A Finnhub earnings row as lib/calendar/finnhub.ts assembles it. */
function finnhub(symbol: string, date: string, hour: Hour, epsActual: number | null = null): number {
  const entry: Record<string, unknown> = { symbol, date, epsEstimate: 1, epsActual };
  if (hour) entry.hour = hour;
  upsertCalendarEvents(db, [
    {
      source: "finnhub",
      event_type: "earnings",
      event_date: date,
      event_time: null,
      title: `${symbol} earnings`,
      symbol,
      consensus_estimate: "EPS 1.00",
      raw_json: JSON.stringify({ entry, history: [], finnhub_symbol: symbol }),
      source_key: `finnhub:${symbol}:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`finnhub:${symbol}:${date}`);
}

/** A Nasdaq earnings row as lib/calendar/nasdaq.ts assembles it
 *  (time-pre-market → "bmo", time-after-hours → "amc", time-not-supplied → null). */
function nasdaq(
  symbol: string,
  date: string,
  hour: "bmo" | "amc" | null,
  epsActual: number | null = null,
): number {
  upsertCalendarEvents(db, [
    {
      source: "nasdaq",
      event_type: "earnings",
      event_date: date,
      event_time: null,
      title: `${symbol} earnings`,
      symbol,
      consensus_estimate: "EPS 1.00",
      raw_json: JSON.stringify({
        entry: { hour, epsForecast: 1, epsActual },
        nasdaq_symbol: symbol,
      }),
      source_key: `nasdaq:${symbol}:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`nasdaq:${symbol}:${date}`);
}

function manual(symbol: string, date: string): number {
  return insertCalendarEvent(db, { symbol, event_date: date, week_of: mondayOf(date) }).id;
}

function state(id: number) {
  return db
    .prepare(
      "SELECT COALESCE(superseded, 0) AS superseded, date_status FROM calendar_events WHERE id = ?",
    )
    .get(id) as { superseded: number; date_status: string | null };
}

function eventIdsIn(table: string): number[] {
  return (db.prepare(`SELECT event_id FROM ${table} ORDER BY id`).all() as { event_id: number }[]).map(
    (r) => r.event_id,
  );
}

const outboxRows = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM cloud_outbox").get() as { n: number }).n;

describe("ruling (a): a real slot beats a vendor default on one date", () => {
  it("Finnhub with no hour + Nasdaq pre-market: the Nasdaq row is kept, the Finnhub row hidden", () => {
    const f = finnhub("ZZA", PRINT, undefined);
    const n = nasdaq("ZZA", PRINT, "bmo");

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(state(n)).toEqual({ superseded: 0, date_status: "confirmed" });
    expect(state(f)).toEqual({ superseded: 1, date_status: null });
    expect(result.confirmed).toBe(1);
    expect(result.superseded).toHaveLength(1);
    expect(result.superseded[0]).toMatchObject({
      eventId: f,
      source: "finnhub",
      reason: "same event as the Nasdaq row for that date",
    });
  });

  it("the same pair with the Nasdaq row written first resolves the same way", () => {
    const n = nasdaq("ZZA", PRINT, "amc");
    const f = finnhub("ZZA", PRINT, undefined);

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(n).superseded).toBe(0);
    expect(state(f).superseded).toBe(1);
  });

  it("flips an existing Finnhub-canonical pair on the next sync and moves its dependents", () => {
    const f = finnhub("ZZA", PRINT, undefined);
    const n = nasdaq("ZZA", PRINT, "bmo");
    // The state an older pass left: Finnhub showing, Nasdaq hidden, the
    // bogey, the preview record and the arm all on the Finnhub row.
    db.prepare("UPDATE calendar_events SET date_status = 'confirmed', superseded = 0 WHERE id = ?").run(f);
    db.prepare("UPDATE calendar_events SET superseded = 1 WHERE id = ?").run(n);
    db.prepare(
      "INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus) VALUES (?, 'manual', 'me', 1)",
    ).run(f);
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, sent_at)
       VALUES (?, 'preview', 'x@y.com', 'md', ?)`,
    ).run(f, `${PRINT} 10:00:00`);
    db.prepare("INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, 'recap')").run(f);
    armWorksheet(db, f);
    const before = outboxRows();

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(state(n)).toEqual({ superseded: 0, date_status: "confirmed" });
    expect(state(f)).toEqual({ superseded: 1, date_status: null });
    expect(eventIdsIn("earnings_bogeys")).toEqual([n]);
    expect(eventIdsIn("earnings_emails")).toEqual([n]);
    expect(eventIdsIn("earnings_email_skips")).toEqual([n]);
    expect(eventIdsIn("earnings_worksheet_flags")).toEqual([n]);
    expect(outboxRows()).toBe(before + 1);
    expect(result.superseded.map((r) => r.eventId)).toEqual([f]);

    // The slot evidence itself was never edited in place.
    const raw = db.prepare("SELECT raw_json, event_time FROM calendar_events WHERE id = ?").get(f) as {
      raw_json: string;
      event_time: string | null;
    };
    expect(JSON.parse(raw.raw_json).entry.hour).toBeUndefined();
    expect(raw.event_time).toBeNull();

    // A second pass moves nothing and reports nothing.
    const again = reconcileEarningsDates(db, { today: TODAY });
    expect(again.superseded).toEqual([]);
    expect(outboxRows()).toBe(before + 1);
    expect(state(n).superseded).toBe(0);
  });

  it("Finnhub 'during market hours' is not a before-open / after-close slot: a slotted Nasdaq row is kept", () => {
    const f = finnhub("ZZA", PRINT, "dmh");
    const n = nasdaq("ZZA", PRINT, "amc");

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(n).superseded).toBe(0);
    expect(state(f).superseded).toBe(1);
  });

  it("both rows carry a slot: the Finnhub row is kept, in either write order", () => {
    const f = finnhub("ZZA", PRINT, "amc");
    const n = nasdaq("ZZA", PRINT, "bmo");
    const n2 = nasdaq("ZZB", PRINT, "bmo");
    const f2 = finnhub("ZZB", PRINT, "amc");

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(f)).toEqual({ superseded: 0, date_status: "confirmed" });
    expect(state(n).superseded).toBe(1);
    expect(state(f2)).toEqual({ superseded: 0, date_status: "confirmed" });
    expect(state(n2).superseded).toBe(1);
  });

  it("neither row carries a slot: the Finnhub row is kept, in either write order", () => {
    const f = finnhub("ZZA", PRINT, undefined);
    const n = nasdaq("ZZA", PRINT, null);
    const n2 = nasdaq("ZZB", PRINT, null);
    const f2 = finnhub("ZZB", PRINT, undefined);

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(f)).toEqual({ superseded: 0, date_status: "confirmed" });
    expect(state(n).superseded).toBe(1);
    expect(state(f2)).toEqual({ superseded: 0, date_status: "confirmed" });
    expect(state(n2).superseded).toBe(1);
  });

  it("only the Finnhub row carries a slot: the Finnhub row is kept", () => {
    const f = finnhub("ZZA", PRINT, "bmo");
    const n = nasdaq("ZZA", PRINT, null);

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(f).superseded).toBe(0);
    expect(state(n).superseded).toBe(1);
  });

  it("stays on the slotted row after the print, when both rows carry actuals", () => {
    // Finnhub is written first, so it has the lower id: without the slot rule
    // the past-with-actuals rung would hand the print back to it.
    const f = finnhub("ZZA", PAST_PRINT, undefined, 1.1);
    const n = nasdaq("ZZA", PAST_PRINT, "bmo", 1.1);

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(n)).toEqual({ superseded: 0, date_status: "confirmed" });
    expect(state(f).superseded).toBe(1);
  });

  it("does not flip back to Finnhub when only the Finnhub row shows the actual yet", () => {
    // Reviewer's probe: before the print the slotted Nasdaq row is kept. The
    // day after, Finnhub posts its actual first; the Nasdaq row has none yet.
    // The print must stay on the Nasdaq row (its bogey, preview and slot go
    // with it), not hop to Finnhub's default time and back again later.
    const f = finnhub("ZZA", PAST_PRINT, undefined);
    const n = nasdaq("ZZA", PAST_PRINT, "bmo");
    reconcileEarningsDates(db, { today: "2026-10-27" });
    expect(state(n).superseded).toBe(0);
    expect(state(f).superseded).toBe(1);

    finnhub("ZZA", PAST_PRINT, undefined, 1.1); // the vendor re-sync brings epsActual
    reconcileEarningsDates(db, { today: TODAY });

    expect(state(n)).toEqual({ superseded: 0, date_status: "confirmed" });
    expect(state(f).superseded).toBe(1);

    nasdaq("ZZA", PAST_PRINT, "bmo", 1.1); // and later the Nasdaq row shows it too
    reconcileEarningsDates(db, { today: TODAY });

    expect(state(n)).toEqual({ superseded: 0, date_status: "confirmed" });
    expect(state(f).superseded).toBe(1);
  });

  it("only the Nasdaq row shows the actual and Finnhub carries the slot: Finnhub is still kept", () => {
    const f = finnhub("ZZA", PAST_PRINT, "amc");
    const n = nasdaq("ZZA", PAST_PRINT, null, 1.1);

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(f)).toEqual({ superseded: 0, date_status: "confirmed" });
    expect(state(n).superseded).toBe(1);
  });

  it("a real disagreement on the date is still a conflict with Nasdaq provisional (unchanged)", () => {
    const f = finnhub("ZZA", PRINT, "amc");
    const n = nasdaq("ZZA", "2026-11-06", null);

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(result.conflict).toBe(1);
    expect(state(n)).toEqual({ superseded: 0, date_status: "conflict" });
    expect(state(f).superseded).toBe(1);
  });
});

describe("ruling (a): one vendor, two rows on one date (share-class siblings)", () => {
  it("keeps the sibling row that carries a slot, in either write order", () => {
    const plain = finnhub("GOOG", PRINT, undefined);
    const slotted = finnhub("GOOGL", PRINT, "amc");

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(result.single).toBe(1);
    expect(state(slotted)).toEqual({ superseded: 0, date_status: "single" });
    expect(state(plain).superseded).toBe(1);
  });

  it("the slotted sibling written first is kept too", () => {
    const slotted = finnhub("GOOGL", PRINT, "amc");
    const plain = finnhub("GOOG", PRINT, undefined);

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(slotted).superseded).toBe(0);
    expect(state(plain).superseded).toBe(1);
  });

  it("neither sibling carries a slot: the earlier-written row is kept (unchanged)", () => {
    const first = finnhub("GOOG", PRINT, undefined);
    const second = finnhub("GOOGL", PRINT, undefined);

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(first).superseded).toBe(0);
    expect(state(second).superseded).toBe(1);
  });

  it("a slot never moves the winner to a different DATE: the oldest single-source claim still wins (unchanged)", () => {
    const older = finnhub("ZZA", "2026-11-03", undefined);
    const newer = finnhub("ZZA", PRINT, "amc");

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(older).superseded).toBe(0);
    expect(state(newer).superseded).toBe(1);
  });
});

describe("ruling (b): a hand-entered row beats a vendor row the user confirmed, on one date", () => {
  // No current writer stamps `user_confirmed` on a vendor row (the confirm
  // route writes a hand-entered row); the shape is left over from the older
  // confirm-in-place flow, so it is stamped here by hand on a writer-made row.
  function confirmInPlace(id: number) {
    db.prepare("UPDATE calendar_events SET date_status = 'user_confirmed' WHERE id = ?").run(id);
  }

  it("vendor row written first: the hand-entered row is kept and takes the dependents", () => {
    const f = finnhub("ZZA", PRINT, "amc");
    confirmInPlace(f);
    const m = manual("ZZA", PRINT);
    db.prepare(
      "INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus) VALUES (?, 'manual', 'me', 1)",
    ).run(f);
    armWorksheet(db, f);

    const result = reconcileEarningsDates(db, { today: TODAY });

    // The pass never writes a confirmation on the hand-entered row.
    expect(state(m)).toEqual({ superseded: 0, date_status: null });
    expect(state(f)).toEqual({ superseded: 1, date_status: null });
    expect(eventIdsIn("earnings_bogeys")).toEqual([m]);
    expect(eventIdsIn("earnings_worksheet_flags")).toEqual([m]);
    expect(result.handEntered).toBe(1);
    expect(result.superseded[0]).toMatchObject({
      eventId: f,
      reason: `the date you entered (${PRINT}) takes its place`,
    });

    const again = reconcileEarningsDates(db, { today: TODAY });
    expect(again.superseded).toEqual([]);
    expect(state(m).superseded).toBe(0);
    expect(state(f).superseded).toBe(1);
  });

  it("hand-entered row written first: the hand-entered row is kept", () => {
    const m = manual("ZZA", PRINT);
    const f = finnhub("ZZA", PRINT, "amc");
    confirmInPlace(f);

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(m).superseded).toBe(0);
    expect(state(f)).toEqual({ superseded: 1, date_status: null });
  });

  it("brings back a hand-entered row an older pass had hidden behind the confirmed vendor row", () => {
    const f = finnhub("ZZA", PRINT, "amc");
    confirmInPlace(f);
    const m = manual("ZZA", PRINT);
    db.prepare("UPDATE calendar_events SET superseded = 1 WHERE id = ?").run(m);

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(m).superseded).toBe(0);
    expect(state(f).superseded).toBe(1);
  });

  it("a hand-entered row keeps a confirmation it already carries", () => {
    const f = finnhub("ZZA", PRINT, "amc");
    confirmInPlace(f);
    const m = manual("ZZA", PRINT);
    confirmInPlace(m);

    const result = reconcileEarningsDates(db, { today: TODAY });

    expect(state(m)).toEqual({ superseded: 0, date_status: "user_confirmed" });
    expect(state(f).superseded).toBe(1);
    expect(result.userConfirmed).toBe(1);
  });

  it("on DIFFERENT dates the earlier locked row still wins (unchanged)", () => {
    const f = finnhub("ZZA", "2026-11-04", "amc");
    confirmInPlace(f);
    const m = manual("ZZA", PRINT);

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(f)).toEqual({ superseded: 0, date_status: "user_confirmed" });
    expect(state(m).superseded).toBe(1);
  });
});

describe("the manual-add dry run agrees with the pass", () => {
  const VENDOR_DATE = "2026-11-12"; // the week after TODAY's
  const TYPED_DATE = "2026-11-05";

  it("names the slotted Nasdaq row, the one that is showing, as the row a different-week add replaces", () => {
    const f = finnhub("ZZA", VENDOR_DATE, undefined);
    const n = nasdaq("ZZA", VENDOR_DATE, "bmo");
    reconcileEarningsDates(db, { today: TODAY });
    expect(state(n).superseded).toBe(0);
    expect(state(f).superseded).toBe(1);

    const check = checkManualAddWouldSupersedeVendor(db, {
      symbol: "ZZA",
      event_date: TYPED_DATE,
      today: TODAY,
    });

    expect(check.ok).toBe(false);
    expect(check.wouldSupersede.map((r) => r.eventId)).toEqual([n]);
    expect(check.message).toContain("Nasdaq already has ZZA earnings on 2026-11-12");

    // Parity: do the add for real and the pass hides exactly that row.
    const m = manual("ZZA", TYPED_DATE);
    const result = reconcileEarningsDates(db, { today: TODAY });
    expect(result.superseded.map((r) => r.eventId)).toEqual([n]);
    expect(state(m).superseded).toBe(0);
  });

  it("before any pass has run, it still predicts the slotted row as the one showing", () => {
    finnhub("ZZA", VENDOR_DATE, undefined);
    const n = nasdaq("ZZA", VENDOR_DATE, "bmo");

    const check = checkManualAddWouldSupersedeVendor(db, {
      symbol: "ZZA",
      event_date: TYPED_DATE,
      today: TODAY,
    });

    expect(check.ok).toBe(false);
    expect(check.wouldSupersede.map((r) => r.eventId)).toEqual([n]);
  });

  it("a same-date add beside a confirmed vendor row is predicted to win, as the pass makes it", () => {
    // Different week from the OTHER vendor date in the chain, so the guard has
    // something to report only if the hypothetical row really takes the cluster.
    const confirmed = finnhub("ZZA", TYPED_DATE, "amc");
    db.prepare("UPDATE calendar_events SET date_status = 'user_confirmed' WHERE id = ?").run(confirmed);
    const nextWeek = nasdaq("ZZA", VENDOR_DATE, "bmo");
    reconcileEarningsDates(db, { today: TODAY });
    // The confirmed vendor row holds the cluster; the next-week row is hidden.
    expect(state(confirmed).superseded).toBe(0);
    expect(state(nextWeek).superseded).toBe(1);

    const check = checkManualAddWouldSupersedeVendor(db, {
      symbol: "ZZA",
      event_date: TYPED_DATE,
      today: TODAY,
    });
    // Same week as the row it replaces, so nothing is gated ...
    expect(check.ok).toBe(true);

    // ... and the real add ends where the dry run's resolution put it.
    const m = manual("ZZA", TYPED_DATE);
    reconcileEarningsDates(db, { today: TODAY });
    expect(state(m).superseded).toBe(0);
    expect(state(confirmed).superseded).toBe(1);
  });
});
