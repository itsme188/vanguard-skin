/**
 * The email archive marks an email whose calendar entry is NOW superseded,
 * and points at the email of the live entry for the same company and print
 * (owner ruling 2026-10-06,
 * qa:earnings-email-viewer--second-recap-sent-on-superseded-twin-listed-as-valid-opposite-reaction).
 *
 * Nothing is deleted or repointed: the archive stays an honest history. The
 * live entry is found with the reconciler's own cluster rule (same issuer
 * family, rows chained while consecutive dates are 14 days apart or closer),
 * then passed through the "two hand-entered rows, one email" rule.
 *
 * Synthetic book: ZZ* tickers, fixed dates, no clock read.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getSentEarningsEmails,
  SUPERSEDED_TWIN_CLUSTER_DAYS,
} from "@/lib/queries/earnings-emails";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { anchorIndex } from "@/tests/helpers/source-anchor";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedEvent(o: {
  source: string;
  symbol: string;
  eventDate: string;
  superseded?: number;
  eventType?: string;
}): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, title, symbol, source_key, week_of, superseded)
       VALUES (?, ?, ?, 'AMC', ?, ?, ?, ?, ?)`,
    )
    .run(
      o.source,
      o.eventType ?? "earnings",
      o.eventDate,
      `${o.symbol} earnings`,
      o.symbol,
      `${o.source}:${o.symbol}:${o.eventDate}:${o.eventType ?? "earnings"}`,
      o.eventDate,
      o.superseded ?? 0,
    ).lastInsertRowid as number;
}

function seedEmail(
  eventId: number,
  phase: "preview" | "recap",
  sentAt: string,
  error: string | null = null,
): void {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
     VALUES (?, ?, 'desk@example.com', ?, '# prose', ?)`,
  ).run(eventId, phase, sentAt, error);
}

function rowFor(eventId: number, phase: "preview" | "recap") {
  const row = getSentEarningsEmails(db).find((r) => r.event_id === eventId && r.phase === phase);
  if (!row) throw new Error(`no archive row for event ${eventId} ${phase}`);
  return row;
}

describe("getSentEarningsEmails — an email sent for an entry that was later replaced", () => {
  it("leaves an ordinary email unmarked", () => {
    const live = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10" });
    seedEmail(live, "recap", "2026-06-10 21:00:00");
    expect(rowFor(live, "recap")).toMatchObject({ event_superseded: 0, replacement: null });
  });

  it("marks the email of a superseded entry and points at the live entry's email of the same kind", () => {
    const live = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-10" });
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    seedEmail(live, "recap", "2026-06-10 13:00:00");
    seedEmail(old, "recap", "2026-06-12 12:00:00");

    expect(rowFor(old, "recap")).toMatchObject({
      event_superseded: 1,
      replacement: {
        event_id: live,
        event_date: "2026-06-10",
        email_sent_at: "2026-06-10 13:00:00",
      },
    });
    // The live entry's own email is an ordinary row.
    expect(rowFor(live, "recap")).toMatchObject({ event_superseded: 0, replacement: null });
    // Nothing was deleted or repointed.
    expect(
      db.prepare(`SELECT event_id FROM earnings_emails ORDER BY id`).all(),
    ).toEqual([{ event_id: live }, { event_id: old }]);
  });

  it("marks the row the real reconciler supersedes (vendor row behind a hand-entered row)", () => {
    const manual = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-10" });
    const vendor = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-12" });
    // Both entries already carry their own recap, so the reconciler's
    // repoint keeps each one where it is (UNIQUE collision).
    seedEmail(manual, "recap", "2026-06-10 13:00:00");
    seedEmail(vendor, "recap", "2026-06-12 12:00:00");
    reconcileEarningsDates(db, { today: "2026-06-13" });
    expect(
      db.prepare(`SELECT superseded FROM calendar_events WHERE id = ?`).get(vendor),
    ).toEqual({ superseded: 1 });

    expect(rowFor(vendor, "recap")).toMatchObject({
      event_superseded: 1,
      replacement: { event_id: manual, event_date: "2026-06-10", email_sent_at: "2026-06-10 13:00:00" },
    });
  });

  it("names the live entry but no email when the live entry has no email at all", () => {
    const live = seedEvent({ source: "nasdaq", symbol: "ZZA", eventDate: "2026-06-11" });
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    seedEmail(old, "recap", "2026-06-10 21:00:00");
    expect(rowFor(old, "recap")).toMatchObject({
      event_superseded: 1,
      replacement: { event_id: live, event_date: "2026-06-11", email_sent_at: null },
    });
  });

  it("links only an email of the SAME kind when the live entry has several", () => {
    const live = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-10" });
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    seedEmail(live, "preview", "2026-06-10 11:00:00");
    seedEmail(live, "recap", "2026-06-10 13:00:00");
    seedEmail(old, "preview", "2026-06-10 11:30:00");
    seedEmail(old, "recap", "2026-06-12 12:00:00");

    expect(rowFor(old, "preview").replacement).toEqual({
      event_id: live,
      event_date: "2026-06-10",
      email_sent_at: "2026-06-10 11:00:00",
    });
    expect(rowFor(old, "recap").replacement).toEqual({
      event_id: live,
      event_date: "2026-06-10",
      email_sent_at: "2026-06-10 13:00:00",
    });
  });

  it("never offers the other kind: a replaced recap beside a live entry that only has a preview", () => {
    const live = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-10" });
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    seedEmail(live, "preview", "2026-06-10 11:00:00");
    seedEmail(old, "recap", "2026-06-12 12:00:00");
    expect(rowFor(old, "recap").replacement).toEqual({
      event_id: live,
      event_date: "2026-06-10",
      email_sent_at: null,
    });
  });

  it("does not count a send still in flight on the live entry as its email", () => {
    const live = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-10" });
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    seedEmail(live, "recap", "2026-06-10 13:00:00", "sending");
    seedEmail(old, "recap", "2026-06-12 12:00:00");
    expect(rowFor(old, "recap").replacement).toMatchObject({ event_id: live, email_sent_at: null });
  });

  it("marks the email with no live entry named when every entry of the print is superseded", () => {
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    seedEvent({ source: "nasdaq", symbol: "ZZA", eventDate: "2026-06-11", superseded: 1 });
    seedEmail(old, "recap", "2026-06-10 21:00:00");
    expect(rowFor(old, "recap")).toMatchObject({ event_superseded: 1, replacement: null });
  });

  it("does not reach into another quarter: a live entry more than the cluster span away is not the same print", () => {
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    const nextQuarter = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-25" });
    seedEmail(old, "recap", "2026-06-10 21:00:00");
    seedEmail(nextQuarter, "recap", "2026-06-25 21:00:00");
    expect(rowFor(old, "recap")).toMatchObject({ event_superseded: 1, replacement: null });
  });

  it("follows the reconciler's chain: entries each 14 days or closer to the next are one print", () => {
    // 06-01 (replaced) -> 06-14 (replaced) -> 06-27 (live): every hop is 13
    // days, the ends are 26 apart. The reconciler clusters these as one print.
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-01", superseded: 1 });
    seedEvent({ source: "nasdaq", symbol: "ZZA", eventDate: "2026-06-14", superseded: 1 });
    const live = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-27" });
    seedEmail(old, "recap", "2026-06-01 21:00:00");
    expect(rowFor(old, "recap").replacement).toMatchObject({ event_id: live, event_date: "2026-06-27" });
  });

  it("picks the nearest live entry, the earlier one on a tie", () => {
    const earlier = seedEvent({ source: "manual", symbol: "ZZB", eventDate: "2026-06-08" });
    const old = seedEvent({ source: "finnhub", symbol: "ZZB", eventDate: "2026-06-10", superseded: 1 });
    // A vendor row two days after: same distance as `earlier`.
    seedEvent({ source: "nasdaq", symbol: "ZZB", eventDate: "2026-06-12" });
    seedEmail(old, "preview", "2026-06-10 11:00:00");
    expect(rowFor(old, "preview").replacement).toMatchObject({ event_id: earlier });
  });

  it("with two live hand-entered rows, points at the EARLIER one: that is the row email follows", () => {
    const earlier = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-08" });
    const later = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-12" });
    // The replaced vendor row sits on the later hand-entered date.
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-12", superseded: 1 });
    seedEmail(earlier, "recap", "2026-06-08 21:00:00");
    seedEmail(old, "recap", "2026-06-12 21:00:00");
    const r = rowFor(old, "recap").replacement;
    expect(r).toEqual({ event_id: earlier, event_date: "2026-06-08", email_sent_at: "2026-06-08 21:00:00" });
    expect(r?.event_id).not.toBe(later);
  });

  it("matches across share classes of one issuer", () => {
    const live = seedEvent({ source: "manual", symbol: "GOOG", eventDate: "2026-06-10" });
    const old = seedEvent({ source: "finnhub", symbol: "GOOGL", eventDate: "2026-06-10", superseded: 1 });
    seedEmail(live, "recap", "2026-06-10 21:00:00");
    seedEmail(old, "recap", "2026-06-11 21:00:00");
    expect(rowFor(old, "recap").replacement).toMatchObject({ event_id: live });
  });

  it("never matches another company on the same date", () => {
    seedEvent({ source: "manual", symbol: "ZZB", eventDate: "2026-06-10" });
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    seedEmail(old, "recap", "2026-06-10 21:00:00");
    expect(rowFor(old, "recap")).toMatchObject({ event_superseded: 1, replacement: null });
  });

  it("an email for a non-earnings event is listed, and never matched to an earnings entry", () => {
    const earnings = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-10" });
    const live = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-10", eventType: "conference" });
    const flagged = seedEvent({
      source: "finnhub", symbol: "ZZA", eventDate: "2026-06-11", eventType: "conference", superseded: 1,
    });
    seedEmail(earnings, "recap", "2026-06-10 20:00:00");
    seedEmail(live, "recap", "2026-06-10 21:00:00");
    seedEmail(flagged, "recap", "2026-06-11 21:00:00");
    expect(rowFor(live, "recap")).toMatchObject({ event_superseded: 0, replacement: null });
    // The twin rule is an earnings rule; a flagged non-earnings row is marked
    // but nothing is guessed about what replaced it.
    expect(rowFor(flagged, "recap")).toMatchObject({ event_superseded: 1, replacement: null });
  });

  it("a non-earnings row is never offered as the live entry of an earnings print", () => {
    seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-10", eventType: "conference" });
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    seedEmail(old, "recap", "2026-06-10 21:00:00");
    expect(rowFor(old, "recap").replacement).toBeNull();
  });

  it("an email whose event row was deleted is gone with it (cascade), and an orphan never breaks the list", () => {
    const live = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-10" });
    const doomed = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    seedEmail(live, "recap", "2026-06-10 13:00:00");
    seedEmail(doomed, "recap", "2026-06-12 12:00:00");
    db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(doomed);
    expect(getSentEarningsEmails(db).map((r) => r.event_id)).toEqual([live]);

    // A database that lost the cascade (foreign keys off): the orphan audit
    // row has no event to describe, so it is not listed and nothing throws.
    db.pragma("foreign_keys = OFF");
    const ghost = seedEvent({ source: "nasdaq", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    seedEmail(ghost, "preview", "2026-06-10 11:00:00");
    db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(ghost);
    expect(getSentEarningsEmails(db).map((r) => r.event_id)).toEqual([live]);
  });

  it("the live entry's email is found even when the list is cut short or filtered", () => {
    const live = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-10" });
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    seedEmail(live, "recap", "2026-06-10 13:00:00");
    seedEmail(old, "recap", "2026-06-12 12:00:00");
    const top = getSentEarningsEmails(db, { limit: 1 });
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({
      event_id: old,
      replacement: { event_id: live, email_sent_at: "2026-06-10 13:00:00" },
    });
    expect(
      getSentEarningsEmails(db, { symbol: "ZZA" }).find((r) => r.event_id === old)?.replacement,
    ).toMatchObject({ event_id: live });
  });

  it("adds no row and drops none: the list is the same set with or without replaced entries", () => {
    const live = seedEvent({ source: "manual", symbol: "ZZA", eventDate: "2026-06-10" });
    const old = seedEvent({ source: "finnhub", symbol: "ZZA", eventDate: "2026-06-10", superseded: 1 });
    seedEmail(live, "preview", "2026-06-10 11:00:00");
    seedEmail(live, "recap", "2026-06-10 13:00:00");
    seedEmail(old, "recap", "2026-06-12 12:00:00");
    seedEmail(old, "preview", "2026-06-10 11:30:00", "in_progress");
    const expected = db
      .prepare(
        `SELECT COUNT(*) AS n FROM earnings_emails
          WHERE error IS NULL OR error NOT IN ('in_progress', 'sending')`,
      )
      .get() as { n: number };
    expect(getSentEarningsEmails(db)).toHaveLength(expected.n);
    expect(expected.n).toBe(3);
  });
});

describe("the cluster span is the reconciler's", () => {
  it("equals CLUSTER_PROXIMITY_DAYS in lib/calendar/reconcile-earnings-dates.ts", () => {
    const src = readFileSync("lib/calendar/reconcile-earnings-dates.ts", "utf8");
    const at = anchorIndex(src, "const CLUSTER_PROXIMITY_DAYS = ");
    const value = Number(src.slice(at).match(/const CLUSTER_PROXIMITY_DAYS = (\d+);/)?.[1]);
    expect(value).toBe(SUPERSEDED_TWIN_CLUSTER_DAYS);
  });
});
