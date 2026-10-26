/**
 * A preview sent (or skipped) for a hand-entered row's old date is released
 * when the row moves to a LATER date the preview could not cover (owner
 * ruling 2026-10-26 #7; controller ruling: release = delete). Same test as
 * the repoint invariant: `date(sent_at) >= date(event_date, '-1 day')` covers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";
import {
  correctEarningsEventDate,
  insertCalendarEvent,
  updateCalendarEvent,
} from "@/lib/mutations/calendar";
import { confirmEarningsDate } from "@/lib/mutations/confirm-earnings-date";
import { releaseStalePreviewOnMove } from "@/lib/earnings/release-stale-preview";
import { recordCloudSentAudit } from "@/lib/mutations/earnings-emails";
import { sendEarningsCandidate } from "@/lib/earnings/send-service";
import { mondayOf } from "@/lib/calendar/date-utils";
import { DELIVERY_UNKNOWN, IN_PROGRESS, SENDING, SENT_BY_CLOUD } from "@/lib/earnings/email-states";

let db: Database.Database;

// 2026-06-01 and 2026-06-08 are Mondays in daylight time (ET = UTC-4).
const OLD = "2026-06-01";
const NEXT_DAY = "2026-06-02";
const WEEK_LATER = "2026-06-08";
const EARLIER = "2026-05-29";
/** The old date's preview went out two hours before its 16:15 release. */
const SENT_FOR_OLD = "2026-06-01 18:15:00";
/** 14:15 ET on a date: inside the preview window of a 16:15 release. */
const windowOn = (date: string) => new Date(`${date}T18:15:00Z`);

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function seedHeldSecurity(symbol: string): number {
  const accountId = (
    db.prepare("INSERT INTO accounts (name) VALUES (?) RETURNING id").get(`acct-${symbol}`) as { id: number }
  ).id;
  const securityId = (
    db
      .prepare(
        `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
         VALUES (?, 'stock', 'equity', 1) RETURNING id`,
      )
      .get(symbol) as { id: number }
  ).id;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
     VALUES (?, ?, 100, date('now'))`,
  ).run(accountId, securityId);
  return securityId;
}

function addManual(symbol = "ZZQ", date = OLD): number {
  const securityId = seedHeldSecurity(symbol);
  return insertCalendarEvent(db, {
    symbol,
    event_date: date,
    event_type: "earnings",
    event_time: "AMC",
    release_time: "16:15",
    security_id: securityId,
    week_of: mondayOf(date),
  }).id;
}

function addVendor(symbol = "ZZV", date = OLD): number {
  const securityId = seedHeldSecurity(symbol);
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, release_time, title, symbol,
                                      security_id, source_key, week_of)
         VALUES ('finnhub','earnings',?,'16:15',?,?,?,?,?)`,
      )
      .run(date, `${symbol} earnings`, symbol, securityId, `finnhub:${symbol}:${date}`, mondayOf(date))
      .lastInsertRowid,
  );
}

function sentPreview(eventId: number, error: string | null = null, sentAt = SENT_FOR_OLD): void {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error)
     VALUES (?, 'preview', 'desk@example.com', ?, ?)`,
  ).run(eventId, sentAt, error);
}

function skippedPreview(eventId: number, skippedAt = SENT_FOR_OLD): void {
  db.prepare(
    `INSERT INTO earnings_email_skips (event_id, phase, skipped_at) VALUES (?, 'preview', ?)`,
  ).run(eventId, skippedAt);
}

const emailCount = (eventId: number) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM earnings_emails WHERE event_id = ? AND phase = 'preview'`).get(eventId) as {
    n: number;
  }).n;
