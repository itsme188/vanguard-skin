/**
 * QA follow-up to today-releases--held-ticker-unlinked-no-sibling-fill-
 * regression-1: getUpcomingEvents (lib/queries/calendar.ts) is the FOURTH
 * reader in this file and the only one that never applied the read-side
 * dual-class sibling fallback the other three (getEventsByWeek,
 * getTodayReleases, getEarningsForWeekDeduped) already carry.
 *
 * Worse than the other three's gap: when called with `filters.securityId`
 * (Security Detail's Upcoming Events block — lib/queries/security-detail.ts
 * ~line 614 calls `getUpcomingEvents(db, { securityId: security.id, ... })`)
 * the SQL itself filtered `security_id = ?`, which a NULL-security_id row
 * can never match — a manually added event for a held ticker was invisible
 * on that security's own hub page, not just unlinked.
 *
 * A manual row can carry security_id NULL even when the security (or a
 * sibling share class) exists — POST /api/calendar/events resolves through
 * the stock-only getSecurityIdForSymbol, which refuses a securities row
 * with a NULL security_type.
 *
 * Fix: when securityId is set, widen the SQL predicate to also match a
 * NULL-security_id row whose symbol is in the target security's issuer
 * family (issuerSiblings() — never a symbol-string-equal check, e.g. GOOGL
 * must surface on the GOOG security page too); the unfiltered path gets the
 * same generic post-process fallback the other three readers use.
 *
 * Read side only: the stored calendar_events row is never mutated.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getUpcomingEvents } from "@/lib/queries/calendar";
import { todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

/** A securities row with NO security_type — exactly the shape the stock-only
 * write-side resolver refuses, which is how these events end up NULL. */
function seedTypelessSecurity(symbol: string): number {
  const res = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class) VALUES (?, ?, NULL, NULL)",
    )
    .run(symbol, `${symbol} Holdings`);
  return res.lastInsertRowid as number;
}

function insertEvent(opts: {
  symbol: string;
  eventDate: string;
  securityId?: number | null;
  superseded?: number;
}): number {
  const res = db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, release_time, title, symbol,
          security_id, source_key, superseded)
       VALUES ('manual', 'earnings', ?, '16:05', ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.eventDate,
      `${opts.symbol} earnings (Manual entry)`,
      opts.symbol,
      opts.securityId ?? null,
      `manual:${opts.symbol}:${opts.eventDate}`,
      opts.superseded ?? 0,
    );
  return res.lastInsertRowid as number;
}

describe("getUpcomingEvents(securityId) widens to the issuer family", () => {
  it("surfaces a NULL-security_id row for a SIBLING symbol (GOOGL row, querying GOOG's security)", () => {
    const googId = seedTypelessSecurity("GOOG");
    insertEvent({ symbol: "GOOGL", eventDate: todayET(), securityId: null });

    const events = getUpcomingEvents(db, { securityId: googId, startDate: todayET() });

    expect(events).toHaveLength(1);
    expect(events[0].symbol).toBe("GOOGL");
    // Filled to the CALLER's own security id, not a fresh generic lookup.
    expect(events[0].security_id).toBe(googId);
  });

  it("surfaces a NULL-security_id row for the security's OWN symbol too", () => {
    const securityId = seedTypelessSecurity("QAAA");
    insertEvent({ symbol: "QAAA", eventDate: todayET(), securityId: null });

    const events = getUpcomingEvents(db, { securityId, startDate: todayET() });

    expect(events).toHaveLength(1);
    expect(events[0].security_id).toBe(securityId);
  });

  it("does not rewrite the stored calendar_events row", () => {
    const googId = seedTypelessSecurity("GOOG");
    const eventId = insertEvent({ symbol: "GOOGL", eventDate: todayET(), securityId: null });

    getUpcomingEvents(db, { securityId: googId, startDate: todayET() });

    const stored = db
      .prepare("SELECT security_id FROM calendar_events WHERE id = ?")
      .get(eventId) as { security_id: number | null };
    expect(stored.security_id).toBeNull();
  });

  it("keeps an already-resolved security_id untouched", () => {
    const googId = seedTypelessSecurity("GOOG");
    insertEvent({ symbol: "GOOG", eventDate: todayET(), securityId: googId });

    const events = getUpcomingEvents(db, { securityId: googId, startDate: todayET() });
    expect(events).toHaveLength(1);
    expect(events[0].security_id).toBe(googId);
  });

  it("does not leak an unrelated symbol's NULL-security_id row into a different security's results", () => {
    const googId = seedTypelessSecurity("GOOG");
    seedTypelessSecurity("AAPL");
    insertEvent({ symbol: "AAPL", eventDate: todayET(), securityId: null });

    const events = getUpcomingEvents(db, { securityId: googId, startDate: todayET() });
    expect(events).toEqual([]);
  });

  it("still excludes superseded rows under the widened predicate", () => {
    const googId = seedTypelessSecurity("GOOG");
    insertEvent({ symbol: "GOOGL", eventDate: todayET(), securityId: null, superseded: 1 });

    const events = getUpcomingEvents(db, { securityId: googId, startDate: todayET() });
    expect(events).toEqual([]);
  });

  it("falls back to a plain equality match (no throw) when the securityId does not exist in securities", () => {
    const events = getUpcomingEvents(db, { securityId: 999999, startDate: todayET() });
    expect(events).toEqual([]);
  });

  it("combines with other filters (startDate) exactly as before", () => {
    const googId = seedTypelessSecurity("GOOG");
    insertEvent({ symbol: "GOOG", eventDate: "2020-01-01", securityId: googId });
    insertEvent({ symbol: "GOOGL", eventDate: todayET(), securityId: null });

    const events = getUpcomingEvents(db, { securityId: googId, startDate: todayET() });
    expect(events.map((e) => e.symbol)).toEqual(["GOOGL"]);
  });
});

describe("getUpcomingEvents (unfiltered by securityId) applies the same generic sibling fallback the other three readers use", () => {
  it("resolves a NULL security_id from the securities table when no securityId filter is given", () => {
    const securityId = seedTypelessSecurity("QAAA");
    insertEvent({ symbol: "QAAA", eventDate: todayET(), securityId: null });

    const events = getUpcomingEvents(db, { startDate: todayET() });

    expect(events).toHaveLength(1);
    expect(events[0].security_id).toBe(securityId);
  });

  it("resolves via the issuer family when no securityId filter is given", () => {
    const googId = seedTypelessSecurity("GOOG");
    insertEvent({ symbol: "GOOGL", eventDate: todayET(), securityId: null });

    const events = getUpcomingEvents(db, { startDate: todayET() });

    expect(events).toHaveLength(1);
    expect(events[0].security_id).toBe(googId);
  });

  it("leaves security_id null when the symbol is in no securities row", () => {
    insertEvent({ symbol: "QZZZ", eventDate: todayET(), securityId: null });

    const events = getUpcomingEvents(db, { startDate: todayET() });

    expect(events).toHaveLength(1);
    expect(events[0].security_id).toBeNull();
  });
});
