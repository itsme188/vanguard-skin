/**
 * Owner ruling 2026-10-07
 * [qa:dashboard-today-earningshub-refresh-from-finnhub-refresh-silently-supersedes-a-user-added-earnings-row-the-hub]:
 * when one company has two live hand-entered earnings rows, THE EARLIER DATE
 * COUNTS for email. The later row is ignored by every email finder.
 *
 * The rule is `emailIgnoredManualTwins` (lib/earnings/manual-twin-email.ts,
 * mirrored on the Worker). The finder cases use the fixture the Worker test
 * also runs (tests/fixtures/manual-twin-email-fixture.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import {
  emailIgnoredManualTwins,
  MANUAL_TWIN_EMAIL_WINDOW_DAYS,
} from "@/lib/earnings/manual-twin-email";
import { getEmailIgnoredManualTwins } from "@/lib/queries/manual-twin-email";
import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";
import { findDebriefCandidates } from "@/lib/earnings/debrief";
import { getExpectedRecapCluster } from "@/lib/earnings/wrap";
import { MANUAL_TWIN_FIXTURE as FX } from "@/tests/fixtures/manual-twin-email-fixture";

const manual = (id: number, symbol: string, event_date: string) => ({
  id,
  symbol,
  event_date,
  source: "manual",
  event_type: "earnings",
  superseded: 0,
});

describe("emailIgnoredManualTwins — the shared rule", () => {
  it("names the 14-day window", () => {
    expect(MANUAL_TWIN_EMAIL_WINDOW_DAYS).toBe(14);
  });

  it("ignores the later of two hand-entered rows and points at the earlier one", () => {
    const ignored = emailIgnoredManualTwins(
      [manual(2, "ZZA", "2026-06-11"), manual(1, "ZZA", "2026-06-10")],
      issuerSiblings,
    );
    expect([...ignored.entries()]).toEqual([
      [2, { emailRowId: 1, emailRowDate: "2026-06-10" }],
    ]);
  });

  it("breaks a tie on date by the lower id, across share classes of one issuer", () => {
    const ignored = emailIgnoredManualTwins(
      [manual(9, "GOOG", "2026-06-10"), manual(4, "GOOGL", "2026-06-10")],
      issuerSiblings,
    );
    expect([...ignored.keys()]).toEqual([9]);
    expect(ignored.get(9)).toEqual({ emailRowId: 4, emailRowDate: "2026-06-10" });
  });

  it("leaves rows more than 14 days apart alone, and ignores a row exactly 14 days out", () => {
    expect(
      emailIgnoredManualTwins(
        [manual(1, "ZZA", "2026-06-01"), manual(2, "ZZA", "2026-06-16")],
        issuerSiblings,
      ).size,
    ).toBe(0);
    expect([
      ...emailIgnoredManualTwins(
        [manual(1, "ZZA", "2026-06-01"), manual(2, "ZZA", "2026-06-15")],
        issuerSiblings,
      ).keys(),
    ]).toEqual([2]);
  });

  it("chains three rows to the earliest one", () => {
    const ignored = emailIgnoredManualTwins(
      [manual(1, "ZZA", "2026-06-01"), manual(2, "ZZA", "2026-06-10"), manual(3, "ZZA", "2026-06-20")],
      issuerSiblings,
    );
    expect(ignored.get(2)?.emailRowId).toBe(1);
    expect(ignored.get(3)?.emailRowId).toBe(1);
  });

  it("never involves a vendor row, a hidden row, another company or a non-earnings row", () => {
    const ignored = emailIgnoredManualTwins(
      [
        manual(1, "ZZA", "2026-06-10"),
        { ...manual(2, "ZZA", "2026-06-11"), source: "finnhub" },
        { ...manual(3, "ZZA", "2026-06-12"), superseded: 1 },
        manual(4, "ZZB", "2026-06-11"),
        { ...manual(5, "ZZA", "2026-06-11"), event_type: "conference" },
      ],
      issuerSiblings,
    );
    expect(ignored.size).toBe(0);
  });
});

// ── Finders ──────────────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedHeld(symbol: string): number {
  const accountId = (
    db.prepare("INSERT INTO accounts (name) VALUES (?) RETURNING id").get(`acct-${symbol}`) as {
      id: number;
    }
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
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 100, date('now'))",
  ).run(accountId, securityId);
  return securityId;
}

function seedEvent(o: {
  id?: number;
  source: string;
  symbol: string;
  eventDate: string;
  releaseTime?: string | null;
  actual?: string | null;
  enrichedAt?: string | null;
  superseded?: number;
}): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (id, source, event_type, event_date, event_time, release_time, title, symbol,
          source_key, week_of, actual_value, enriched_at, superseded)
       VALUES (?, ?, 'earnings', ?, 'AMC', ?, ?, ?, ?, '2026-06-08', ?, ?, ?)`,
    )
    .run(
      o.id ?? null,
      o.source,
      o.eventDate,
      o.releaseTime === undefined ? FX.releaseTime : o.releaseTime,
      `${o.symbol} earnings`,
      o.symbol,
      `${o.source}:${o.symbol}:${o.eventDate}:earnings`,
      o.actual ?? null,
      o.enrichedAt ?? null,
      o.superseded ?? 0,
    ).lastInsertRowid as number;
}

/** The shared fixture: one held company, two live hand-entered rows. */
function seedFixture(later: { actual?: string; enrichedAt?: string } = {}) {
  seedHeld(FX.symbol);
  seedEvent({ id: FX.earlier.id, source: "manual", symbol: FX.symbol, eventDate: FX.earlier.eventDate });
  seedEvent({
    id: FX.later.id,
    source: "manual",
    symbol: FX.symbol,
    eventDate: FX.later.eventDate,
    actual: later.actual ?? null,
    enrichedAt: later.enrichedAt ?? null,
  });
}

