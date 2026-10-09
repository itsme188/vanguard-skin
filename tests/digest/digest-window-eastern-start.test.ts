/**
 * A date-only digest window opens at midnight Eastern, not midnight UTC.
 * SQLite datetime('YYYY-MM-DD') is UTC midnight = 8 PM ET the evening before.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { easternDayStartIso } from "@/lib/calendar/date-utils";
import { digestWindowStartInstant } from "@/lib/digest/digest-window";
import { getRecentArticles } from "@/lib/queries/research";

describe("easternDayStartIso", () => {
  it("is 04:00Z during daylight time", () => {
    expect(easternDayStartIso("2026-10-08")).toBe("2026-10-08T04:00:00.000Z");
  });
  it("is 05:00Z during standard time", () => {
    expect(easternDayStartIso("2026-01-15")).toBe("2026-01-15T05:00:00.000Z");
  });
  it("handles the spring-forward and fall-back days", () => {
    expect(easternDayStartIso("2026-03-08")).toBe("2026-03-08T05:00:00.000Z");
    expect(easternDayStartIso("2026-11-01")).toBe("2026-11-01T04:00:00.000Z");
  });
});

describe("digestWindowStartInstant", () => {
  it("leaves a full instant unchanged", () => {
    expect(digestWindowStartInstant("2026-03-05T12:00:00.000Z")).toBe("2026-03-05T12:00:00.000Z");
  });
  it("turns a date into the Eastern midnight instant", () => {
    expect(digestWindowStartInstant("2026-10-08")).toBe("2026-10-08T04:00:00.000Z");
  });
});

describe("getRecentArticles with a date-only window", () => {
  function seed(db: Database.Database, subject: string, receivedAt: string) {
    const source = db
      .prepare("INSERT INTO research_sources (name, sender_email, is_active) VALUES (?, ?, 1)")
      .run(subject, `${subject.toLowerCase()}@example.com`);
    db.prepare(
      `INSERT INTO research_articles
         (source_id, subject, sender, received_at, raw_text, summary, sentiment, processed_at)
       VALUES (?, ?, 'src@example.com', ?, 'body', 'Summary text', 'neutral', datetime('now'))`,
    ).run(source.lastInsertRowid as number, subject, receivedAt);
  }

  it("excludes the prior evening's Eastern arrivals", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seed(db, "EveningBefore", "2026-10-08 01:10:00"); // Oct 7, 9:10 PM ET
    seed(db, "NextMorning", "2026-10-08 13:00:00");
    const base = { processedOnly: true, relevantOnly: true } as const;
    const fixed = getRecentArticles(db, { ...base, startDate: digestWindowStartInstant("2026-10-08") });
    expect(fixed.map((a) => a.subject)).toEqual(["NextMorning"]);
    const bare = getRecentArticles(db, { ...base, startDate: "2026-10-08" });
    expect(bare).toHaveLength(2);
  });
});
