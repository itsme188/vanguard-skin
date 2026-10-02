import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";

// QA HIGH (2026-10-02): earnings-reconcile--printed-user-row-loses-actuals-
// vendor-twin-resurfaces-sent-emails-read-pending.
//
// A manual, user_confirmed row typed BEFORE the print but dated ON the print
// was judged a phantom by the 2026-09-11 "post-print corrections only" rule
// (its creation time predates the print). A whole-book reconcile then split it
// off, stripped its actuals, and un-superseded the vendor twin — while the
// manual row still owned the sent preview/recap emails, so the twin read as
// un-recapped and the morning debrief sent a duplicate recap.
//
// USER RULING (2026-10-02):
//  (1) same-date agreement: a manual row on the reported print's own date IS
//      the print, whatever its creation time;
//  (2) evidence belt: a manual row that owns a DELIVERED earnings email, or an
//      accepted print sheet, for its own date is never a phantom.
// Synthetic symbols and figures only.

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

interface SeedRow {
  source: string;
  symbol: string;
  date: string;
  epsActual?: number | null;
  actualValue?: string | null;
  dateStatus?: string | null;
  createdAt?: string;
  enrichedAt?: string | null;
  superseded?: number;
}

function seed(r: SeedRow): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, actual_value, date_status, raw_json,
          enriched_at, superseded, created_at)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    )
    .run(
      r.source,
      r.date,
      `${r.symbol} earnings`,
      r.symbol,
      `${r.source}:${r.symbol}:${r.date}`,
      r.actualValue ?? null,
      r.dateStatus ?? null,
      JSON.stringify({ entry: { epsActual: r.epsActual ?? null } }),
      r.enrichedAt ?? null,
      r.superseded ?? 0,
      r.createdAt ?? null,
    ).lastInsertRowid as number;
}

function seedEmail(eventId: number, phase: "preview" | "recap", sentAt: string, error: string | null = null) {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, sent_at, error)
     VALUES (?, ?, 'x@y.com', 'md', ?, ?)`,
  ).run(eventId, phase, sentAt, error);
}

function seedPrintSheet(eventId: number, symbol: string, date: string, lineState: string, updatedAt: string) {
  const printId = db
    .prepare("INSERT INTO print_watch_prints (event_id, symbol, event_date) VALUES (?, ?, ?)")
    .run(eventId, symbol, date).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO print_watch_lines (print_id, metric_id, contract_json, state, value, updated_at)
     VALUES (?, 'eps', '{}', ?, 1.25, ?)`,
  ).run(printId, lineState, updatedAt);
}

function state(id: number) {
  return db
    .prepare(
      "SELECT superseded, date_status, actual_value, enriched_at FROM calendar_events WHERE id = ?",
    )
    .get(id) as {
    superseded: number;
    date_status: string | null;
    actual_value: string | null;
    enriched_at: string | null;
  };
}

const PRINT = "2026-09-23";
const DAY_AFTER = "2026-09-24";
const FIGURE = "EPS 1.25 · Rev 100,000,000";

describe("same-date agreement (ruling leg 1)", () => {
  it("reviewer repro: a manual row ON the print date, typed BEFORE the print, keeps the print after a whole-book reconcile", () => {
    // Pre-print state: the manual row won rung 1 and inherited the vendor's
    // figure; the vendor twin is superseded; both emails went out on the
    // manual row.
    const manual = seed({
      source: "manual",
      symbol: "ZZFS",
      date: PRINT,
      dateStatus: "user_confirmed",
      createdAt: "2026-09-10 09:00:00",
      actualValue: FIGURE,
      enrichedAt: "2026-09-23 13:00:00",
    });
    const twin = seed({
      source: "finnhub",
      symbol: "ZZFS",
      date: PRINT,
      actualValue: FIGURE,
      epsActual: 1.25,
      enrichedAt: "2026-09-23 13:00:00",
      superseded: 1,
    });
    seedEmail(manual, "preview", "2026-09-23 09:00:00");
    seedEmail(manual, "recap", "2026-09-23 13:10:00");

    // The whole-book reconcile the day after the print (Refresh / briefing).
    reconcileEarningsDates(db, { today: DAY_AFTER });

    expect(state(manual).superseded).toBe(0);
    expect(state(manual).date_status).toBe("user_confirmed");
    expect(state(manual).actual_value).toBe(FIGURE);
    expect(state(manual).enriched_at).not.toBeNull();
    expect(state(twin).superseded).toBe(1);

    // Idempotent.
    reconcileEarningsDates(db, { today: DAY_AFTER });
    expect(state(manual).actual_value).toBe(FIGURE);
    expect(state(twin).superseded).toBe(1);
  });

  it("the same-date leg stands on its own: no emails, no sheet, typed before the print, vendor print only in raw_json", () => {
    const manual = seed({
      source: "manual",
      symbol: "ZZFS",
      date: PRINT,
      dateStatus: "user_confirmed",
      createdAt: "2026-09-10 09:00:00",
    });
    const twin = seed({ source: "finnhub", symbol: "ZZFS", date: PRINT, epsActual: 1.25 });

    reconcileEarningsDates(db, { today: DAY_AFTER });

    expect(state(manual).superseded).toBe(0);
    expect(state(manual).date_status).toBe("user_confirmed");
    expect(state(twin).superseded).toBe(1);
  });
});

