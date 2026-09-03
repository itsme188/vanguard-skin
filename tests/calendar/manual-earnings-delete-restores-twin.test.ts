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
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import {
  deleteAndSuppressCalendarEvent,
  deleteCalendarEvent,
} from "@/lib/mutations/calendar";
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

// ── Dependent-audit-row helpers (the ON DELETE CASCADE children) ──────────

function addBogey(eventId: number, label = "TMT weekly"): number {
  return db
    .prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus)
       VALUES (?, 'pdf_upload', ?, 1.23)`,
    )
    .run(eventId, label).lastInsertRowid as number;
}

function addEmail(eventId: number, phase: "preview" | "recap", sentAt: string): number {
  return db
    .prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at)
       VALUES (?, ?, 'desk@example.com', ?)`,
    )
    .run(eventId, phase, sentAt).lastInsertRowid as number;
}

function addSkip(eventId: number, phase: "preview" | "recap", skippedAt: string): number {
  return db
    .prepare(
      `INSERT INTO earnings_email_skips (event_id, phase, skipped_at) VALUES (?, ?, ?)`,
    )
    .run(eventId, phase, skippedAt).lastInsertRowid as number;
}

/** Where a child row lives now — undefined once CASCADE has eaten it. */
function bogeyEventId(id: number): number | undefined {
  return (
    db.prepare("SELECT event_id FROM earnings_bogeys WHERE id = ?").get(id) as
      | { event_id: number }
      | undefined
  )?.event_id;
}

function emailEventId(id: number): number | undefined {
  return (
    db.prepare("SELECT event_id FROM earnings_emails WHERE id = ?").get(id) as
      | { event_id: number }
      | undefined
  )?.event_id;
}

