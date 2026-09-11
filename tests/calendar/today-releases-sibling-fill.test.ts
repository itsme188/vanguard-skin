/**
 * QA finding today-releases--held-ticker-unlinked-no-sibling-fill-regression-1:
 * TodayReleases.tsx gates its <SymbolLink> pill on `event.security_id != null`,
 * and the Today page's releases query read that column raw. A manually added
 * earnings event can carry security_id NULL even when the symbol IS in our
 * securities table — POST /api/calendar/events resolves through the
 * stock-only getSecurityIdForSymbol, which rejects a securities row whose
 * security_type is NULL — so the row rendered as dead plain text while the
 * EarningsHub on the same page linked the same symbol to its security hub.
 *
 * lib/queries/calendar.ts already applies the read-side sibling fallback
 * (getSecurityIdForSymbolWithSiblings) in getEventsByWeek,
 * getEarningsForWeekDeduped and the date-conflict query. This test pins the
 * same fallback onto the Today page's releases query, which now lives in
 * lib/queries/calendar.ts as getTodayReleases instead of inline in the page.
 *
 * Read side only: the stored calendar_events row is never mutated.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getTodayReleases } from "@/lib/queries/calendar";
import { todayET, addDays } from "@/lib/calendar/date-utils";

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

function insertRelease(opts: {
  symbol: string;
  eventDate: string;
  releaseTime?: string | null;
  securityId?: number | null;
  superseded?: number;
}): number {
  const res = db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, release_time, title, symbol,
          security_id, source_key, superseded)
       VALUES ('manual', 'earnings', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.eventDate,
      opts.releaseTime === undefined ? "16:05" : opts.releaseTime,
      `${opts.symbol} earnings (Manual entry)`,
      opts.symbol,
      opts.securityId ?? null,
      `manual:${opts.symbol}:${opts.eventDate}`,
      opts.superseded ?? 0,
    );
  return res.lastInsertRowid as number;
}

describe("getTodayReleases fills security_id read-side", () => {
  it("resolves a NULL security_id from the securities table even when security_type is NULL", () => {
    const securityId = seedTypelessSecurity("QAAA");
    insertRelease({ symbol: "QAAA", eventDate: todayET(), securityId: null });

    const { releases, mode } = getTodayReleases(db);

    expect(mode).toBe("today");
    expect(releases).toHaveLength(1);
    expect(releases[0].symbol).toBe("QAAA");
    expect(releases[0].security_id).toBe(securityId);
  });

  it("leaves security_id null when the symbol is in no securities row", () => {
    insertRelease({ symbol: "QZZZ", eventDate: todayET(), securityId: null });

    const { releases } = getTodayReleases(db);

    expect(releases).toHaveLength(1);
    expect(releases[0].symbol).toBe("QZZZ");
    expect(releases[0].security_id).toBeNull();
  });

  it("does not rewrite the stored calendar_events row", () => {
    seedTypelessSecurity("QAAA");
    const eventId = insertRelease({
      symbol: "QAAA",
      eventDate: todayET(),
      securityId: null,
    });

    getTodayReleases(db);

    const stored = db
      .prepare("SELECT security_id FROM calendar_events WHERE id = ?")
      .get(eventId) as { security_id: number | null };
    expect(stored.security_id).toBeNull();
  });

  it("keeps an already-resolved security_id untouched", () => {
    const securityId = seedTypelessSecurity("QAAA");
    insertRelease({ symbol: "QAAA", eventDate: todayET(), securityId });

    const { releases } = getTodayReleases(db);
    expect(releases[0].security_id).toBe(securityId);
  });
});

describe("getTodayReleases preserves the page's selection rules", () => {
  it("only returns today's rows that carry a release_time and are not superseded", () => {
    const today = todayET();
    insertRelease({ symbol: "QAAA", eventDate: today });
    insertRelease({ symbol: "QBBB", eventDate: today, releaseTime: null });
    insertRelease({ symbol: "QCCC", eventDate: today, superseded: 1 });

    const { releases, mode } = getTodayReleases(db);

    expect(mode).toBe("today");
    expect(releases.map((r) => r.symbol)).toEqual(["QAAA"]);
  });

  it("falls back to the next upcoming releases when today has none, with the same sibling fill", () => {
    const securityId = seedTypelessSecurity("QAAA");
    insertRelease({
      symbol: "QAAA",
      eventDate: addDays(todayET(), 2),
      securityId: null,
    });

    const { releases, mode } = getTodayReleases(db);

    expect(mode).toBe("upcoming");
    expect(releases).toHaveLength(1);
    expect(releases[0].security_id).toBe(securityId);
  });

  it("returns an empty upcoming list when nothing is scheduled", () => {
    const { releases, mode } = getTodayReleases(db);
    expect(releases).toEqual([]);
    expect(mode).toBe("upcoming");
  });
});