describe("getEmailIgnoredManualTwins — the one read the Mac finders and the Hub share", () => {
  it("returns the later row with the earlier row's id and date", () => {
    seedFixture();
    expect([...getEmailIgnoredManualTwins(db).entries()]).toEqual([
      [FX.later.id, { emailRowId: FX.earlier.id, emailRowDate: FX.earlier.eventDate }],
    ]);
  });
});

describe("findEmailCandidates — two hand-entered rows for one company", () => {
  it("previews the earlier row on its day", () => {
    seedFixture();
    const previews = findEmailCandidates(db, { now: new Date(FX.twoHoursBeforeEarlierRelease) })
      .filter((c) => c.phase === "preview");
    expect(previews.map((c) => c.eventId)).toEqual([FX.earlier.id]);
  });

  it("sends no preview for the later row on its day — exactly one preview across both days", () => {
    seedFixture();
    const dayOne = findEmailCandidates(db, { now: new Date(FX.twoHoursBeforeEarlierRelease) });
    const dayTwo = findEmailCandidates(db, { now: new Date(FX.twoHoursBeforeLaterRelease) });
    const previews = [...dayOne, ...dayTwo].filter((c) => c.phase === "preview");
    expect(previews.map((c) => c.eventId)).toEqual([FX.earlier.id]);
  });

  it("sends no recap for the later row, even when it carries an actual", () => {
    seedFixture({ actual: FX.laterRowActual, enrichedAt: FX.laterRowEnrichedAt });
    const candidates = findEmailCandidates(db, { now: new Date(FX.afterLaterRowEnriched) });
    expect(candidates.filter((c) => c.eventId === FX.later.id)).toEqual([]);
  });

  it("still ignores the later row after the earlier row's own preview has gone out", () => {
    seedFixture();
    db.prepare(
      "INSERT INTO earnings_emails (event_id, phase, recipient, sent_at) VALUES (?, 'preview', 'desk@example.com', '2026-06-10 18:00:00')",
    ).run(FX.earlier.id);
    const dayTwo = findEmailCandidates(db, { now: new Date(FX.twoHoursBeforeLaterRelease) });
    expect(dayTwo).toEqual([]);
  });

  it("a hand-entered row beside a vendor row is unaffected — the vendor row still previews", () => {
    seedHeld(FX.symbol);
    seedEvent({ source: "manual", symbol: FX.symbol, eventDate: FX.earlier.eventDate });
    const vendor = seedEvent({ source: "finnhub", symbol: FX.symbol, eventDate: FX.later.eventDate });
    const dayTwo = findEmailCandidates(db, { now: new Date(FX.twoHoursBeforeLaterRelease) });
    expect(dayTwo.map((c) => c.eventId)).toEqual([vendor]);
  });

  it("a lone hand-entered row is unaffected", () => {
    seedHeld(FX.symbol);
    const only = seedEvent({ source: "manual", symbol: FX.symbol, eventDate: FX.later.eventDate });
    const dayTwo = findEmailCandidates(db, { now: new Date(FX.twoHoursBeforeLaterRelease) });
    expect(dayTwo.map((c) => c.eventId)).toEqual([only]);
  });
});

describe("findDebriefCandidates — two hand-entered rows for one company", () => {
  it("does not list the later row as an unsent recap", () => {
    seedFixture({ actual: FX.laterRowActual, enrichedAt: FX.laterRowEnrichedAt });
    // The morning after the later row's date.
    const { unsent } = findDebriefCandidates(db, { now: new Date("2026-06-12T11:00:00Z") });
    expect(unsent.map((c) => c.eventId)).toEqual([]);
  });

  it("still lists the earlier row when it is the one with the actual", () => {
    seedHeld(FX.symbol);
    seedEvent({
      id: FX.earlier.id,
      source: "manual",
      symbol: FX.symbol,
      eventDate: FX.earlier.eventDate,
      actual: FX.laterRowActual,
      enrichedAt: "2026-06-10 20:30:00",
    });
    seedEvent({ id: FX.later.id, source: "manual", symbol: FX.symbol, eventDate: FX.later.eventDate });
    const { unsent } = findDebriefCandidates(db, { now: new Date("2026-06-11T11:00:00Z") });
    expect(unsent.map((c) => c.eventId)).toEqual([FX.earlier.id]);
  });
});

describe("getExpectedRecapCluster (end-of-day wrap) — two hand-entered rows for one company", () => {
  it("leaves the later row out of its day's cluster", () => {
    seedFixture({ actual: FX.laterRowActual, enrichedAt: FX.laterRowEnrichedAt });
    expect(getExpectedRecapCluster(db, FX.later.eventDate, "AMC")).toEqual([]);
  });

  it("keeps the earlier row in its day's cluster", () => {
    seedFixture();
    expect(getExpectedRecapCluster(db, FX.earlier.eventDate, "AMC").map((m) => m.eventId)).toEqual([
      FX.earlier.id,
    ]);
  });
});
