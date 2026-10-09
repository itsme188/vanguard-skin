/**
 * A print's email is handled once per issuer family and date, not once per
 * calendar row.
 *
 * findEmailCandidates filters each row on its OWN earnings_emails /
 * earnings_email_skips rows. Two rows can describe one print at two different
 * times: a Nasdaq row with a before-open slot and its Finnhub twin on the
 * hour-unknown 16:15 default. They are both showing before the first
 * reconcile pass, and again during every weekly sync (the hidden un-enriched
 * Finnhub row is deleted and re-minted showing until the pass at the end of
 * that sync). The in-window dedup cannot help: the two rows are never in the
 * send window at the same moment. Observed: a preview at 06:00 ET on the
 * Nasdaq row, then a SECOND preview at 14:15 ET on the Finnhub row.
 *
 * The rule is protective only: it removes candidates, never adds one.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";
import { IN_PROGRESS, SENDING } from "@/lib/earnings/email-states";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
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

function seedEvent(opts: {
  symbol: string;
  securityId: number | null;
  eventDate: string;
  releaseTime: string;
  source: "finnhub" | "nasdaq";
  superseded?: boolean;
}): number {
  const r = db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, release_time, title,
         symbol, security_id, source_key, week_of, superseded
       ) VALUES (?,'earnings',?,?,?,?,?,?,?,?)`,
    )
    .run(
      opts.source,
      opts.eventDate,
      opts.releaseTime,
      `${opts.symbol} earnings`,
      opts.symbol,
      opts.securityId,
      `${opts.source}:${opts.symbol}:${opts.eventDate}`,
      opts.eventDate,
      opts.superseded ? 1 : 0,
    );
  return Number(r.lastInsertRowid);
}

function emailRow(eventId: number, phase: "preview" | "recap", error: string | null = null): number {
  const r = db
    .prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error)
       VALUES (?, ?, 'desk@example.com', datetime('now'), ?)`,
    )
    .run(eventId, phase, error);
  return Number(r.lastInsertRowid);
}

function skipRow(eventId: number, phase: "preview" | "recap"): void {
  db.prepare(`INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, ?)`).run(eventId, phase);
}

// 2026-06-01 is a Monday in daylight time (ET = UTC-4).
const DATE = "2026-06-01";
/** 14:15 ET: two hours before the Finnhub row's 16:15 default. */
const AFTERNOON = new Date("2026-06-01T18:15:00Z");
/** 06:00 ET: two hours before the Nasdaq row's 08:00 before-open time. */
const MORNING = new Date("2026-06-01T10:00:00Z");

const previews = (now: Date) => findEmailCandidates(db, { now }).filter((c) => c.phase === "preview");
const recaps = (now: Date = new Date()) =>
  findEmailCandidates(db, { now }).filter((c) => c.phase === "recap");

