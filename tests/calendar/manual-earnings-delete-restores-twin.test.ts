/**
 * Deleting a manual / user_confirmed earnings row must hand the print back to
 * the vendor row it displaced
 * (qa:today-earningshub-add-ticker--manual-add-supersedes-vendor-date-delete-never-restores).
 *
 * Ledger repro: Finnhub carried ORCL on 2026-09-07. The user added a manual
 * ORCL row on 2026-09-02 via "+ Add ticker"; the next reconcile pass superseded
 * the Finnhub row in deference to the user date (by design — rung 1 of
 * resolveCluster). The user then removed the manual row with the Hub's ✕, and
 * the Finnhub row stayed superseded=1 forever: the company's real earnings date
 * had vanished from every calendar surface (all of which filter
 * `COALESCE(superseded,0) = 0`) with no path back.
 *
 * The fix re-runs the reconciler scoped to the deleted row's issuer family, so
 * the surviving cluster re-resolves with the manual row gone. Re-using the
 * reconciler (rather than hand-rolling an un-supersede) is what makes the
 * negative cases below fall out for free: a twin superseded in favour of a
 * DIFFERENT surviving row stays superseded, and other symbols are untouched.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { confirmEarningsDate } from "@/lib/mutations/confirm-earnings-date";
import { deleteCalendarEvent } from "@/lib/mutations/calendar";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { getUpcomingEvents } from "@/lib/queries/calendar";

const TODAY = "2026-08-31";
const VENDOR_DATE = "2026-09-07";
const MANUAL_DATE = "2026-09-02";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(
    "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('ORCL','Oracle','stock','equity',1)",
  ).run();
});

function seedVendor(source: string, symbol: string, date: string): number {
  return db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of, raw_json)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, '{}')`,
    )
    .run(
      source,
      date,
      `${symbol} earnings`,
      symbol,
      `${source}:${symbol}:${date}`,
      "2026-08-31",
    ).lastInsertRowid as number;
}

function state(id: number) {
  return db
    .prepare(
      "SELECT id, source, event_date, date_status, superseded FROM calendar_events WHERE id = ?",
    )
    .get(id) as
    | {
        id: number;
        source: string;
        event_date: string;
        date_status: string | null;
        superseded: number;
      }
    | undefined;
}

function manualRowId(symbol: string): number {
  return (
    db
      .prepare(
        "SELECT id FROM calendar_events WHERE source = 'manual' AND symbol = ? AND event_type = 'earnings'",
      )
      .get(symbol) as { id: number }
  ).id;
}

describe("deleteCalendarEvent — manual earnings row hands the print back", () => {
  it("un-supersedes the vendor twin that lost to the deleted user date (ORCL repro)", () => {
    const vendor = seedVendor("finnhub", "ORCL", VENDOR_DATE);

    confirmEarningsDate(db, {
      symbol: "ORCL",
      confirmedDate: MANUAL_DATE,
      confirmedTime: "amc",
      today: TODAY,
    });
    const manual = manualRowId("ORCL");

    // By design: the user date wins, the vendor row goes dark.
    expect(state(vendor)!.superseded).toBe(1);
    expect(state(manual)!.date_status).toBe("user_confirmed");

    const deleted = deleteCalendarEvent(db, manual, { today: TODAY });

    expect(deleted).toBe(true);
    expect(state(manual)).toBeUndefined();
    // The bug: this stayed 1 forever.
    expect(state(vendor)!.superseded).toBe(0);
    expect(state(vendor)!.date_status).toBe("single");
  });

  it("puts the vendor date back on the calendar surfaces", () => {
    const vendor = seedVendor("finnhub", "ORCL", VENDOR_DATE);
    confirmEarningsDate(db, {
      symbol: "ORCL",
      confirmedDate: MANUAL_DATE,
      confirmedTime: "amc",
      today: TODAY,
    });

    const hidden = getUpcomingEvents(db, { startDate: TODAY, endDate: "2026-09-30" });
    expect(hidden.map((e) => e.event_date)).toEqual([MANUAL_DATE]);

    deleteCalendarEvent(db, manualRowId("ORCL"), { today: TODAY });

    const visible = getUpcomingEvents(db, { startDate: TODAY, endDate: "2026-09-30" });
    expect(visible.map((e) => e.id)).toEqual([vendor]);
    expect(visible[0].event_date).toBe(VENDOR_DATE);
  });

  it("leaves a twin superseded in favour of a DIFFERENT surviving row alone", () => {
    // Finnhub and Nasdaq agree on 09-07; the manual 09-02 row supersedes both.
    // Removing the manual row must restore ONE canonical (the agreeing Finnhub
    // row) — the Nasdaq duplicate is superseded for its own reason and stays
    // hidden, exactly as it would be with no manual row ever added.
    const finn = seedVendor("finnhub", "ORCL", VENDOR_DATE);
    const nas = seedVendor("nasdaq", "ORCL", VENDOR_DATE);

    confirmEarningsDate(db, {
      symbol: "ORCL",
      confirmedDate: MANUAL_DATE,
      confirmedTime: "amc",
      today: TODAY,
    });
    expect(state(finn)!.superseded).toBe(1);
    expect(state(nas)!.superseded).toBe(1);

    deleteCalendarEvent(db, manualRowId("ORCL"), { today: TODAY });

    expect(state(finn)!.superseded).toBe(0);
    expect(state(finn)!.date_status).toBe("confirmed");
    expect(state(nas)!.superseded).toBe(1); // duplicate of the canonical, not a lost date
    expect(
      getUpcomingEvents(db, { startDate: TODAY, endDate: "2026-09-30" }),
    ).toHaveLength(1);
  });

  it("does not re-resolve unrelated symbols", () => {
    seedVendor("finnhub", "ORCL", VENDOR_DATE);
    confirmEarningsDate(db, {
      symbol: "ORCL",
      confirmedDate: MANUAL_DATE,
      confirmedTime: "amc",
      today: TODAY,
    });

    // A lone MSFT row parked in a superseded state by some other flow. A
    // GLOBAL reconcile would clear it to single/superseded=0; a symbol-scoped
    // one must not touch it.
    const msft = seedVendor("finnhub", "MSFT", "2026-09-09");
    db.prepare("UPDATE calendar_events SET superseded = 1 WHERE id = ?").run(msft);

    deleteCalendarEvent(db, manualRowId("ORCL"), { today: TODAY });

    expect(state(msft)!.superseded).toBe(1);
    expect(state(msft)!.date_status).toBeNull();
  });

  it("writes no suppression — the vendor date must stay syncable", () => {
    seedVendor("finnhub", "ORCL", VENDOR_DATE);
    confirmEarningsDate(db, {
      symbol: "ORCL",
      confirmedDate: MANUAL_DATE,
      confirmedTime: "amc",
      today: TODAY,
    });

    deleteCalendarEvent(db, manualRowId("ORCL"), { today: TODAY });

    // Suppressions are the SYNC-owned delete path's tool (deleteAndSuppress…);
    // sync never re-emits a manual row, so removing one needs no suppression —
    // and a suppression on the vendor's own date would re-hide the row this
    // fix just restored.
    const suppressions = db
      .prepare("SELECT symbol, event_date FROM calendar_event_suppressions")
      .all() as { symbol: string; event_date: string }[];
    expect(suppressions).toEqual([]);
    expect(
      suppressions.filter((s) => s.event_date === VENDOR_DATE),
    ).toHaveLength(0);
  });

  it("still refuses sync-owned rows and still deletes non-earnings manual rows", () => {
    const vendor = seedVendor("finnhub", "ORCL", VENDOR_DATE);
    expect(deleteCalendarEvent(db, vendor, { today: TODAY })).toBe(false);
    expect(state(vendor)).toBeDefined();

    const macro = db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, week_of)
         VALUES ('manual', 'macro', '2026-09-03', 'Custom note', 'manual:note:2026-09-03', '2026-08-31')`,
      )
      .run().lastInsertRowid as number;
    expect(deleteCalendarEvent(db, macro, { today: TODAY })).toBe(true);
    expect(state(macro)).toBeUndefined();
  });
});

describe("reconcileEarningsDates — symbols scope", () => {
  it("only resolves the named issuer families (dual-class siblings included)", () => {
    const goog = seedVendor("finnhub", "GOOG", "2026-09-04");
    const googl = seedVendor("nasdaq", "GOOGL", "2026-09-04");
    const orcl = seedVendor("finnhub", "ORCL", VENDOR_DATE);

    reconcileEarningsDates(db, { today: TODAY, symbols: ["GOOGL"] });

    const family = [state(goog)!, state(googl)!];
    expect(family.filter((r) => r.superseded === 0)).toHaveLength(1);
    expect(state(orcl)!.date_status).toBeNull(); // untouched by the scoped pass
    expect(state(orcl)!.superseded).toBe(0);
  });

  it("an empty symbols list is treated as unscoped (whole-window pass)", () => {
    const orcl = seedVendor("finnhub", "ORCL", VENDOR_DATE);
    reconcileEarningsDates(db, { today: TODAY, symbols: [] });
    expect(state(orcl)!.date_status).toBe("single");
  });
});