const skipCount = (eventId: number) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM earnings_email_skips WHERE event_id = ? AND phase = 'preview'`).get(
    eventId,
  ) as { n: number }).n;
const previewIds = (date: string) =>
  findEmailCandidates(db, { now: windowOn(date) })
    .filter((c) => c.phase === "preview")
    .map((c) => c.eventId);

describe("releaseStalePreviewOnMove — the rule", () => {
  it("a move of one day keeps the preview (it still covers the print)", () => {
    const id = addManual();
    sentPreview(id);
    db.prepare(`UPDATE calendar_events SET event_date = ? WHERE id = ?`).run(NEXT_DAY, id);
    expect(releaseStalePreviewOnMove(db, { eventId: id, fromDate: OLD, toDate: NEXT_DAY })).toEqual({
      emails: 0,
      skips: 0,
    });
    expect(emailCount(id)).toBe(1);
  });

  it("a move of a week releases the preview and logs one line with no figures", () => {
    const info = vi.mocked(console.info);
    const id = addManual();
    sentPreview(id);
    expect(releaseStalePreviewOnMove(db, { eventId: id, fromDate: OLD, toDate: WEEK_LATER })).toEqual({
      emails: 1,
      skips: 0,
    });
    expect(emailCount(id)).toBe(0);
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      `[release-stale-preview] event ${id} phase preview: sent preview released (old date ${OLD}, new date ${WEEK_LATER})`,
    ]);
  });

  it("an earlier move keeps the preview, even one sent long before", () => {
    const id = addManual();
    sentPreview(id, null, "2026-05-01 12:00:00");
    expect(releaseStalePreviewOnMove(db, { eventId: id, fromDate: OLD, toDate: EARLIER }).emails).toBe(0);
    expect(emailCount(id)).toBe(1);
  });

  it("a vendor (sync-owned) row is never touched", () => {
    const id = addVendor();
    sentPreview(id);
    skippedPreview(id);
    expect(releaseStalePreviewOnMove(db, { eventId: id, fromDate: OLD, toDate: WEEK_LATER })).toEqual({
      emails: 0,
      skips: 0,
    });
    expect(emailCount(id)).toBe(1);
    expect(skipCount(id)).toBe(1);
  });

  it.each([IN_PROGRESS, SENDING])("a live claim (%s) is never touched", (state) => {
    const id = addManual();
    sentPreview(id, state);
    expect(releaseStalePreviewOnMove(db, { eventId: id, fromDate: OLD, toDate: WEEK_LATER }).emails).toBe(0);
    expect(emailCount(id)).toBe(1);
  });

  it.each([SENT_BY_CLOUD, DELIVERY_UNKNOWN])("a completed %s row is released", (state) => {
    const id = addManual();
    sentPreview(id, state);
    expect(releaseStalePreviewOnMove(db, { eventId: id, fromDate: OLD, toDate: WEEK_LATER }).emails).toBe(1);
    expect(emailCount(id)).toBe(0);
  });

  it("a recap row is never touched", () => {
    const id = addManual();
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at) VALUES (?, 'recap', 'd@example.com', ?)`,
    ).run(id, SENT_FOR_OLD);
    releaseStalePreviewOnMove(db, { eventId: id, fromDate: OLD, toDate: WEEK_LATER });
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM earnings_emails WHERE event_id = ?`).get(id) as { n: number }).n,
    ).toBe(1);
  });

  it("a preview skip follows the same test on skipped_at", () => {
    const keep = addManual("ZZK");
    const release = addManual("ZZR");
    skippedPreview(keep);
    skippedPreview(release);
    expect(releaseStalePreviewOnMove(db, { eventId: keep, fromDate: OLD, toDate: NEXT_DAY }).skips).toBe(0);
    expect(releaseStalePreviewOnMove(db, { eventId: release, fromDate: OLD, toDate: WEEK_LATER }).skips).toBe(1);
    expect(skipCount(keep)).toBe(1);
    expect(skipCount(release)).toBe(0);
  });
});

describe("path 1: updateCalendarEvent (PATCH /api/calendar/events)", () => {
  it("moved a week later: the preview is released and the new date gets a preview candidate", () => {
    const id = addManual();
    sentPreview(id);
    expect(previewIds(WEEK_LATER)).toEqual([]); // not in window yet on the old date
    updateCalendarEvent(db, { id, event_date: WEEK_LATER, week_of: mondayOf(WEEK_LATER) });
    expect(emailCount(id)).toBe(0);
    expect(previewIds(WEEK_LATER)).toEqual([id]);
  });

  it("moved one day later: the preview is kept and no second preview is offered", () => {
    const id = addManual();
    sentPreview(id);
    updateCalendarEvent(db, { id, event_date: NEXT_DAY });
    expect(emailCount(id)).toBe(1);
    expect(previewIds(NEXT_DAY)).toEqual([]);
  });

  it("moved earlier: the preview is kept", () => {
    const id = addManual();
    sentPreview(id, null, "2026-05-01 12:00:00");
    updateCalendarEvent(db, { id, event_date: EARLIER });
    expect(emailCount(id)).toBe(1);
  });

  it("a preview skip for the old date stops blocking the new date", () => {
    const id = addManual();
    skippedPreview(id);
    updateCalendarEvent(db, { id, event_date: WEEK_LATER, week_of: mondayOf(WEEK_LATER) });
    expect(skipCount(id)).toBe(0);
    expect(previewIds(WEEK_LATER)).toEqual([id]);
  });

  it("an edit that does not change the date keeps everything", () => {
    const id = addManual();
    sentPreview(id);
    updateCalendarEvent(db, { id, description: "note" });
    expect(emailCount(id)).toBe(1);
  });
});

describe("path 2: confirmEarningsDate moves the hand-entered row", () => {
  const today = "2026-05-25";

  it("confirmed a week later: the moved row's preview is released", () => {
    const id = addManual();
    sentPreview(id);
    const res = confirmEarningsDate(db, { symbol: "ZZQ", confirmedDate: WEEK_LATER, confirmedTime: "amc", today });
    expect(res).toMatchObject({ ok: true, movedEventId: id });
    expect(emailCount(id)).toBe(0);
    expect(previewIds(WEEK_LATER)).toEqual([id]);
  });

  it("confirmed one day later: the preview is kept", () => {
    const id = addManual();
    sentPreview(id);
    const res = confirmEarningsDate(db, { symbol: "ZZQ", confirmedDate: NEXT_DAY, confirmedTime: "amc", today });
    expect(res).toMatchObject({ ok: true, movedEventId: id });
    expect(emailCount(id)).toBe(1);
  });

  it("confirmed earlier: the preview is kept", () => {
    const id = addManual();
    sentPreview(id, null, "2026-05-20 12:00:00");
    const res = confirmEarningsDate(db, { symbol: "ZZQ", confirmedDate: EARLIER, confirmedTime: "amc", today });
    expect(res).toMatchObject({ ok: true, movedEventId: id });
    expect(emailCount(id)).toBe(1);
  });
});

describe("path 3: correctEarningsEventDate (POST /api/earnings/correct-date) already releases", () => {
  it("a hand-entered row corrected a week later: the new row has no preview and is offered one", () => {
    const id = addManual();
    sentPreview(id);
    const res = correctEarningsEventDate(db, { symbol: "ZZQ", wrongDate: OLD, correctDate: WEEK_LATER });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.newEventId).not.toBe(id);
    expect(emailCount(res.newEventId!)).toBe(0);
    // The corrected row has no release_time of its own here unless the
    // cascade gave it one; give it the old row's time to test the window.
    db.prepare(`UPDATE calendar_events SET release_time = '16:15' WHERE id = ?`).run(res.newEventId);
    expect(previewIds(WEEK_LATER)).toEqual([res.newEventId]);
  });

  it("corrected one day later: the preview follows the print, no second preview", () => {
    addManual();
    const id = (db.prepare(`SELECT id FROM calendar_events WHERE symbol = 'ZZQ'`).get() as { id: number }).id;
    sentPreview(id);
    const res = correctEarningsEventDate(db, { symbol: "ZZQ", wrongDate: OLD, correctDate: NEXT_DAY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(emailCount(res.newEventId!)).toBe(1);
  });
});

describe("the cloud-sent marker does not bring a released preview back", () => {
  it("recordCloudSentAudit skips a preview marker sent before the day before the event's date", () => {
    const id = addManual();
    updateCalendarEvent(db, { id, event_date: WEEK_LATER, week_of: mondayOf(WEEK_LATER) });
    expect(recordCloudSentAudit(db, id, "preview", "2026-06-01T18:15:00.000Z")).toBe(0);
    expect(emailCount(id)).toBe(0);
    expect(previewIds(WEEK_LATER)).toEqual([id]);
  });

  it("a marker that covers the event is still recorded (unchanged behaviour)", () => {
    const id = addManual();
    expect(recordCloudSentAudit(db, id, "preview", "2026-06-01T18:15:00.000Z")).toBe(1);
    expect(emailCount(id)).toBe(1);
  });

  it("a marker with no send time keeps the old behaviour", () => {
    const id = addManual("ZZQ", WEEK_LATER);
    expect(recordCloudSentAudit(db, id, "preview", null)).toBe(1);
  });

  it("a recap marker is never filtered", () => {
    const id = addManual("ZZQ", WEEK_LATER);
    expect(recordCloudSentAudit(db, id, "recap", "2026-05-01T12:00:00.000Z")).toBe(1);
  });

  describe("the per-candidate marker check in the send service", () => {
    beforeEach(() => {
      vi.stubEnv("WORKER_MARKER_URL", "");
      vi.stubEnv("CRON_SHARED_SECRET", "");
    });
    afterEach(() => vi.unstubAllEnvs());

    const composed = {
      symbol: "ZZQ",
      title: "ZZQ preview",
      markdown: "# ZZQ",
      aiMarkdown: "body",
      html: "<p>body</p>",
      promptHash: "h",
    };
    const markers = {
      setRunning: async () => {},
      clearRunning: async () => {},
      writeMacSent: async () => {},
    };

    it("a stale cloud preview marker (old date) is ignored and the new date's preview is sent", async () => {
      const id = addManual();
      updateCalendarEvent(db, { id, event_date: WEEK_LATER, week_of: mondayOf(WEEK_LATER) });
      const sendEmail = vi.fn(async (o: { messageId?: string }) => ({ messageId: o.messageId!, response: "250 OK" }));
      const res = await sendEarningsCandidate(db, { eventId: id, symbol: "ZZQ", phase: "preview" }, {
        mode: "sweep",
        recipient: "desk@example.com",
        seams: {
          compose: async () => composed,
          sendEmail,
          markers,
          checkCloudMarker: async () => ({ sentBy: "cloud" as const }),
          cloudSentAt: async () => "2026-06-01T18:15:00.000Z",
        },
      });
      expect(res).toMatchObject({ outcome: "sent" });
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it("a cloud preview marker that covers the event still answers already_sent", async () => {
      const id = addManual("ZZQ", WEEK_LATER);
      const sendEmail = vi.fn();
      const res = await sendEarningsCandidate(db, { eventId: id, symbol: "ZZQ", phase: "preview" }, {
        mode: "sweep",
        recipient: "desk@example.com",
        seams: {
          compose: async () => composed,
          sendEmail,
          markers,
          checkCloudMarker: async () => ({ sentBy: "cloud" as const }),
          cloudSentAt: async () => "2026-06-08T18:15:00.000Z",
        },
      });
      expect(res).toMatchObject({ outcome: "already_sent", sentBy: "cloud" });
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("an unknown marker time keeps the marker (no duplicate risk taken)", async () => {
      const id = addManual("ZZQ", WEEK_LATER);
      const sendEmail = vi.fn();
      const res = await sendEarningsCandidate(db, { eventId: id, symbol: "ZZQ", phase: "preview" }, {
        mode: "sweep",
        recipient: "desk@example.com",
        seams: {
          compose: async () => composed,
          sendEmail,
          markers,
          checkCloudMarker: async () => ({ sentBy: "cloud" as const }),
          cloudSentAt: async () => null,
        },
      });
      expect(res).toMatchObject({ outcome: "already_sent" });
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });
});
