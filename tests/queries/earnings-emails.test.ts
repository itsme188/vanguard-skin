/**
 * Coverage for lib/queries/earnings-emails.ts — specifically the tri-state
 * filter on getEmailAudit (final-review fix pass, earnings-season-fixes
 * branch). A live 'in_progress' claim row must read as "no row" so the
 * in-app email viewer 404s instead of serving an unsent/in-flight claim.
 * 'sent-by-cloud' rows DO come back (caller branches on `error` to explain
 * the missing ai_output_md).
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getEmailAudit,
  getSentPhasesForEvents,
  getSentEarningsEmails,
} from "@/lib/queries/earnings-emails";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedEvent(): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
       (source, event_type, event_date, event_time, title, symbol, source_key, week_of)
       VALUES ('finnhub', 'earnings', '2026-04-28', 'BMO', 'GLW earnings', 'GLW', 'finnhub:GLW:2026-04-28', '2026-04-27')`,
    )
    .run().lastInsertRowid as number;
}

describe("getEmailAudit", () => {
  it("returns null for a live 'in_progress' claim row (same as no row)", () => {
    const eventId = seedEvent();
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error)
       VALUES (?, 'preview', 'user@example.com', datetime('now'), NULL, NULL, 'in_progress')`,
    ).run(eventId);

    expect(getEmailAudit(db, eventId, "preview")).toBeNull();
  });

  it("returns a completed local send (error IS NULL)", () => {
    const eventId = seedEvent();
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, 'preview', 'user@example.com', '# preview prose', NULL)`,
    ).run(eventId);

    const audit = getEmailAudit(db, eventId, "preview");
    expect(audit).not.toBeNull();
    expect(audit?.error).toBeNull();
    expect(audit?.ai_output_md).toBe("# preview prose");
  });

  it("returns a 'sent-by-cloud' row (ai_output_md null — caller must explain, not hide)", () => {
    const eventId = seedEvent();
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, 'preview', 'cloud-fallback', NULL, 'sent-by-cloud')`,
    ).run(eventId);

    const audit = getEmailAudit(db, eventId, "preview");
    expect(audit).not.toBeNull();
    expect(audit?.error).toBe("sent-by-cloud");
    expect(audit?.ai_output_md).toBeNull();
  });

  it("returns null when no row exists at all", () => {
    const eventId = seedEvent();
    expect(getEmailAudit(db, eventId, "recap")).toBeNull();
  });
});

describe("getSentPhasesForEvents", () => {
  it("empty input returns empty object without querying", () => {
    expect(getSentPhasesForEvents(db, [])).toEqual({});
  });

  it("a claim on one phase doesn't block the other phase's real send from showing", () => {
    const eventId = seedEvent();
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error)
       VALUES (?, 'preview', 'user@example.com', datetime('now'), NULL, NULL, 'in_progress')`,
    ).run(eventId);
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
       VALUES (?, 'recap', 'user@example.com', '# recap prose', NULL)`,
    ).run(eventId);

    const result = getSentPhasesForEvents(db, [eventId]);
    expect(result[eventId]).toEqual({ preview: false, recap: true });
  });
});

describe("getSentEarningsEmails", () => {
  function seedEventFor(symbol: string, date: string): number {
    return db
      .prepare(
        `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, title, symbol, source_key, week_of)
         VALUES ('finnhub', 'earnings', ?, 'AMC', ?, ?, ?, ?)`,
      )
      .run(date, `${symbol} earnings`, symbol, `finnhub:${symbol}:${date}`, date)
      .lastInsertRowid as number;
  }
  function seedEmail(
    eventId: number,
    phase: string,
    sentAt: string,
    error: string | null = null,
  ): void {
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
       VALUES (?, ?, 'user@example.com', ?, CASE WHEN ? IS NULL THEN '# prose' ELSE NULL END, ?)`,
    ).run(eventId, phase, sentAt, error, error);
  }

  it("returns sent emails newest-first with symbol, event date, and cloud flag", () => {
    const glw = seedEventFor("GLW", "2026-07-14");
    const spy = seedEventFor("SPY", "2026-07-21");
    seedEmail(glw, "preview", "2026-07-14 12:00:00");
    seedEmail(glw, "recap", "2026-07-14 20:00:00", "sent-by-cloud");
    seedEmail(spy, "preview", "2026-07-21 12:00:00");

    const rows = getSentEarningsEmails(db);
    expect(rows.map((r) => [r.symbol, r.phase, r.sent_by_cloud])).toEqual([
      ["SPY", "preview", 0],
      ["GLW", "recap", 1],
      ["GLW", "preview", 0],
    ]);
    expect(rows[0].event_date).toBe("2026-07-21");
    expect(rows[0].event_id).toBe(spy);
  });

  it("excludes live 'in_progress' claim rows (tri-state convention)", () => {
    const glw = seedEventFor("GLW", "2026-07-14");
    seedEmail(glw, "preview", "2026-07-14 12:00:00", "in_progress");
    expect(getSentEarningsEmails(db)).toEqual([]);
  });

  it("symbol filter is family-aware (GOOGL query finds GOOG events)", () => {
    const goog = seedEventFor("GOOG", "2026-07-22");
    const spy = seedEventFor("SPY", "2026-07-21");
    seedEmail(goog, "recap", "2026-07-23 09:00:00");
    seedEmail(spy, "preview", "2026-07-21 12:00:00");

    const rows = getSentEarningsEmails(db, { symbol: "GOOGL" });
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("GOOG");
  });

  it("respects limit", () => {
    const glw = seedEventFor("GLW", "2026-07-14");
    seedEmail(glw, "preview", "2026-07-14 12:00:00");
    seedEmail(glw, "recap", "2026-07-14 20:00:00");
    expect(getSentEarningsEmails(db, { limit: 1 })).toHaveLength(1);
  });
});
