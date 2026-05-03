/**
 * Coverage for the per-event skip filter in findEmailCandidates.
 *
 * Earnings preview/recap candidates are filtered by 4 gates:
 *   - master enable (settings.earnings_emails_enabled)
 *   - per-symbol mute (settings.earnings_emails_muted_symbols)
 *   - audit row absence (earnings_emails)
 *   - skip row absence (earnings_email_skips) ← new in 2026-05-03
 *
 * These tests pin the new gate without re-asserting the others.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";
import { recordEarningsEmailSkip } from "@/lib/mutations/earnings-skips";

function seedAccount(db: Database.Database, name: string): number {
  return (db.prepare("INSERT INTO accounts (name) VALUES (?) RETURNING id").get(name) as { id: number }).id;
}

function seedHeldEarnings(
  db: Database.Database,
  symbol: string,
  eventDate: string,
  releaseTime: string,
): number {
  const accountId = seedAccount(db, `acct-${symbol}`);
  const securityId = (db
    .prepare(
      `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
       VALUES (?, 'stock', 'equity', 1) RETURNING id`,
    )
    .get(symbol) as { id: number }).id;
  // Held position so the symbol passes getSymbolStatus = 'held'.
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date)
     VALUES (?, ?, ?, date('now'))`,
  ).run(accountId, securityId, 100);

  const result = db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, security_id, source_key, week_of
       ) VALUES ('finnhub','earnings',?,?,?,?,?,?,?,?)`,
    )
    .run(
      eventDate,
      releaseTime,
      releaseTime,
      `${symbol} earnings`,
      symbol,
      securityId,
      `finnhub:${symbol}:${eventDate}`,
      eventDate,
    );
  return result.lastInsertRowid as number;
}

describe("findEmailCandidates — skip filter", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("excludes preview candidates whose preview is marked skipped", () => {
    // Held AAPL earnings 2 hours from `now` — squarely in the preview window.
    const eventId = seedHeldEarnings(db, "AAPL", "2026-06-01", "16:30");
    const now = new Date("2026-06-01T18:30:00Z"); // 2h before 16:30 ET = 20:30 UTC

    // Without skip → should appear as preview candidate.
    const before = findEmailCandidates(db, { now });
    expect(before.some((c) => c.eventId === eventId && c.phase === "preview")).toBe(true);

    // After skip → excluded.
    recordEarningsEmailSkip(db, eventId, "preview");
    const after = findEmailCandidates(db, { now });
    expect(after.some((c) => c.eventId === eventId && c.phase === "preview")).toBe(false);
  });

  it("preview-skip does not affect recap eligibility (and vice versa)", () => {
    const eventId = seedHeldEarnings(db, "MSFT", "2026-05-30", "16:05");
    // Mark recap-enriched 1h ago so recap window is open.
    db.prepare(
      "UPDATE calendar_events SET actual_value = 'EPS 1.00', enriched_at = datetime('now', '-1 hour') WHERE id = ?",
    ).run(eventId);

    recordEarningsEmailSkip(db, eventId, "preview"); // skip preview only

    const candidates = findEmailCandidates(db, { now: new Date() });
    expect(candidates.some((c) => c.eventId === eventId && c.phase === "recap")).toBe(true);
    expect(candidates.some((c) => c.eventId === eventId && c.phase === "preview")).toBe(false);
  });

  it("recap skip excludes recap candidates", () => {
    const eventId = seedHeldEarnings(db, "META", "2026-05-30", "16:05");
    db.prepare(
      "UPDATE calendar_events SET actual_value = 'EPS 1.00', enriched_at = datetime('now', '-1 hour') WHERE id = ?",
    ).run(eventId);

    const before = findEmailCandidates(db, { now: new Date() });
    expect(before.some((c) => c.eventId === eventId && c.phase === "recap")).toBe(true);

    recordEarningsEmailSkip(db, eventId, "recap");
    const after = findEmailCandidates(db, { now: new Date() });
    expect(after.some((c) => c.eventId === eventId && c.phase === "recap")).toBe(false);
  });
});
