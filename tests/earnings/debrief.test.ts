/**
 * Morning-debrief candidate selection (Task 1 of the 2026-08-02
 * morning-debrief plan). Pure candidate-finding only — no prompt building,
 * no sending. Later tasks (2 = sections/prompt, 3 = sender) import
 * `DebriefCandidate` / `DebriefRosterEntry` / `DebriefCandidates` and
 * `findDebriefCandidates` from lib/earnings/debrief.ts.
 *
 * Spec: this replaces the same-evening earnings "wrap" email with a
 * 7:45 ET morning debrief — sibling logic to getExpectedRecapCluster in
 * lib/earnings/wrap.ts, but windowed on [yesterday, today] instead of a
 * same-day (date, slot) cluster, and honest about live in_progress claims
 * (they exclude a candidate from `unsent` rather than counting it as a
 * cluster member).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findDebriefCandidates } from "@/lib/earnings/debrief";
import {
  setMutedEarningsSymbols,
  setEarningsEmailsEnabled,
} from "@/lib/queries/earnings-settings";

// "Today" for every test — ET. Chosen so composeReleaseInstant's DST branch
// resolves to EDT (August). NOW is 2026-08-02T11:45 UTC = 07:45 ET.
const TODAY = "2026-08-02";
const YESTERDAY = "2026-08-01";
const NOW = new Date("2026-08-02T11:45:00Z");

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedHeld(symbol: string): number {
  const sec = Number(
    db
      .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`)
      .run(symbol, symbol).lastInsertRowid,
  );
  const acct = Number(
    db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(`a-${symbol}`).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 100, '2026-08-01', ?)`,
  ).run(acct, sec, `t:${symbol}`);
  return sec;
}

let eventCounter = 0;
function seedEvent(opts: {
  symbol: string;
  date?: string;
  releaseTime?: string | null;
  eventTime?: string | null;
  actual?: string | null;
  superseded?: number;
}): number {
  eventCounter += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
          (source, event_type, event_date, event_time, release_time, title, symbol,
           actual_value, source_key, week_of, superseded)
         VALUES ('finnhub', 'earnings', ?, ?, ?, ?, ?, ?, ?, '2026-07-27', ?)`,
      )
      .run(
        opts.date ?? TODAY,
        opts.eventTime ?? null,
        opts.releaseTime === undefined ? null : opts.releaseTime,
        `${opts.symbol} earnings`,
        opts.symbol,
        opts.actual === undefined ? "EPS 1.00 · Rev 500M" : opts.actual,
        `finnhub:${opts.symbol}:${opts.date ?? TODAY}:${eventCounter}`,
        opts.superseded ?? 0,
      ).lastInsertRowid,
  );
}

function seedRecapEmail(eventId: number, error: string | null, sentAt: string): void {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error)
     VALUES (?, 'recap', 'x', ?, ?)`,
  ).run(eventId, sentAt, error);
}

function seedRecapSkip(eventId: number): void {
  db.prepare(`INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, 'recap')`).run(
    eventId,
  );
}

describe("findDebriefCandidates", () => {
  it("selects held earnings from yesterday+today with actuals and no recap audit row", () => {
    seedHeld("AAA");
    const todayId = seedEvent({ symbol: "AAA", date: TODAY });
    seedHeld("BBB");
    const yesterdayId = seedEvent({ symbol: "BBB", date: YESTERDAY });

    const result = findDebriefCandidates(db, { now: NOW });
    const ids = result.unsent.map((c) => c.eventId).sort((a, b) => a - b);
    expect(ids).toEqual([todayId, yesterdayId].sort((a, b) => a - b));
    const aaa = result.unsent.find((c) => c.symbol === "AAA")!;
    expect(aaa).toMatchObject({
      eventId: todayId,
      symbol: "AAA",
      event_date: TODAY,
    });
  });

  it("excludes: no actuals; recap already sent (error NULL); sent-by-cloud; recap skip row; muted symbol; not held/watchlist; superseded", () => {
    seedHeld("NOACT");
    seedEvent({ symbol: "NOACT", actual: null });

    seedHeld("SENTLOCAL");
    const sentLocalId = seedEvent({ symbol: "SENTLOCAL" });
    seedRecapEmail(sentLocalId, null, "2026-08-02 07:00:00");

    seedHeld("SENTCLOUD");
    const sentCloudId = seedEvent({ symbol: "SENTCLOUD" });
    seedRecapEmail(sentCloudId, "sent-by-cloud", "2026-08-02 07:10:00");

    seedHeld("SKIPPED");
    const skippedId = seedEvent({ symbol: "SKIPPED" });
    seedRecapSkip(skippedId);

    seedHeld("MUTED");
    seedEvent({ symbol: "MUTED" });
    setMutedEarningsSymbols(db, ["MUTED"]);

    // Not held, not watchlisted.
    seedEvent({ symbol: "NOPOS" });

    seedHeld("GONE");
    seedEvent({ symbol: "GONE", superseded: 1 });

    const result = findDebriefCandidates(db, { now: NOW });
    expect(result.unsent).toEqual([]);
  });

  it("excludes every candidate when the master toggle is off", () => {
    seedHeld("WOULDPASS");
    seedEvent({ symbol: "WOULDPASS" });
    setEarningsEmailsEnabled(db, false);

    const result = findDebriefCandidates(db, { now: NOW });
    expect(result.unsent).toEqual([]);
  });

  it("a live in_progress recap claim excludes the event (another process is sending it)", () => {
    seedHeld("CLAIM");
    const claimId = seedEvent({ symbol: "CLAIM" });
    seedRecapEmail(claimId, "in_progress", "2026-08-02 07:00:00");

    const result = findDebriefCandidates(db, { now: NOW });
    expect(result.unsent).toEqual([]);
    // Not a completed send either — must not appear on the roster.
    expect(result.alreadyRecapped.find((r) => r.symbol === "CLAIM")).toBeUndefined();
  });

  it("released under 60 minutes ago is excluded (release_time known); a stale release or unknown release_time is included", () => {
    // NOW = 07:45 ET. Released 07:00 ET → 45 min ago → excluded.
    seedHeld("RECENT");
    seedEvent({ symbol: "RECENT", releaseTime: "07:00" });

    // Released 06:00 ET → 105 min ago → included.
    seedHeld("OLD");
    const oldId = seedEvent({ symbol: "OLD", releaseTime: "06:00" });

    // No release_time on record → included (never held back for lack of data).
    seedHeld("UNKNOWN");
    const unknownId = seedEvent({ symbol: "UNKNOWN", releaseTime: null });

    const result = findDebriefCandidates(db, { now: NOW });
    const ids = result.unsent.map((c) => c.eventId).sort((a, b) => a - b);
    expect(ids).toEqual([oldId, unknownId].sort((a, b) => a - b));
  });

  it("family dedupe: GOOG + GOOGL rows on the same date yield one candidate (lowest eventId wins)", () => {
    seedHeld("GOOG");
    const googId = seedEvent({ symbol: "GOOG" });
    const googlId = seedEvent({ symbol: "GOOGL" });
    expect(googId).toBeLessThan(googlId);

    const result = findDebriefCandidates(db, { now: NOW });
    expect(result.unsent).toHaveLength(1);
    expect(result.unsent[0].eventId).toBe(googId);
  });

  it("alreadyRecapped lists yesterday+today's completed recaps (NULL error and sent-by-cloud both count, in_progress does not)", () => {
    seedHeld("DONE1");
    const done1Id = seedEvent({ symbol: "DONE1", date: YESTERDAY });
    seedRecapEmail(done1Id, null, "2026-08-01 20:05:00");

    seedHeld("DONE2");
    const done2Id = seedEvent({ symbol: "DONE2", date: TODAY });
    seedRecapEmail(done2Id, "sent-by-cloud", "2026-08-02 06:00:00");

    seedHeld("PENDING");
    const pendingId = seedEvent({ symbol: "PENDING", date: TODAY });
    seedRecapEmail(pendingId, "in_progress", "2026-08-02 07:30:00");

    // Outside the [yesterday, today] window — must not appear.
    seedHeld("OLDNEWS");
    const oldNewsId = seedEvent({ symbol: "OLDNEWS", date: "2026-07-30" });
    seedRecapEmail(oldNewsId, null, "2026-07-30 20:00:00");

    const result = findDebriefCandidates(db, { now: NOW });
    expect(result.alreadyRecapped.map((r) => r.symbol)).toEqual(["DONE1", "DONE2"]);
    expect(result.alreadyRecapped[0]).toMatchObject({
      symbol: "DONE1",
      sentAt: "2026-08-01 20:05:00",
    });
  });
});
