/**
 * correctEarningsEventDate — extracted from scripts/correct-earnings-date.ts
 * (Task 2 of the earnings date-verification plan). See that script's header
 * comment for the original rationale (the NET case: Finnhub carried
 * 2026-07-30, the real print was Aug 6).
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  correctEarningsEventDate,
  insertCalendarEvent,
  upsertCalendarEvents,
  type CalendarEventInput,
} from "@/lib/mutations/calendar";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// helper: seed a finnhub earnings row
function seedFinnhub(
  db: Database.Database,
  symbol: string,
  date: string,
  opts?: { eventTime?: string | null; sourceKeySuffix?: string; source?: string },
): number {
  const sourceKey = `${opts?.source ?? "finnhub"}:${symbol}:${date}${opts?.sourceKeySuffix ?? ""}`;
  upsertCalendarEvents(db, [
    {
      source: (opts?.source ?? "finnhub") as CalendarEventInput["source"],
      event_type: "earnings",
      event_date: date,
      event_time: opts?.eventTime ?? null,
      title: `${symbol} earnings`,
      description: null,
      symbol,
      security_id: null,
      expected_impact: "high",
      consensus_estimate: "EPS 1.00",
      previous_value: null,
      raw_json: null,
      source_key: sourceKey,
      week_of: "2026-08-03",
      release_time: "16:15",
    } as CalendarEventInput,
  ]);
  return (
    db.prepare(`SELECT id FROM calendar_events WHERE source_key = ?`).get(sourceKey) as {
      id: number;
    }
  ).id;
}

function addBogey(db: Database.Database, eventId: number, label: string): void {
  db.prepare(
    `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus) VALUES (?, 'manual', ?, 0.5)`,
  ).run(eventId, label);
}

describe("correctEarningsEventDate", () => {
  it("moves a wrong date: manual row created, wrong row deleted + suppressed, bogeys migrated", () => {
    const wrongId = seedFinnhub(db, "RKT", "2026-07-30");
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus) VALUES (?, 'manual', 'me', 0.5)`,
    ).run(wrongId);

    const res = correctEarningsEventDate(db, {
      symbol: "RKT",
      wrongDate: "2026-07-30",
      correctDate: "2026-08-06",
      slot: "AMC",
    });

    expect(res.ok).toBe(true);
    expect(res.deletedIds).toEqual([wrongId]);
    expect(res.bogeysMigrated).toBe(1);

    const manual = db
      .prepare(`SELECT id, event_date, event_time FROM calendar_events WHERE source='manual' AND symbol='RKT'`)
      .get() as { id: number; event_date: string; event_time: string };
    expect(manual.event_date).toBe("2026-08-06");
    expect(res.newEventId).toBe(manual.id);

    // bogey re-pointed onto the corrected event
    const bogey = db.prepare(`SELECT event_id FROM earnings_bogeys WHERE source_label='me'`).get() as {
      event_id: number;
    };
    expect(bogey.event_id).toBe(manual.id);

    // suppression recorded → re-sync of the wrong tuple is a no-op
    upsertCalendarEvents(db, []); // no-op sanity
    const beforeCount = (
      db
        .prepare(`SELECT COUNT(*) c FROM calendar_events WHERE symbol='RKT' AND event_date='2026-07-30'`)
        .get() as { c: number }
    ).c;
    expect(beforeCount).toBe(0);
    // re-run the same finnhub seed for the wrong (symbol, date) tuple — the
    // suppression table must block re-insert.
    upsertCalendarEvents(db, [
      {
        source: "finnhub",
        event_type: "earnings",
        event_date: "2026-07-30",
        event_time: null,
        title: "RKT earnings",
        description: null,
        symbol: "RKT",
        security_id: null,
        expected_impact: "high",
        consensus_estimate: "EPS 1.00",
        previous_value: null,
        raw_json: null,
        source_key: "finnhub:RKT:2026-07-30",
        week_of: "2026-08-03",
        release_time: "16:15",
      } as CalendarEventInput,
    ]);
    const afterCount = (
      db
        .prepare(`SELECT COUNT(*) c FROM calendar_events WHERE symbol='RKT' AND event_date='2026-07-30'`)
        .get() as { c: number }
    ).c;
    expect(afterCount).toBe(0);
  });

  it("refuses when the wrong row has captured actuals", () => {
    const id = seedFinnhub(db, "HUN", "2026-07-30");
    db.prepare(`UPDATE calendar_events SET actual_value='EPS 1.00' WHERE id=?`).run(id);

    const res = correctEarningsEventDate(db, { symbol: "HUN", wrongDate: "2026-07-30", correctDate: "2026-08-06" });

    expect(res.ok).toBe(false);
    expect(res.refusedReason).toMatch(/actuals/i);
    expect(db.prepare(`SELECT COUNT(*) c FROM calendar_events WHERE symbol='HUN'`).get()).toMatchObject({ c: 1 });
  });

  it("is idempotent: second call with no wrong rows still returns the manual row id", () => {
    seedFinnhub(db, "NET", "2026-07-30");
    const first = correctEarningsEventDate(db, { symbol: "NET", wrongDate: "2026-07-30", correctDate: "2026-08-06" });
    const second = correctEarningsEventDate(db, {
      symbol: "NET",
      wrongDate: "2026-07-30",
      correctDate: "2026-08-06",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.newEventId).toBe(first.newEventId);
    expect(second.deletedIds).toEqual([]);
  });

  it("defaults the slot to the wrong row's event_time when not passed", () => {
    seedFinnhub(db, "BMO1", "2026-07-30"); // release_time seeded '16:15' but event_time null in upsert path
    db.prepare(`UPDATE calendar_events SET event_time = 'BMO' WHERE symbol = 'BMO1'`).run();

    const res = correctEarningsEventDate(db, { symbol: "BMO1", wrongDate: "2026-07-30", correctDate: "2026-08-06" });

    expect(res.ok).toBe(true);
    const manual = db
      .prepare(`SELECT event_time FROM calendar_events WHERE source='manual' AND symbol='BMO1'`)
      .get() as { event_time: string };
    expect(manual.event_time).toBe("BMO");
  });

  // ── F1 (CRITICAL): the corrected row must never be in the delete set ──────
  //
  // On a SLOT correction wrongDate === correctDate, so every earnings row on
  // that date is a "wrong row" — including a pre-existing manual row that the
  // UNIQUE-collision fallback then adopts as newEventId. Without filtering the
  // delete/migrate loops by `id !== newEventId`, step 3 deleted the corrected
  // row itself AND suppressed its tuple, making the event unrecoverable
  // (suppression blocks re-sync; the migrated bogeys died in the CASCADE).
  it("never deletes the corrected row itself when a manual row already exists on correctDate", () => {
    const manualId = insertCalendarEvent(db, {
      symbol: "LLY",
      event_date: "2026-08-05",
      event_type: "earnings",
      event_time: "AMC",
      week_of: "2026-08-03",
    }).id;
    const vendorId = seedFinnhub(db, "LLY", "2026-08-05", { eventTime: "BMO" });
    addBogey(db, vendorId, "vendor-bogey");

    const res = correctEarningsEventDate(db, {
      symbol: "LLY",
      wrongDate: "2026-08-05",
      correctDate: "2026-08-05",
      slot: "AMC",
    });

    expect(res.ok).toBe(true);
    expect(res.newEventId).toBe(manualId);
    // ONLY the vendor row is deleted — the corrected row survives.
    expect(res.deletedIds).toEqual([vendorId]);

    const survivor = db.prepare(`SELECT id, event_date, event_time FROM calendar_events WHERE id = ?`).get(manualId) as
      | { id: number; event_date: string; event_time: string }
      | undefined;
    expect(survivor).toBeDefined();
    expect(survivor!.event_date).toBe("2026-08-05");

    // Bogeys from the deleted vendor row landed on the survivor (not CASCADEd away).
    const bogey = db.prepare(`SELECT event_id FROM earnings_bogeys WHERE source_label='vendor-bogey'`).get() as
      | { event_id: number }
      | undefined;
    expect(bogey).toBeDefined();
    expect(bogey!.event_id).toBe(manualId);
  });

  // ── Adoption (reviewer Recommendation 3) ─────────────────────────────────
  it("adopts an existing non-manual row on correctDate whose slot agrees, clearing superseded", () => {
    const wrongId = seedFinnhub(db, "MELI", "2026-08-03", { eventTime: "AMC" });
    addBogey(db, wrongId, "meli-bogey");
    const adoptId = seedFinnhub(db, "MELI", "2026-08-05", {
      eventTime: "AMC",
      source: "nasdaq",
    });
    db.prepare(`UPDATE calendar_events SET superseded = 1 WHERE id = ?`).run(adoptId);

    const res = correctEarningsEventDate(db, {
      symbol: "MELI",
      wrongDate: "2026-08-03",
      correctDate: "2026-08-05",
      slot: "AMC",
    });

    expect(res.ok).toBe(true);
    expect(res.newEventId).toBe(adoptId);
    expect(res.deletedIds).toEqual([wrongId]);

    // No manual row minted — the vendor row (and its finnhub enrichment road) is kept.
    const manualCount = (
      db
        .prepare(`SELECT COUNT(*) c FROM calendar_events WHERE source='manual' AND symbol='MELI'`)
        .get() as { c: number }
    ).c;
    expect(manualCount).toBe(0);

    const adopted = db.prepare(`SELECT superseded FROM calendar_events WHERE id = ?`).get(adoptId) as {
      superseded: number;
    };
    expect(adopted.superseded).toBe(0);

    expect(res.bogeysMigrated).toBe(1);
    const bogey = db.prepare(`SELECT event_id FROM earnings_bogeys WHERE source_label='meli-bogey'`).get() as {
      event_id: number;
    };
    expect(bogey.event_id).toBe(adoptId);

    // The wrong tuple is still suppressed so the next sync can't resurrect it.
    const suppressed = (
      db
        .prepare(
          `SELECT COUNT(*) c FROM calendar_event_suppressions WHERE symbol='MELI' AND event_date='2026-08-03'`,
        )
        .get() as { c: number }
    ).c;
    expect(suppressed).toBe(1);
  });

  it("mints a manual row (carrying vendor consensus) when the correctDate row's slot disagrees", () => {
    const wrongId = seedFinnhub(db, "DOCN", "2026-08-04", { eventTime: "AMC" });
    const disagreeingId = seedFinnhub(db, "DOCN", "2026-08-05", {
      eventTime: "BMO",
      source: "nasdaq",
    });

    const res = correctEarningsEventDate(db, {
      symbol: "DOCN",
      wrongDate: "2026-08-04",
      correctDate: "2026-08-05",
      slot: "AMC",
    });

    expect(res.ok).toBe(true);
    expect(res.newEventId).not.toBe(disagreeingId);
    expect(res.deletedIds).toEqual([wrongId]);

    const manual = db
      .prepare(
        `SELECT id, event_time, consensus_estimate, expected_impact
           FROM calendar_events WHERE source='manual' AND symbol='DOCN'`,
      )
      .get() as {
      id: number;
      event_time: string;
      consensus_estimate: string | null;
      expected_impact: string | null;
    };
    expect(manual.id).toBe(res.newEventId);
    expect(manual.event_time).toBe("AMC");
    // F3: the vendor's consensus rides along instead of being dropped.
    expect(manual.consensus_estimate).toBe("EPS 1.00");
    expect(manual.expected_impact).toBe("high");
  });

  // ── F3: consensus carry on the plain date-move path ──────────────────────
  it("carries the wrong row's consensus_estimate onto the corrected manual row", () => {
    seedFinnhub(db, "RRX", "2026-08-04");
    db.prepare(`UPDATE calendar_events SET consensus_estimate = 'EPS 2.71 · Rev 1.2B' WHERE symbol='RRX'`).run();

    const res = correctEarningsEventDate(db, {
      symbol: "RRX",
      wrongDate: "2026-08-04",
      correctDate: "2026-08-05",
    });

    expect(res.ok).toBe(true);
    const manual = db
      .prepare(`SELECT consensus_estimate FROM calendar_events WHERE source='manual' AND symbol='RRX'`)
      .get() as { consensus_estimate: string | null };
    expect(manual.consensus_estimate).toBe("EPS 2.71 · Rev 1.2B");
  });

  it("refuses an unchanged date+slot submission without touching the vendor row", () => {
    // WIX case (qa:today-earningshub-fix-date--unchanged-submit-destroys-vendor-row):
    // popover submitted with the pre-filled date and the row's own slot —
    // nothing to change, so nothing may be deleted, suppressed, or re-minted.
    const id = seedFinnhub(db, "WIX", "2026-08-04", { eventTime: "AMC" });
    const result = correctEarningsEventDate(db, {
      symbol: "WIX",
      wrongDate: "2026-08-04",
      correctDate: "2026-08-04",
      slot: "AMC",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("no_change");

    const survivor = db
      .prepare(`SELECT id, source FROM calendar_events WHERE symbol = 'WIX'`)
      .get() as { id: number; source: string };
    expect(survivor).toEqual({ id, source: "finnhub" });
    const suppressed = db
      .prepare(`SELECT COUNT(*) AS n FROM calendar_event_suppressions WHERE symbol = 'WIX'`)
      .get() as { n: number };
    expect(suppressed.n).toBe(0);
  });

  it("refuses a same-date submission with no slot at all", () => {
    const id = seedFinnhub(db, "WIX", "2026-08-04");
    const result = correctEarningsEventDate(db, {
      symbol: "WIX",
      wrongDate: "2026-08-04",
      correctDate: "2026-08-04",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("no_change");
    const survivor = db
      .prepare(`SELECT id FROM calendar_events WHERE symbol = 'WIX'`)
      .get() as { id: number };
    expect(survivor.id).toBe(id);
  });

  it("still performs a genuine same-date slot flip", () => {
    seedFinnhub(db, "IMAX", "2026-08-04", { eventTime: "AMC" });
    const result = correctEarningsEventDate(db, {
      symbol: "IMAX",
      wrongDate: "2026-08-04",
      correctDate: "2026-08-04",
      slot: "BMO",
    });
    expect(result.ok).toBe(true);
  });

  // ── QA: slot-only change silently discarded on UNIQUE-conflict adopt ─────
  // (qa:today-earningshub-fix-date--slot-only-change-200-writes-nothing)
  //
  // Once a symbol has already been corrected once, it sits on a MANUAL row
  // (source_key `manual:<symbol>:<date>:earnings`). A second, slot-only
  // correction on the same date re-attempts an insert with that identical
  // source_key, collides on the UNIQUE constraint, and falls into the
  // adopt-existing catch branch. Before the fix, that branch adopted the
  // pre-existing row's id but never touched its event_time — the caller got
  // 200 {success:true} while the row's slot stayed exactly as wrong as
  // before (repro: HD, event id 1444, event_time stuck at 'BMO').
  it("persists a slot-only change onto an already-adopted manual row (UNIQUE-conflict adopt)", () => {
    const manualId = insertCalendarEvent(db, {
      symbol: "HD",
      event_date: "2026-08-18",
      event_type: "earnings",
      event_time: "BMO",
      week_of: "2026-08-17",
    }).id;

    const res = correctEarningsEventDate(db, {
      symbol: "HD",
      wrongDate: "2026-08-18",
      correctDate: "2026-08-18",
      slot: "AMC",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Same row adopted (no other row existed on that date) — nothing to delete.
    expect(res.newEventId).toBe(manualId);
    expect(res.deletedIds).toEqual([]);

    const row = db
      .prepare(`SELECT event_time FROM calendar_events WHERE id = ?`)
      .get(manualId) as { event_time: string };
    expect(row.event_time).toBe("AMC");
  });

  it("treats a lowercase slot that matches the stored uppercase slot as no_change (case-insensitive)", () => {
    const manualId = insertCalendarEvent(db, {
      symbol: "HD",
      event_date: "2026-08-18",
      event_type: "earnings",
      event_time: "AMC",
      week_of: "2026-08-17",
    }).id;

    const res = correctEarningsEventDate(db, {
      symbol: "HD",
      wrongDate: "2026-08-18",
      correctDate: "2026-08-18",
      // Simulates an off-contract caller (the route already uppercases, but
      // the lib is a public seam other callers can hit directly).
      slot: "amc" as unknown as "BMO" | "AMC",
    });

    expect(res.ok).toBe(false);
    expect(res.code).toBe("no_change");

    const row = db
      .prepare(`SELECT event_time FROM calendar_events WHERE id = ?`)
      .get(manualId) as { event_time: string };
    expect(row.event_time).toBe("AMC"); // untouched
    const rowCount = (
      db.prepare(`SELECT COUNT(*) c FROM calendar_events WHERE symbol='HD'`).get() as { c: number }
    ).c;
    expect(rowCount).toBe(1); // no phantom row minted
  });

  // ── Sent-email audit preservation (QA 2026-08-07) ─────────────────────────
  // A date/slot correction must carry earnings_emails + earnings_email_skips
  // onto the corrected row the same way earnings_bogeys migrate — pre-fix the
  // delete CASCADE destroyed the archived email and made the event a send
  // candidate again (duplicate-preview risk via findEmailCandidates).

  function addSentEmail(
    db2: import("better-sqlite3").Database,
    eventId: number,
    phase: string,
    md: string,
    sentAt = "2026-08-05 20:00:00", // in-window for a 2026-08-05 correctDate
  ): void {
    db2
      .prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, sent_at)
         VALUES (?, ?, 'me@example.com', ?, ?)`,
      )
      .run(eventId, phase, md, sentAt);
  }

  it("moves an armed doomed row's worksheet flag onto the corrected row, writing exactly one outbox row", () => {
    const wrongId = seedFinnhub(db, "VRTX", "2026-08-03", { eventTime: "AMC" });
    armWorksheet(db, wrongId); // generation 1: [wrongId armed]
    const outboxRows = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM cloud_outbox").get() as { n: number }).n;
    const before = outboxRows();

    const res = correctEarningsEventDate(db, {
      symbol: "VRTX",
      wrongDate: "2026-08-03",
      correctDate: "2026-08-05",
      slot: "AMC",
    });

    expect(res.ok).toBe(true);
    // The arm followed the print instead of dying in the delete CASCADE.
    expect(db.prepare(`SELECT event_id FROM earnings_worksheet_flags`).all()).toEqual([
      { event_id: res.newEventId },
    ]);
    // [C-13] ONE row for the whole correction, not one per doomed row.
    expect(outboxRows()).toBe(before + 1);
  });

  // ── Preview plausibility gate on the correction path (Ruling R15) ────────
  //
  // A preview is a promise about ONE print, and findEmailCandidates treats any
  // preview-phase row on an event as "already handled". So even here — where
  // the USER is asserting the two dates are the same print — a preview whose
  // send date could not have covered the CORRECTED date does not follow it:
  // dragging it would both fabricate "preview sent" for a print the email
  // never covered and block the genuine preview from ever firing. Recap rows
  // are post-print audit and follow the print unconditionally.

  it("[R15] does NOT migrate a preview whose send date could not cover the corrected print (it dies with the doomed row)", () => {
    const wrongId = seedFinnhub(db, "VRTX", "2026-08-03", { eventTime: "AMC" });
    // Sent for the phantom 08-03 print; the corrected date is 08-05, so the
    // gate is date('2026-08-03') >= date('2026-08-05','-1 day') → false.
    addSentEmail(db, wrongId, "preview", "# phantom-date prose", "2026-08-03 20:00:00");
    db.prepare(
      `INSERT INTO earnings_email_skips (event_id, phase, skipped_at) VALUES (?, 'preview', '2026-08-03 20:00:00')`,
    ).run(wrongId);

    const res = correctEarningsEventDate(db, {
      symbol: "VRTX",
      wrongDate: "2026-08-03",
      correctDate: "2026-08-05",
      slot: "AMC",
    });

    expect(res.ok).toBe(true);
    // It stayed on the doomed row and went with it in the DELETE cascade —
    // so the corrected row is clean and the genuine preview can still fire.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_emails`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_email_skips`).get()).toEqual({ n: 0 });
  });

  it("[R15] DOES migrate a preview sent inside the corrected print's window", () => {
    const wrongId = seedFinnhub(db, "VRTX", "2026-08-03", { eventTime: "AMC" });
    // One day before the corrected 08-05 print — the gate's boundary, inclusive.
    addSentEmail(db, wrongId, "preview", "# in-window prose", "2026-08-04 18:00:00");
    db.prepare(
      `INSERT INTO earnings_email_skips (event_id, phase, skipped_at) VALUES (?, 'preview', '2026-08-04 18:00:00')`,
    ).run(wrongId);

    const res = correctEarningsEventDate(db, {
      symbol: "VRTX",
      wrongDate: "2026-08-03",
      correctDate: "2026-08-05",
      slot: "AMC",
    });

    expect(res.ok).toBe(true);
    expect(
      db.prepare(`SELECT event_id, ai_output_md FROM earnings_emails WHERE phase='preview'`).get(),
    ).toEqual({ event_id: res.newEventId, ai_output_md: "# in-window prose" });
    expect(db.prepare(`SELECT event_id FROM earnings_email_skips`).get()).toEqual({
      event_id: res.newEventId,
    });
  });

  it("[R15] migrates a RECAP row unconditionally, however far its send date is from the corrected print", () => {
    const wrongId = seedFinnhub(db, "VRTX", "2026-08-03", { eventTime: "AMC" });
    addSentEmail(db, wrongId, "recap", "# recap prose", "2026-07-20 21:00:00");
    db.prepare(
      `INSERT INTO earnings_email_skips (event_id, phase, skipped_at) VALUES (?, 'recap', '2026-07-20 21:00:00')`,
    ).run(wrongId);

    const res = correctEarningsEventDate(db, {
      symbol: "VRTX",
      wrongDate: "2026-08-03",
      correctDate: "2026-08-05",
      slot: "AMC",
    });

    expect(res.ok).toBe(true);
    expect(
      db.prepare(`SELECT event_id, ai_output_md FROM earnings_emails WHERE phase='recap'`).get(),
    ).toEqual({ event_id: res.newEventId, ai_output_md: "# recap prose" });
    expect(db.prepare(`SELECT event_id FROM earnings_email_skips`).get()).toEqual({
      event_id: res.newEventId,
    });
  });

  it("migrates earnings_emails audit rows onto the corrected row on a date change", () => {
    const wrongId = seedFinnhub(db, "VRTX", "2026-08-03");
    // Explicit in-window send date: this test pins the MIGRATION, so it must
    // not depend on addSentEmail's default clearing the plausibility gate.
    addSentEmail(db, wrongId, "preview", "# VRTX preview prose", "2026-08-04 20:00:00");
    db.prepare(`INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, 'recap')`).run(wrongId);

    const res = correctEarningsEventDate(db, {
      symbol: "VRTX",
      wrongDate: "2026-08-03",
      correctDate: "2026-08-05",
      slot: "AMC",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const email = db
      .prepare(`SELECT event_id, ai_output_md FROM earnings_emails WHERE phase='preview'`)
      .get() as { event_id: number; ai_output_md: string };
    expect(email.event_id).toBe(res.newEventId);
    expect(email.ai_output_md).toBe("# VRTX preview prose");

    const skip = db
      .prepare(`SELECT event_id FROM earnings_email_skips WHERE phase='recap'`)
      .get() as { event_id: number };
    expect(skip.event_id).toBe(res.newEventId);
  });

  it("preserves the sent-email audit through a slot-only (same-date) correction", () => {
    const wrongId = seedFinnhub(db, "VRTX", "2026-08-03", { eventTime: "AMC" });
    addSentEmail(db, wrongId, "preview", "# VRTX preview prose");

    const res = correctEarningsEventDate(db, {
      symbol: "VRTX",
      wrongDate: "2026-08-03",
      correctDate: "2026-08-03",
      slot: "BMO",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const email = db
      .prepare(`SELECT event_id, ai_output_md FROM earnings_emails WHERE phase='preview'`)
      .get() as { event_id: number; ai_output_md: string };
    expect(email.event_id).toBe(res.newEventId);
    expect(email.ai_output_md).toBe("# VRTX preview prose");
  });

  it("keeps the corrected row's own audit row on a UNIQUE collision (doomed duplicate cascades)", () => {
    const wrongId = seedFinnhub(db, "MELI", "2026-08-03");
    const rightId = seedFinnhub(db, "MELI", "2026-08-05", {
      eventTime: "AMC",
      sourceKeySuffix: ":right",
    });
    addSentEmail(db, wrongId, "preview", "# wrong-row prose");
    addSentEmail(db, rightId, "preview", "# right-row prose");

    const res = correctEarningsEventDate(db, {
      symbol: "MELI",
      wrongDate: "2026-08-03",
      correctDate: "2026-08-05",
      slot: "AMC",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.newEventId).toBe(rightId); // adoption path

    const emails = db
      .prepare(`SELECT event_id, ai_output_md FROM earnings_emails WHERE phase='preview'`)
      .all() as Array<{ event_id: number; ai_output_md: string }>;
    expect(emails).toHaveLength(1);
    expect(emails[0].event_id).toBe(rightId);
    expect(emails[0].ai_output_md).toBe("# right-row prose");
  });

  it("falls back to AMC when there is no wrong row and no slot passed", () => {
    const res = correctEarningsEventDate(db, {
      symbol: "ZZZ",
      wrongDate: "2026-07-30",
      correctDate: "2026-08-06",
    });

    expect(res.ok).toBe(true);
    expect(res.deletedIds).toEqual([]);
    const manual = db
      .prepare(`SELECT event_time FROM calendar_events WHERE source='manual' AND symbol='ZZZ'`)
      .get() as { event_time: string };
    expect(manual.event_time).toBe("AMC");
  });
});