function skipEventId(id: number): number | undefined {
  return (
    db.prepare("SELECT event_id FROM earnings_email_skips WHERE id = ?").get(id) as
      | { event_id: number }
      | undefined
  )?.event_id;
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

/**
 * Finding A of the 2026-08-31 PR #59 review: the hand-back above ran AFTER the
 * DELETE. `earnings_bogeys` / `earnings_emails` / `earnings_email_skips` all
 * carry `ON DELETE CASCADE` on event_id (migrations 042/043/045), and the
 * reconcile pass that made the manual row canonical had already MOVED those
 * child rows onto it — so the delete destroyed the user's uploaded bogeys and
 * the sent-email audit trail on its way out. Worse, the restored vendor event
 * then carried no preview-phase row at all, and findEmailCandidates reads
 * "no preview row" as "never emailed" — the sweep could re-send a duplicate.
 *
 * The children must be handed to the row that becomes canonical BEFORE the
 * parent goes, inside the same transaction, under the reconciler's own repoint
 * rules: bogeys and recap-phase rows unconditionally, preview-phase rows only
 * when their send date could plausibly have covered the target's print
 * (`date(sent_at) >= date(event_date,'-1 day')`).
 */
describe("deleteCalendarEvent — the hand-back must not cascade the audit trail away", () => {
  it("keeps the uploaded bogey, the recap skip and a plausible preview email, all repointed onto the restored vendor row", () => {
    const vendor = seedVendor("finnhub", "ORCL", VENDOR_DATE);
    const bogey = addBogey(vendor);
    // Sent the evening before the 09-07 print: plausible for BOTH the manual
    // 09-02 row (>= 09-01) and the vendor 09-07 row (>= 09-06).
    const preview = addEmail(vendor, "preview", "2026-09-06 20:05:00");
    const recapSkip = addSkip(vendor, "recap", "2026-08-25 12:00:00");

    confirmEarningsDate(db, {
      symbol: "ORCL",
      confirmedDate: MANUAL_DATE,
      confirmedTime: "amc",
      today: TODAY,
    });
    const manual = manualRowId("ORCL");

    // Precondition: reconcile moved every child onto the manual row, so the
    // delete is aimed straight at them.
    expect(bogeyEventId(bogey)).toBe(manual);
    expect(emailEventId(preview)).toBe(manual);
    expect(skipEventId(recapSkip)).toBe(manual);

    expect(deleteCalendarEvent(db, manual, { today: TODAY })).toBe(true);

    expect(state(vendor)!.superseded).toBe(0);
    expect(bogeyEventId(bogey)).toBe(vendor);
    expect(emailEventId(preview)).toBe(vendor);
    expect(skipEventId(recapSkip)).toBe(vendor);
  });

  it("repoints a recap email unconditionally, however old its send date", () => {
    const vendor = seedVendor("finnhub", "ORCL", VENDOR_DATE);
    // A recap documents a print that already happened; wherever it lives it is
    // honest audit, so it follows the surviving row with no date gate.
    const recap = addEmail(vendor, "recap", "2026-08-18 21:30:00");

    confirmEarningsDate(db, {
      symbol: "ORCL",
      confirmedDate: MANUAL_DATE,
      confirmedTime: "amc",
      today: TODAY,
    });
    deleteCalendarEvent(db, manualRowId("ORCL"), { today: TODAY });

    expect(emailEventId(recap)).toBe(vendor);
  });

  it("does NOT drag a preview whose send date could not cover the restored print", () => {
    const vendor = seedVendor("finnhub", "ORCL", VENDOR_DATE);
    const bogey = addBogey(vendor);
    // Sent for the manual 09-02 date. It is no evidence about the 09-07 print,
    // and dragging it there would block the genuine 09-07 preview forever
    // (findEmailCandidates treats ANY preview row as "already handled").
    const stalePreview = addEmail(vendor, "preview", "2026-09-01 20:05:00");

    confirmEarningsDate(db, {
      symbol: "ORCL",
      confirmedDate: MANUAL_DATE,
      confirmedTime: "amc",
      today: TODAY,
    });
    expect(emailEventId(stalePreview)).toBe(manualRowId("ORCL"));

    deleteCalendarEvent(db, manualRowId("ORCL"), { today: TODAY });

    // Bogeys are unconditional — the user's uploaded numbers survive.
    expect(bogeyEventId(bogey)).toBe(vendor);
    // The stale preview does not follow, and — critically — the restored
    // vendor event carries no preview row, so the real preview can still fire.
    const previewsOnVendor = db
      .prepare(
        "SELECT COUNT(*) AS n FROM earnings_emails WHERE event_id = ? AND phase = 'preview'",
      )
      .get(vendor) as { n: number };
    expect(previewsOnVendor.n).toBe(0);
  });

  it("re-clusters the survivors — a BRIDGE row's children go to the nearest print, not across the gap", () => {
    // 09-13 → 09-14 → 09-28 chains into ONE proximity cluster only because the
    // manual row bridges the 15-day gap (each hop <= CLUSTER_PROXIMITY_DAYS).
    // Once it is gone the two vendors are 15 days apart — two different prints.
    // Resolving the survivors as one cluster (rung 4, Nasdaq provisional) would
    // hand the audit to the row 14 days away instead of the one 1 day away.
    const near = seedVendor("finnhub", "ORCL", "2026-09-13");
    const far = seedVendor("nasdaq", "ORCL", "2026-09-28");

    confirmEarningsDate(db, {
      symbol: "ORCL",
      confirmedDate: "2026-09-14",
      confirmedTime: "amc",
      today: TODAY,
    });
    const manual = manualRowId("ORCL");
    const bogey = addBogey(manual);
    expect(state(near)!.superseded).toBe(1);
    expect(state(far)!.superseded).toBe(1);

    deleteCalendarEvent(db, manual, { today: TODAY });

    // Both vendors are canonical again, each its own print.
    expect(state(near)!.date_status).toBe("single");
    expect(state(far)!.date_status).toBe("single");
    expect(bogeyEventId(bogey)).toBe(near);
  });

  it("leaves children alone when the deleted manual row has no surviving twin", () => {
    confirmEarningsDate(db, {
      symbol: "ORCL",
      confirmedDate: MANUAL_DATE,
      confirmedTime: "amc",
      today: TODAY,
    });
    const manual = manualRowId("ORCL");
    const bogey = addBogey(manual);

    expect(deleteCalendarEvent(db, manual, { today: TODAY })).toBe(true);
    // Nowhere to hand it to — the cascade is the only possible outcome.
    expect(bogeyEventId(bogey)).toBeUndefined();
  });

  it("final-wave finding: never repoints a LIVE in_progress claim row onto the restored vendor row — a delete racing an in-flight send must not move the claim", () => {
    // `error='in_progress'` marks a slot a send is actively holding
    // (claimEarningsEmailSlot in lib/digest/send-earnings-email.ts). If a
    // delete of the manual row races that in-flight send, the repoint UPDATE
    // must not scoop the live claim onto the restored vendor event out from
    // under the sender — every reader of earnings_emails.error already
    // excludes 'in_progress' as a tri-state, and this writer must honor the
    // same rule.
    const vendor = seedVendor("finnhub", "ORCL", VENDOR_DATE);

    confirmEarningsDate(db, {
      symbol: "ORCL",
      confirmedDate: MANUAL_DATE,
      confirmedTime: "amc",
      today: TODAY,
    });
    const manual = manualRowId("ORCL");

    // A plausible-send-date preview claim on the doomed manual row — absent
    // the guard this WOULD repoint onto the vendor row (see the "keeps the
    // uploaded bogey..." test above, same date shape).
    const claim = addEmail(manual, "preview", "2026-09-06 20:05:00");
    db.prepare("UPDATE earnings_emails SET error = 'in_progress' WHERE id = ?").run(claim);

    expect(deleteCalendarEvent(db, manual, { today: TODAY })).toBe(true);

    // Not repointed onto the restored vendor row — and since it stayed on
    // the now-deleted manual row, ON DELETE CASCADE takes it out with the
    // parent. That's correct: the claim's own event is gone, which is
    // exactly what the 30-min stale-claim reaper
    // (reapStaleEarningsEmailClaims) exists to clean up — never silently
    // jump a live claim onto a different event mid-send.
    expect(emailEventId(claim)).toBeUndefined();
  });
});

/**
 * Finding B of the same review: `deleteAndSuppressCalendarEvent` — the DELETE
 * route's branch for SYNC-owned rows — got no hand-back at all. Deleting the
 * canonical of a conflict cluster left the other vendor's twin at
 * `superseded = 1`, and every calendar surface filters
 * `COALESCE(superseded,0) = 0`, so the name silently vanished from the
 * calendar until the next syncCalendarForWeek. Its children cascaded away too.
 */
describe("deleteAndSuppressCalendarEvent — sync-owned delete hands the print back", () => {
  it("un-supersedes the surviving twin of a conflict cluster and still writes the suppression", () => {
    const finn = seedVendor("finnhub", "ORCL", "2026-09-07");
    const nas = seedVendor("nasdaq", "ORCL", "2026-09-04");
    reconcileEarningsDates(db, { today: TODAY });

    // Genuine disagreement → Nasdaq is provisional canonical, Finnhub hidden.
    expect(state(nas)!.date_status).toBe("conflict");
    expect(state(nas)!.superseded).toBe(0);
    expect(state(finn)!.superseded).toBe(1);

    const result = deleteAndSuppressCalendarEvent(db, nas, { today: TODAY });

    expect(result.deleted).toBe(true);
    expect(result.suppressed).toEqual({
      symbol: "ORCL",
      event_date: "2026-09-04",
      event_type: "earnings",
    });
    // The bug: this stayed 1 until the next weekly sync.
    expect(state(finn)!.superseded).toBe(0);
    expect(state(finn)!.date_status).toBe("single");

    const visible = getUpcomingEvents(db, { startDate: TODAY, endDate: "2026-09-30" });
    expect(visible.map((e) => e.id)).toEqual([finn]);
  });

  it("hands the deleted canonical's bogeys + audit rows to the twin before the cascade", () => {
    const finn = seedVendor("finnhub", "ORCL", "2026-09-07");
    const nas = seedVendor("nasdaq", "ORCL", "2026-09-04");
    reconcileEarningsDates(db, { today: TODAY });

    const bogey = addBogey(nas);
    const recap = addEmail(nas, "recap", "2026-09-05 21:00:00");
    const preview = addSkip(nas, "preview", "2026-09-07 06:00:00");

    deleteAndSuppressCalendarEvent(db, nas, { today: TODAY });

    expect(bogeyEventId(bogey)).toBe(finn);
    expect(emailEventId(recap)).toBe(finn);
    expect(skipEventId(preview)).toBe(finn);
  });

  it("[R12] hands the ARM (flag + prepare steps) to the twin, and the projection shows the survivor armed with the deleted id as a tombstone", () => {
    // The repointer moves bogeys/emails/skips, but the worksheet flag and its
    // prepare-step ledger cascade on the DELETE — so before the registry merge
    // the print survived on the twin while the arm died with the row.
    const finn = seedVendor("finnhub", "ORCL", "2026-09-07");
    const nas = seedVendor("nasdaq", "ORCL", "2026-09-04");
    reconcileEarningsDates(db, { today: TODAY });
    expect(state(nas)!.superseded).toBe(0); // nasdaq is the canonical being deleted

    armWorksheet(db, nas); // generation 1: [nas armed]
    db.prepare(
      `INSERT INTO earnings_prepare_steps (event_id, step, status, input_fingerprint)
       VALUES (?, 'intel', 'done', 'fp1')`,
    ).run(nas);

    deleteAndSuppressCalendarEvent(db, nas, { today: TODAY });

    // The arm MOVED to the survivor rather than cascading away.
    expect(db.prepare("SELECT event_id FROM earnings_worksheet_flags").all()).toEqual([
      { event_id: finn },
    ]);
    expect(db.prepare("SELECT event_id, status FROM earnings_prepare_steps").all()).toEqual([
      { event_id: finn, status: "done" },
    ]);

    // …and the projection written after the delete says exactly that: the
    // survivor armed, the deleted id carried as a tombstone.
    const newest = JSON.parse(
      (
        db
          .prepare("SELECT payload_json FROM cloud_outbox ORDER BY generation DESC LIMIT 1")
          .get() as { payload_json: string }
      ).payload_json,
    ) as { entries: Array<{ eventId: number; removed?: true }> };
    expect(newest.entries.filter((e) => !e.removed).map((e) => e.eventId)).toEqual([finn]);
    expect(newest.entries.filter((e) => e.removed).map((e) => e.eventId)).toEqual([nas]);
  });

  it("still deletes + suppresses a lone sync row with no twin to hand back to", () => {
    const finn = seedVendor("finnhub", "ORCL", "2026-09-07");
    reconcileEarningsDates(db, { today: TODAY });

    const result = deleteAndSuppressCalendarEvent(db, finn, { today: TODAY });

    expect(result.deleted).toBe(true);
    expect(result.suppressed).toEqual({
      symbol: "ORCL",
      event_date: "2026-09-07",
      event_type: "earnings",
    });
    expect(state(finn)).toBeUndefined();
  });

  it("does not re-surface a same-date twin sitting on the tuple it just suppressed", () => {
    // Two vendors agreeing on the SAME wrong date is the likeliest reason a
    // user reaches for the ✕. The suppression asserts "this tuple is wrong";
    // the scoped reconcile must not answer by promoting the other vendor's row
    // on that identical date — the delete would look like it did nothing.
    const finn = seedVendor("finnhub", "ORCL", "2026-09-04");
    const nas = seedVendor("nasdaq", "ORCL", "2026-09-04");
    reconcileEarningsDates(db, { today: TODAY });
    expect(state(finn)!.date_status).toBe("confirmed"); // agreement → Finnhub canonical
    expect(state(nas)!.superseded).toBe(1);

    const result = deleteAndSuppressCalendarEvent(db, finn, { today: TODAY });

    expect(result.suppressed).toEqual({
      symbol: "ORCL",
      event_date: "2026-09-04",
      event_type: "earnings",
    });
    expect(state(nas)!.superseded).toBe(1);
    expect(state(nas)!.date_status).toBeNull();
    expect(getUpcomingEvents(db, { startDate: TODAY, endDate: "2026-09-30" })).toHaveLength(0);
  });

  it("does not drag a preview onto a twin whose print it could not have covered", () => {
    const finn = seedVendor("finnhub", "ORCL", "2026-09-07");
    const nas = seedVendor("nasdaq", "ORCL", "2026-09-04");
    reconcileEarningsDates(db, { today: TODAY }); // nasdaq provisional canonical
    const bogey = addBogey(nas);
    // Sent for the 09-04 slot; it says nothing about the 09-07 print, and
    // dragging it there would block the genuine 09-07 preview forever.
    const stale = addEmail(nas, "preview", "2026-09-04 06:00:00");

    deleteAndSuppressCalendarEvent(db, nas, { today: TODAY });

    expect(bogeyEventId(bogey)).toBe(finn); // unconditional
    expect(emailEventId(stale)).toBeUndefined();
    const previewsOnTwin = db
      .prepare(
        "SELECT COUNT(*) AS n FROM earnings_emails WHERE event_id = ? AND phase = 'preview'",
      )
      .get(finn) as { n: number };
    expect(previewsOnTwin.n).toBe(0);
  });

  it("does not re-resolve unrelated symbols", () => {
    const finn = seedVendor("finnhub", "ORCL", "2026-09-07");
    seedVendor("nasdaq", "ORCL", "2026-09-04");
    const msft = seedVendor("finnhub", "MSFT", "2026-09-09");
    reconcileEarningsDates(db, { today: TODAY });
    db.prepare("UPDATE calendar_events SET superseded = 1, date_status = NULL WHERE id = ?").run(
      msft,
    );

    deleteAndSuppressCalendarEvent(db, manualFreeCanonical("ORCL"), { today: TODAY });

    expect(state(finn)!.superseded).toBe(0);
    expect(state(msft)!.superseded).toBe(1);
    expect(state(msft)!.date_status).toBeNull();
  });
});

/** The non-superseded (canonical) sync row for a symbol. */
function manualFreeCanonical(symbol: string): number {
  return (
    db
      .prepare(
        `SELECT id FROM calendar_events
          WHERE symbol = ? AND event_type = 'earnings'
            AND source != 'manual' AND COALESCE(superseded, 0) = 0
          ORDER BY id ASC`,
      )
      .get(symbol) as { id: number }
  ).id;
}
