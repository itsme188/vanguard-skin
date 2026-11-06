/**
 * A bogey is a pre-print figure. An article received at or after the print's
 * slot floor (16:00 ET for an after-close print, 07:00 ET for a before-open
 * one) is never offered to the extractor for THAT event, in the global scan
 * or in the armed rescan (QA finding 2026-11-03: a post-release recap note
 * became the first bogey card, its notes were the reported results, and the
 * filing page listed its figures under "Bogeys before the print"). The same
 * article can still feed a later reporter. Synthetic issuers and figures.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test-model" })),
}));

import { bogeyCutoffInstant, articleBeforePrint } from "@/lib/earnings/pre-print-floor";
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import {
  __filterReportersMentionedInArticleForTests as filterReporters,
  __getUpcomingReportersForTests as getUpcomingReporters,
} from "@/lib/earnings/extract-newsletter-bogeys";
import { makeNewsletterRescanStep } from "@/lib/earnings/prepare-steps/newsletter-rescan";
import { todayET, addDays } from "@/lib/calendar/date-utils";

const FILLER =
  " Desk prose that exists only to clear the two-hundred-character floor the scan query enforces on a newsletter body.".repeat(3);

/** SQLite's stored shape (space-separated UTC) for an instant. */
const stored = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

describe("bogeyCutoffInstant / articleBeforePrint", () => {
  it("is the slot floor when the slot is known", () => {
    const amc = bogeyCutoffInstant({ event_date: "2026-09-02", event_time: "AMC", release_time: "17:00", raw_json: null });
    expect(amc?.toISOString()).toBe(composeReleaseInstant("2026-09-02", "16:00")!.toISOString());
    const bmo = bogeyCutoffInstant({ event_date: "2026-09-02", event_time: "BMO", release_time: null, raw_json: null });
    expect(bmo?.toISOString()).toBe(composeReleaseInstant("2026-09-02", "07:00")!.toISOString());
  });

  it("falls back to the recorded release instant without a slot, and to no cutoff without either", () => {
    const rel = bogeyCutoffInstant({ event_date: "2026-09-02", event_time: null, release_time: "11:30", raw_json: null });
    expect(rel?.toISOString()).toBe(composeReleaseInstant("2026-09-02", "11:30")!.toISOString());
    expect(bogeyCutoffInstant({ event_date: "2026-09-02", event_time: null, release_time: null, raw_json: null })).toBeNull();
  });

  it("an article received at or after the cutoff is not before the print; no cutoff trusts the article", () => {
    const ev = { event_date: "2026-09-02", event_time: "AMC", release_time: null, raw_json: null };
    const floor = composeReleaseInstant("2026-09-02", "16:00")!;
    expect(articleBeforePrint(ev, stored(minutes(floor, -1)))).toBe(true);
    expect(articleBeforePrint(ev, stored(floor))).toBe(false);
    expect(articleBeforePrint(ev, stored(minutes(floor, 97)))).toBe(false);
    expect(articleBeforePrint(ev, floor.toISOString().replace(/\.\d{3}Z$/, "Z"))).toBe(false);
    expect(articleBeforePrint({ ...ev, event_time: null }, stored(minutes(floor, 97)))).toBe(true);
    expect(articleBeforePrint(ev, "not a date")).toBe(true);
  });
});

describe("global scan: per-reporter cutoff", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });
  afterEach(() => generateTextMock.mockReset());

  function seedHeldReporter(symbol: string, eventDate: string, eventTime: string | null): number {
    const sec = Number(
      db.prepare(`INSERT INTO securities (symbol, security_type) VALUES (?, 'stock')`).run(symbol).lastInsertRowid,
    );
    db.prepare(`INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (1, ?, 100, ?)`).run(sec, todayET());
    return Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, symbol, source_key)
           VALUES ('finnhub', 'earnings', ?, ?, ?, ?, ?)`,
        )
        .run(eventDate, eventTime, `${symbol} earnings`, symbol, `finnhub:${symbol}:${eventDate}`).lastInsertRowid,
    );
  }

  it("drops a reporter whose print has already started when the article arrived, keeps a later one", () => {
    const today = todayET();
    const amcId = seedHeldReporter("QAAA", today, "AMC");
    const laterId = seedHeldReporter("QBBB", addDays(today, 2), "BMO");
    const floor = composeReleaseInstant(today, "16:00")!;
    const reporters = getUpcomingReporters(db, { today });
    expect(reporters.map((r) => r.event_id).sort()).toEqual([amcId, laterId].sort());

    const text = `QAAA printed; QBBB previews: EPS 1.00${FILLER}`;
    const after = { id: 1, source_name: "Desk", subject: "wrap", received_at: stored(minutes(floor, 97)), raw_text: text };
    expect(filterReporters(after, reporters).map((r) => r.symbol)).toEqual(["QBBB"]);

    const before = { ...after, received_at: stored(minutes(floor, -60)) };
    expect(filterReporters(before, reporters).map((r) => r.symbol).sort()).toEqual(["QAAA", "QBBB"]);
  });
});

describe("armed rescan: candidates end at the print's cutoff", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });
  afterEach(() => generateTextMock.mockReset());

  it("never hands the extractor an article received at or after the slot floor", async () => {
    // A print three days ago, after the close: inside the rescan window either side of the floor.
    const eventDate = addDays(todayET(), -3);
    const floor = composeReleaseInstant(eventDate, "16:00")!;
    const ev = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, source_key, symbol)
           VALUES ('manual', 'earnings', ?, 'AMC', 'ACME', 'k', 'ACME')`,
        )
        .run(eventDate).lastInsertRowid,
    );
    db.prepare(`INSERT OR IGNORE INTO research_sources (id, name) VALUES (9001, 'TMT Breakout')`).run();
    const seedArticle = (receivedAt: string, subject: string) =>
      Number(
        db
          .prepare(
            `INSERT INTO research_articles (source_id, subject, sender, received_at, raw_text, bogeys_scanned_at)
             VALUES (9001, ?, 'desk@example.test', ?, ?, NULL)`,
          )
          .run(subject, receivedAt, `ACME EPS 0.60${FILLER}`).lastInsertRowid,
      );
    const preId = seedArticle(stored(minutes(floor, -120)), "preview");
    seedArticle(stored(minutes(floor, 30)), "first take");
    seedArticle(stored(floor), "at the floor");

    const extract = vi.fn().mockResolvedValue({ bogeysStored: 1, modelId: "claude-test-model", called: true });
    const step = makeNewsletterRescanStep({ extract });
    const ctx = { now: () => Date.now(), signal: new AbortController().signal };
    const out = await step.run(db, ev, ctx);
    expect(out.status).toBe("done");
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][1].id).toBe(preId);
  });
});
