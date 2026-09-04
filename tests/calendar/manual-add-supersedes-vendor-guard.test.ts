/**
 * Adding a manual "+ Add ticker" earnings row in a DIFFERENT week from a live
 * vendor row must not silently take that vendor date off the calendar
 * (qa:today-earningshub-add-ticker--manual-add-silently-supersedes-vendor-date-other-week).
 *
 * Ledger repro: Finnhub carried the name on 2026-09-07. The user typed a manual
 * row for 2026-09-02; the add succeeded with no message, and the next "Refresh
 * from Finnhub" ran reconcileEarningsDates, which clustered the two rows (5 days
 * apart, inside CLUSTER_PROXIMITY_DAYS) and let the manual row win rung 1 — the
 * vendor date vanished from every surface that filters
 * `COALESCE(superseded,0) = 0`.
 *
 * `checkManualAddWouldSupersedeVendor` is the pre-write half of the user's
 * Option-1 ruling (2026-09-02): the API refuses with 409
 * `would_supersede_vendor` and the form offers an explicit "add anyway".
 * Supersession semantics once confirmed are UNCHANGED — this file therefore
 * also pins the check to the reconciler it predicts (the parity cases below).
 *
 * The check is a DRY RUN of the reconciler, not a second rulebook: it gathers
 * the issuer family exactly as the pass does, appends the hypothetical manual
 * row, and re-runs the reconciler's own clustering + resolution. So every case
 * here should read as "what would Refresh from Finnhub do to this row".
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  checkManualAddWouldSupersedeVendor,
  reconcileEarningsDates,
} from "@/lib/calendar/reconcile-earnings-dates";
import { insertCalendarEvent } from "@/lib/mutations/calendar";
import { mondayOf } from "@/lib/calendar/date-utils";

const TODAY = "2026-08-31"; // Monday
const VENDOR_DATE = "2026-09-07"; // Monday of the NEXT week
const MANUAL_DATE = "2026-09-02"; // Wednesday of the week of TODAY

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedVendor(opts: {
  source?: string;
  symbol?: string;
  date?: string;
  eventType?: string;
  superseded?: 0 | 1;
}): number {
  const source = opts.source ?? "finnhub";
  const symbol = opts.symbol ?? "ZQTEST";
  const date = opts.date ?? VENDOR_DATE;
  const eventType = opts.eventType ?? "earnings";
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, week_of, raw_json, superseded)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    )
    .run(
      source,
      eventType,
      date,
      `${symbol} earnings`,
      symbol,
      `${source}:${symbol}:${date}:${eventType}`,
      mondayOf(date),
      opts.superseded ?? 0,
    ).lastInsertRowid as number;
}

function stateOf(id: number) {
  return db
    .prepare(
      "SELECT id, source, event_date, date_status, COALESCE(superseded,0) AS superseded FROM calendar_events WHERE id = ?",
    )
    .get(id) as {
    id: number;
    source: string;
    event_date: string;
    date_status: string | null;
    superseded: number;
  };
}

function check(overrides: Partial<Parameters<typeof checkManualAddWouldSupersedeVendor>[1]> = {}) {
  return checkManualAddWouldSupersedeVendor(db, {
    symbol: "ZQTEST",
    event_date: MANUAL_DATE,
    event_type: "earnings",
    today: TODAY,
    ...overrides,
  });
}

describe("checkManualAddWouldSupersedeVendor — reports the displaced vendor date", () => {
  it("names a live vendor row in a different week that the manual add would supersede", () => {
    const vendorId = seedVendor({});

    const result = check();

    expect(result.ok).toBe(false);
    expect(result.wouldSupersede).toHaveLength(1);
    expect(result.wouldSupersede[0]).toMatchObject({
      eventId: vendorId,
      eventDate: VENDOR_DATE,
      source: "finnhub",
      symbol: "ZQTEST",
    });
    // Plain English, names symbol + vendor date + source + the consequence.
    expect(result.message).toContain("ZQTEST");
    expect(result.message).toContain(VENDOR_DATE);
    expect(result.message).toMatch(/finnhub/i);
    expect(result.message).toMatch(/replace/i);
  });

  it("matches an issuer-family sibling, not just the literal symbol", () => {
    // GOOG/GOOGL are one earnings event; the reconciler clusters by family, so
    // the guard must too or the warning goes missing on exactly the rows the
    // reconciler will merge.
    const vendorId = seedVendor({ symbol: "GOOGL" });

    const result = check({ symbol: "GOOG" });

    expect(result.ok).toBe(false);
    expect(result.wouldSupersede[0].eventId).toBe(vendorId);
  });

  it("does not attribute a vendor row that was already losing its cluster", () => {
    // Finnhub + Nasdaq agree on the vendor date: the reconciler already keeps
    // Finnhub canonical and supersedes the Nasdaq twin, with or without the
    // manual add. Only the row the ADD displaces may be reported.
    const finnhubId = seedVendor({ source: "finnhub" });
    const nasdaqId = seedVendor({ source: "nasdaq" });

    const result = check();

    expect(result.wouldSupersede.map((r) => r.eventId)).toEqual([finnhubId]);
    expect(nasdaqId).toBeGreaterThan(0);
  });
});

describe("checkManualAddWouldSupersedeVendor — cases that must stay silent", () => {
  it("clears a same-week add (the normal confirm-the-date flow)", () => {
    seedVendor({});
    // 2026-09-08 is the Tuesday of the vendor's own week.
    const sameWeek = "2026-09-08";
    expect(mondayOf(sameWeek)).toBe(mondayOf(VENDOR_DATE));

    const result = check({ event_date: sameWeek });

    expect(result.ok).toBe(true);
    expect(result.wouldSupersede).toEqual([]);
    expect(result.message).toBeNull();
  });

  it("clears a different symbol / issuer family", () => {
    seedVendor({ symbol: "ZQOTHR" });

    expect(check().ok).toBe(true);
  });

  it("clears a vendor row that is ALREADY superseded", () => {
    seedVendor({ superseded: 1 });

    expect(check().ok).toBe(true);
  });

  it("clears a non-earnings vendor row on the same date", () => {
    seedVendor({ eventType: "fomc" });

    expect(check().ok).toBe(true);
  });

  it("clears when the row being ADDED is not an earnings row", () => {
    seedVendor({});

    expect(check({ event_type: "other_macro" }).ok).toBe(true);
  });

  it("clears a vendor row beyond the reconciler's clustering proximity", () => {
    // 18 days out: a different reporting event entirely, so the reconciler
    // never clusters the two and the add displaces nothing.
    seedVendor({ date: "2026-09-20" });

    expect(check().ok).toBe(true);
  });

  it("clears a manual twin (only vendor rows can be displaced by a vendor warning)", () => {
    seedVendor({ source: "manual", date: VENDOR_DATE });

    expect(check().ok).toBe(true);
  });
});

describe("checkManualAddWouldSupersedeVendor — parity with reconcileEarningsDates", () => {
  it("names exactly the row the next reconcile pass supersedes", () => {
    const vendorId = seedVendor({});
    const bystanderId = seedVendor({ symbol: "ZQOTHR", date: VENDOR_DATE });

    const predicted = check();
    expect(predicted.wouldSupersede.map((r) => r.eventId)).toEqual([vendorId]);

    // The forced add (what `force: true` does at the API) …
    const { id: manualId } = insertCalendarEvent(db, {
      symbol: "ZQTEST",
      event_date: MANUAL_DATE,
      event_type: "earnings",
      event_time: "AMC",
      week_of: mondayOf(MANUAL_DATE),
    });
    // … then the pass the user triggers with "Refresh from Finnhub".
    reconcileEarningsDates(db, { today: TODAY });

    expect(stateOf(vendorId).superseded).toBe(1);
    expect(stateOf(manualId)).toMatchObject({
      superseded: 0,
      date_status: "user_confirmed",
    });
    expect(stateOf(bystanderId).superseded).toBe(0);
  });

  it("leaves the vendor row alone when the check cleared the add (same week)", () => {
    const vendorId = seedVendor({});
    const sameWeekDate = "2026-09-08";
    expect(check({ event_date: sameWeekDate }).ok).toBe(true);

    insertCalendarEvent(db, {
      symbol: "ZQTEST",
      event_date: sameWeekDate,
      event_type: "earnings",
      event_time: "AMC",
      week_of: mondayOf(sameWeekDate),
    });
    reconcileEarningsDates(db, { today: TODAY });

    // Same-week adds ARE still a supersession (the user's date wins by design,
    // rung 1) — they are simply not gated, because confirming this week's date
    // is the flow the form exists for. The parity claim here is only that the
    // guard's silence is a deliberate scope choice, not a missed detection.
    expect(stateOf(vendorId).superseded).toBe(1);
  });

  it("warns about a pair that sits outside TODAY's gather window but will cluster later", () => {
    // The reconciler gathers [today-21, today+30]; both rows below are past
    // that edge, so a pass run right now touches neither. They are 3 days
    // apart, so the moment the window reaches them the manual row supersedes
    // the vendor date — the guard uses the widened window (the same one
    // repointDependentsBeforeDelete uses) so the warning isn't merely delayed
    // until it is too late to be useful.
    const farVendor = "2026-10-20"; // week of 2026-10-19
    const farManual = "2026-10-15"; // week of 2026-10-12
    const vendorId = seedVendor({ date: farVendor });

    expect(check({ event_date: farManual }).wouldSupersede.map((r) => r.eventId)).toEqual([
      vendorId,
    ]);

    reconcileEarningsDates(db, { today: TODAY });
    expect(stateOf(vendorId).superseded).toBe(0); // out of window today

    insertCalendarEvent(db, {
      symbol: "ZQTEST",
      event_date: farManual,
      event_type: "earnings",
      event_time: "AMC",
      week_of: mondayOf(farManual),
    });
    // A later pass, once the window covers both rows — the warning comes true.
    reconcileEarningsDates(db, { today: "2026-10-05" });
    expect(stateOf(vendorId).superseded).toBe(1);
  });
});
