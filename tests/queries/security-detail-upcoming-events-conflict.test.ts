import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getUpcomingEvents } from "@/lib/queries/calendar";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * QA finding security-detail-upcoming-events--date-conflicted-earnings-row-rendered-as-settled-no-marker.
 *
 * The security hub's `upcomingEvents` (lib/queries/security-detail.ts) is
 * `getUpcomingEvents(db, { securityId, startDate, limit })` verbatim — no
 * column projection in between. This proves the plumbing end to end: a
 * calendar_events row's date_status/date_conflict_with (migration 057)
 * survive the securityId-scoped read the security hub actually uses, so
 * the render-layer fix (EarningsConflictMarker) has real data to key off.
 * Symbol is synthetic (XMPL convention).
 */
function seedSecurity(db: Database.Database, symbol: string): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`);
  return result.lastInsertRowid as number;
}

describe("getUpcomingEvents(securityId) carries date_status/date_conflict_with", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns date_status='conflict' and the competing vendor date for a conflicted earnings row", () => {
    const secId = seedSecurity(db, "XMPL1");
    const future = todayET().slice(0, 4) + "-12-15"; // safely in the future for any test run this year

    db.prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, security_id, symbol, source_key, week_of,
          date_status, date_conflict_with)
       VALUES ('nasdaq', 'earnings', ?, 'XMPL1 Q4 Earnings', ?, 'XMPL1', 'nasdaq:xmpl1:2026-12-15', '2026-12-14',
               'conflict', 'finnhub:2026-12-08')`,
    ).run(future, secId);

    const rows = getUpcomingEvents(db, { securityId: secId, startDate: todayET(), limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].date_status).toBe("conflict");
    expect(rows[0].date_conflict_with).toBe("finnhub:2026-12-08");
  });

  it("returns date_status=null unchanged for an unreconciled row (no regression on the common case)", () => {
    const secId = seedSecurity(db, "XMPL2");
    const future = todayET().slice(0, 4) + "-12-16";

    db.prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, security_id, symbol, source_key, week_of)
       VALUES ('finnhub', 'earnings', ?, 'XMPL2 Q4 Earnings', ?, 'XMPL2', 'finnhub:xmpl2:2026-12-16', '2026-12-14')`,
    ).run(future, secId);

    const rows = getUpcomingEvents(db, { securityId: secId, startDate: todayET(), limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].date_status).toBeNull();
    expect(rows[0].date_conflict_with).toBeNull();
  });
});