describe("findEmailCandidates — a preview handled on a sibling row", () => {
  function twoRows(symbolA = "ZZA", symbolB = "ZZA", held = "ZZA") {
    const securityId = seedHeldSecurity(held);
    const nasdaqId = seedEvent({
      symbol: symbolA, securityId: symbolA === held ? securityId : null,
      eventDate: DATE, releaseTime: "08:00", source: "nasdaq",
    });
    const finnhubId = seedEvent({
      symbol: symbolB, securityId: symbolB === held ? securityId : null,
      eventDate: DATE, releaseTime: "16:15", source: "finnhub",
    });
    return { nasdaqId, finnhubId };
  }

  it("baseline: with nothing sent, each row is a candidate in its own window", () => {
    const { nasdaqId, finnhubId } = twoRows();
    expect(previews(MORNING).map((c) => c.eventId)).toEqual([nasdaqId]);
    expect(previews(AFTERNOON).map((c) => c.eventId)).toEqual([finnhubId]);
  });

  it("the reviewer's case: the Nasdaq row has its preview, the Finnhub row is live and in window -> no candidate", () => {
    const { nasdaqId } = twoRows();
    emailRow(nasdaqId, "preview");
    expect(previews(AFTERNOON)).toEqual([]);
  });

  it("the same with the sibling's preview only a live claim (a send in progress)", () => {
    const { nasdaqId } = twoRows();
    emailRow(nasdaqId, "preview", IN_PROGRESS);
    expect(previews(AFTERNOON)).toEqual([]);
  });

  it("the same with the provider call in flight", () => {
    const { nasdaqId } = twoRows();
    emailRow(nasdaqId, "preview", SENDING);
    expect(previews(AFTERNOON)).toEqual([]);
  });

  it("a released claim (the row is gone) does not block: the sibling is a candidate again", () => {
    const { nasdaqId, finnhubId } = twoRows();
    const claimId = emailRow(nasdaqId, "preview", IN_PROGRESS);
    expect(previews(AFTERNOON)).toEqual([]);
    db.prepare("DELETE FROM earnings_emails WHERE id = ?").run(claimId);
    expect(previews(AFTERNOON).map((c) => c.eventId)).toEqual([finnhubId]);
  });

  it("a recorded preview skip on the sibling blocks too (same rule the row applies to itself)", () => {
    const { nasdaqId } = twoRows();
    skipRow(nasdaqId, "preview");
    expect(previews(AFTERNOON)).toEqual([]);
  });

  it("a HIDDEN sibling that carries the preview still blocks", () => {
    const securityId = seedHeldSecurity("ZZA");
    const nasdaqId = seedEvent({
      symbol: "ZZA", securityId, eventDate: DATE, releaseTime: "08:00", source: "nasdaq", superseded: true,
    });
    seedEvent({ symbol: "ZZA", securityId, eventDate: DATE, releaseTime: "16:15", source: "finnhub" });
    emailRow(nasdaqId, "preview");
    expect(previews(AFTERNOON)).toEqual([]);
  });

  it("a share-class sibling (GOOG preview sent, GOOGL row in window) -> no candidate", () => {
    const { nasdaqId } = twoRows("GOOG", "GOOGL", "GOOG");
    emailRow(nasdaqId, "preview");
    expect(previews(AFTERNOON)).toEqual([]);
  });

  it("symbol case does not matter when matching the sibling", () => {
    const securityId = seedHeldSecurity("ZZA");
    const nasdaqId = seedEvent({
      symbol: "zza", securityId, eventDate: DATE, releaseTime: "08:00", source: "nasdaq",
    });
    seedEvent({ symbol: "ZZA", securityId, eventDate: DATE, releaseTime: "16:15", source: "finnhub" });
    emailRow(nasdaqId, "preview");
    expect(previews(AFTERNOON)).toEqual([]);
  });

  it("a different DATE for the same symbol still gets its own preview", () => {
    const securityId = seedHeldSecurity("ZZA");
    const otherDay = seedEvent({
      symbol: "ZZA", securityId, eventDate: "2026-05-29", releaseTime: "08:00", source: "nasdaq",
    });
    const finnhubId = seedEvent({
      symbol: "ZZA", securityId, eventDate: DATE, releaseTime: "16:15", source: "finnhub",
    });
    emailRow(otherDay, "preview");
    expect(previews(AFTERNOON).map((c) => c.eventId)).toEqual([finnhubId]);
  });

  it("another company's preview on the same date does not block", () => {
    const zza = seedHeldSecurity("ZZA");
    const zzb = seedHeldSecurity("ZZB");
    const other = seedEvent({ symbol: "ZZB", securityId: zzb, eventDate: DATE, releaseTime: "08:00", source: "nasdaq" });
    const finnhubId = seedEvent({ symbol: "ZZA", securityId: zza, eventDate: DATE, releaseTime: "16:15", source: "finnhub" });
    emailRow(other, "preview");
    expect(previews(AFTERNOON).map((c) => c.eventId)).toEqual([finnhubId]);
  });

  it("a sibling's RECAP row does not block a preview (phases are separate)", () => {
    const { nasdaqId, finnhubId } = twoRows();
    emailRow(nasdaqId, "recap");
    expect(previews(AFTERNOON).map((c) => c.eventId)).toEqual([finnhubId]);
  });
});

describe("findEmailCandidates — a recap handled on a sibling row", () => {
  function twoEnrichedRows(symbolA = "ZZA", symbolB = "ZZA", held = "ZZA", dateB = "2026-05-29") {
    const securityId = seedHeldSecurity(held);
    const nasdaqId = seedEvent({
      symbol: symbolA, securityId: symbolA === held ? securityId : null,
      eventDate: "2026-05-29", releaseTime: "08:00", source: "nasdaq",
    });
    const finnhubId = seedEvent({
      symbol: symbolB, securityId: symbolB === held ? securityId : null,
      eventDate: dateB, releaseTime: "16:15", source: "finnhub",
    });
    // Only the Finnhub row is enriched now (the Nasdaq row was recapped earlier).
    db.prepare(
      "UPDATE calendar_events SET actual_value = 'EPS 1.00', enriched_at = datetime('now', '-30 minutes') WHERE id = ?",
    ).run(finnhubId);
    return { nasdaqId, finnhubId };
  }

  it("baseline: with nothing sent the enriched row is a recap candidate", () => {
    const { finnhubId } = twoEnrichedRows();
    expect(recaps().map((c) => c.eventId)).toEqual([finnhubId]);
  });

  it("the sibling row already has its recap -> no candidate", () => {
    const { nasdaqId } = twoEnrichedRows();
    emailRow(nasdaqId, "recap");
    expect(recaps()).toEqual([]);
  });

  it("the sibling's recap is only a live claim -> no candidate", () => {
    const { nasdaqId } = twoEnrichedRows();
    emailRow(nasdaqId, "recap", IN_PROGRESS);
    expect(recaps()).toEqual([]);
  });

  it("a recorded recap skip on the sibling -> no candidate", () => {
    const { nasdaqId } = twoEnrichedRows();
    skipRow(nasdaqId, "recap");
    expect(recaps()).toEqual([]);
  });

  it("a share-class sibling's recap blocks too", () => {
    const { nasdaqId } = twoEnrichedRows("GOOG", "GOOGL", "GOOG");
    emailRow(nasdaqId, "recap");
    expect(recaps()).toEqual([]);
  });

  it("a sibling's PREVIEW row does not block the recap", () => {
    const { nasdaqId, finnhubId } = twoEnrichedRows();
    emailRow(nasdaqId, "preview");
    expect(recaps().map((c) => c.eventId)).toEqual([finnhubId]);
  });

  it("a recap on a different DATE for the same symbol does not block", () => {
    const { nasdaqId, finnhubId } = twoEnrichedRows("ZZA", "ZZA", "ZZA", "2026-05-28");
    emailRow(nasdaqId, "recap");
    expect(recaps().map((c) => c.eventId)).toEqual([finnhubId]);
  });
});