describe("evidence belt (ruling leg 2)", () => {
  /** Manual row ONE day off the print, typed before it — a phantom by dates alone. */
  function seedOffByOne() {
    const vendor = seed({
      source: "finnhub",
      symbol: "ZZNK",
      date: "2026-09-01",
      actualValue: FIGURE,
      epsActual: 1.25,
      enrichedAt: "2026-09-01 21:00:00",
    });
    const manual = seed({
      source: "manual",
      symbol: "ZZNK",
      date: "2026-09-02",
      dateStatus: "user_confirmed",
      createdAt: "2026-08-25 12:00:00",
      actualValue: FIGURE,
      enrichedAt: "2026-09-01 21:00:00",
    });
    return { vendor, manual };
  }
  const TODAY = "2026-09-11";

  it("a delivered recap on the manual row keeps it the print: not split, not stripped", () => {
    const { vendor, manual } = seedOffByOne();
    seedEmail(manual, "recap", "2026-09-02 13:00:00");

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(manual).superseded).toBe(0);
    expect(state(manual).actual_value).toBe(FIGURE);
    expect(state(manual).enriched_at).not.toBeNull();
    expect(state(vendor).superseded).toBe(1);
  });

  it("a cloud-delivered preview counts as delivered evidence too (any phase, sentinel state)", () => {
    const { vendor, manual } = seedOffByOne();
    seedEmail(manual, "preview", "2026-09-02 11:00:00", "sent-by-cloud");

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(manual).superseded).toBe(0);
    expect(state(manual).actual_value).toBe(FIGURE);
    expect(state(vendor).superseded).toBe(1);
  });

  it("a LIVE claim is not a delivery: the row is still a phantom", () => {
    const { vendor, manual } = seedOffByOne();
    seedEmail(manual, "recap", "2026-09-02 13:00:00", "in_progress");

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(vendor).superseded).toBe(0);
    expect(state(manual).actual_value).toBeNull();
  });

  it("an email sent long BEFORE the row's own date (dragged from another print) is not evidence", () => {
    const vendor = seed({
      source: "finnhub",
      symbol: "ZZNK",
      date: "2026-09-01",
      actualValue: FIGURE,
      epsActual: 1.25,
    });
    const phantom = seed({
      source: "manual",
      symbol: "ZZNK",
      date: "2026-09-10",
      dateStatus: "user_confirmed",
      createdAt: "2026-08-25 12:00:00",
      actualValue: FIGURE,
    });
    seedEmail(phantom, "recap", "2026-09-01 20:30:00");

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(vendor).superseded).toBe(0);
    expect(state(phantom).actual_value).toBeNull();
  });

  it("a phantom at D+2 holding a recap sent D+1 for print D is NOT evidence — it still splits", () => {
    const vendor = seed({
      source: "finnhub",
      symbol: "ZZNK",
      date: "2026-09-01",
      actualValue: FIGURE,
      epsActual: 1.25,
    });
    const phantom = seed({
      source: "manual",
      symbol: "ZZNK",
      date: "2026-09-03",
      dateStatus: "user_confirmed",
      createdAt: "2026-08-25 12:00:00",
      actualValue: FIGURE,
    });
    // The print's recap, dragged onto the phantom by an earlier pass: sent the
    // day BEFORE the phantom's own date, so it cannot be about that date.
    seedEmail(phantom, "recap", "2026-09-02 13:00:00");

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(vendor).superseded).toBe(0);
    expect(state(vendor).date_status).toBe("confirmed");
    expect(state(phantom).actual_value).toBeNull();
  });

  it("a preview sent more than a day AFTER the row's date is not evidence (previews precede the print)", () => {
    const { vendor, manual } = seedOffByOne();
    seedEmail(manual, "preview", "2026-09-05 09:00:00");

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(vendor).superseded).toBe(0);
    expect(state(manual).actual_value).toBeNull();
  });

  it("an accepted print sheet on the manual row keeps it the print", () => {
    const { vendor, manual } = seedOffByOne();
    seedPrintSheet(manual, "ZZNK", "2026-09-02", "accepted", "2026-09-02 13:00:00");

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(manual).superseded).toBe(0);
    expect(state(manual).actual_value).toBe(FIGURE);
    expect(state(vendor).superseded).toBe(1);
  });

  it("a print sheet with no accepted line is not evidence", () => {
    const { vendor, manual } = seedOffByOne();
    seedPrintSheet(manual, "ZZNK", "2026-09-02", "agreed", "2026-09-02 13:00:00");

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(vendor).superseded).toBe(0);
    expect(state(manual).actual_value).toBeNull();
  });

  it("regression: one day off with NO evidence still splits — the vendor keeps the print", () => {
    const { vendor, manual } = seedOffByOne();

    reconcileEarningsDates(db, { today: TODAY });

    expect(state(vendor).superseded).toBe(0);
    expect(state(vendor).date_status).toBe("confirmed");
    expect(state(manual).superseded).toBe(0);
    expect(state(manual).actual_value).toBeNull();
  });
});
