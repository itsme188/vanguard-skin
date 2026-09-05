/**
 * The `earnings_emails.error` readers after the slice E vocabulary sweep
 * (live print v2, migration 092 — lib/earnings/email-states.ts).
 *
 * Two values joined the column and every reader had to learn both:
 *   'sending'          — a LIVE claim (the provider call is on the wire).
 *                        Nothing is delivered, so the "sent" readers hide it
 *                        exactly the way they always hid 'in_progress'.
 *   'delivery_unknown' — TERMINAL. We may well have delivered; we never heard
 *                        back. It reads as sent everywhere an automatic
 *                        resend would otherwise fire, and carries its own
 *                        flag so a human can close it by hand.
 *
 * Synthetic throughout (ticker XMPL, me@example.com).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getEmailAudit,
  getSentPhasesForEvents,
  getSentEarningsEmails,
  getEmailStatesForEvents,
} from "@/lib/queries/earnings-emails";
import { markEmailDeliveredByHand } from "@/lib/mutations/earnings-emails";

let db: Database.Database;
let eventId: number;

function seedEmail(phase: "preview" | "recap", error: string | null, prose = "# body") {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
     VALUES (?, ?, 'me@example.com', datetime('now'), ?, ?)`,
  ).run(eventId, phase, prose, error);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual','earnings','2026-09-10','XMPL earnings','XMPL','k1')`,
      )
      .run().lastInsertRowid,
  );
});

describe("earnings-email readers know the two new states", () => {
  it("getEmailAudit hides a 'sending' row and returns a 'delivery_unknown' one (it carries prose)", () => {
    seedEmail("preview", "sending");
    expect(getEmailAudit(db, eventId, "preview")).toBeNull();
    db.prepare(`UPDATE earnings_emails SET error = 'delivery_unknown' WHERE event_id = ?`).run(
      eventId,
    );
    expect(getEmailAudit(db, eventId, "preview")).toMatchObject({
      error: "delivery_unknown",
      ai_output_md: "# body",
    });
  });

  it("getSentPhasesForEvents excludes 'sending' and counts 'delivery_unknown'", () => {
    seedEmail("preview", "sending");
    seedEmail("recap", "delivery_unknown");
    expect(getSentPhasesForEvents(db, [eventId])).toEqual({
      [eventId]: { preview: false, recap: true },
    });
  });

  it("getSentEarningsEmails lists a delivery_unknown send and hides a sending one", () => {
    seedEmail("preview", "sending");
    seedEmail("recap", "delivery_unknown");
    const rows = getSentEarningsEmails(db, { symbol: "XMPL" });
    expect(rows.map((r) => r.phase)).toEqual(["recap"]);
    expect(rows[0].sent_by_cloud).toBe(0);
  });

  it("getEmailStatesForEvents maps sending → in-flight and delivery_unknown → delivery-unknown", () => {
    seedEmail("preview", "sending");
    seedEmail("recap", "delivery_unknown");
    expect(getEmailStatesForEvents(db, [eventId])).toEqual({
      [eventId]: { preview: "in-flight", recap: "delivery-unknown" },
    });
  });

  it("getEmailStatesForEvents still reads legacy failure text as 'sent' and 'in_progress' as in-flight", () => {
    seedEmail("preview", "in_progress");
    seedEmail("recap", "Send failed: provider 500");
    expect(getEmailStatesForEvents(db, [eventId])).toEqual({
      [eventId]: { preview: "in-flight", recap: "sent" },
    });
  });

  it("getSentEarningsEmails flags the unknown row and leaves an ordinary send alone", () => {
    seedEmail("preview", null);
    seedEmail("recap", "delivery_unknown");
    const rows = getSentEarningsEmails(db, { symbol: "XMPL" });
    const byPhase = Object.fromEntries(rows.map((r) => [r.phase, r]));
    expect(byPhase.preview).toMatchObject({ sent_by_cloud: 0, delivery_unknown: 0 });
    expect(byPhase.recap).toMatchObject({ sent_by_cloud: 0, delivery_unknown: 1 });
  });

  it("getSentEarningsEmails still flags a sent-by-cloud row and never calls it unknown", () => {
    seedEmail("recap", "sent-by-cloud", "");
    const rows = getSentEarningsEmails(db, { symbol: "XMPL" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sent_by_cloud: 1, delivery_unknown: 0 });
  });
});

describe("markEmailDeliveredByHand", () => {
  it("closes an unknown row without touching sent_at, and 0-rows otherwise", () => {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error, provider_message_id, provider_response)
       VALUES (?, 'recap', 'me@example.com', '2026-09-10 20:05:00', '# body', 'delivery_unknown', '<m9@d>', '')`,
    ).run(eventId);
    const at = () => new Date("2026-09-11T13:00:00.000Z");
    expect(markEmailDeliveredByHand(db, eventId, "recap", at)).toBe(true);
    expect(
      db
        .prepare(
          `SELECT error, sent_at, provider_message_id, provider_response, ai_output_md
             FROM earnings_emails WHERE event_id = ?`,
        )
        .get(eventId),
    ).toEqual({
      error: null,
      sent_at: "2026-09-10 20:05:00",
      provider_message_id: "<m9@d>",
      provider_response: "confirmed by hand 2026-09-11T13:00:00.000Z",
      ai_output_md: "# body",
    });
    // Idempotence is NOT silent: a second call finds no delivery_unknown row.
    expect(markEmailDeliveredByHand(db, eventId, "recap", at)).toBe(false);
  });

  it("appends to an existing provider_response rather than replacing it", () => {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, provider_response)
       VALUES (?, 'preview', 'me@example.com', datetime('now'), 'delivery_unknown', '250 2.0.0 OK')`,
    ).run(eventId);
    markEmailDeliveredByHand(db, eventId, "preview", () => new Date("2026-09-11T13:00:00.000Z"));
    expect(
      (
        db
          .prepare(`SELECT provider_response p FROM earnings_emails WHERE event_id = ?`)
          .get(eventId) as { p: string }
      ).p,
    ).toBe("250 2.0.0 OK; confirmed by hand 2026-09-11T13:00:00.000Z");
  });

  it("refuses a row that is not delivery_unknown — a live claim is never closed by hand", () => {
    seedEmail("recap", "sending");
    expect(markEmailDeliveredByHand(db, eventId, "recap", () => new Date())).toBe(false);
    expect(
      (
        db.prepare(`SELECT error e FROM earnings_emails WHERE event_id = ?`).get(eventId) as {
          e: string;
        }
      ).e,
    ).toBe("sending");
  });
});
