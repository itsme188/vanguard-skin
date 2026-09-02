import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getArmedWorksheetEvents } from "@/lib/queries/earnings-worksheet-flags";

let db: Database.Database;
const EVENT_DATE = "2026-09-02";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSecurity(symbol: string, conId: number | null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, ib_con_id)
         VALUES (?, ?, 'Stock', ?)`,
      )
      .run(symbol, `${symbol} Inc.`, conId).lastInsertRowid,
  );
}

function seedArmedEvent(
  symbol: string,
  opts: { securityId?: number | null; eventConId?: number | null } = {},
): number {
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, event_time, title, symbol, security_id,
            ib_con_id, raw_json, source_key)
         VALUES ('finnhub', 'earnings', ?, 'AMC', ?, ?, ?, ?, '{}', ?)`,
      )
      .run(
        EVENT_DATE,
        `${symbol} earnings`,
        symbol,
        opts.securityId ?? null,
        opts.eventConId ?? null,
        `finnhub:${symbol}:${EVENT_DATE}`,
      ).lastInsertRowid,
  );
  db.prepare(`INSERT INTO earnings_worksheet_flags (event_id) VALUES (?)`).run(eventId);
  return eventId;
}

describe("getArmedWorksheetEvents — security_id", () => {
  it("returns the security row the event points at, conId or not", () => {
    // The SNOW shape: an armed, UNHELD name whose security row never got a
    // contract id, so the watcher has something to resolve one FROM.
    const securityId = seedSecurity("SNOW", null);
    const eventId = seedArmedEvent("SNOW", { securityId });

    const rows = getArmedWorksheetEvents(db, [EVENT_DATE]);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe(eventId);
    expect(rows[0].security_id).toBe(securityId);
    expect(rows[0].con_id).toBeNull();
  });

  it("resolves security_id by symbol when the event has no security_id", () => {
    const securityId = seedSecurity("NVDA", 4815747);
    seedArmedEvent("NVDA");

    const rows = getArmedWorksheetEvents(db, [EVENT_DATE]);
    expect(rows[0].security_id).toBe(securityId);
    expect(rows[0].con_id).toBe(4815747);
  });

  it("is null when no securities row exists for the symbol", () => {
    seedArmedEvent("ZZZZ");

    const rows = getArmedWorksheetEvents(db, [EVENT_DATE]);
    expect(rows[0].security_id).toBeNull();
    expect(rows[0].con_id).toBeNull();
  });

  it("still prefers the event's denormalized conId when the security has none", () => {
    const securityId = seedSecurity("SNOW", null);
    seedArmedEvent("SNOW", { securityId, eventConId: 444884769 });

    const rows = getArmedWorksheetEvents(db, [EVENT_DATE]);
    expect(rows[0].security_id).toBe(securityId);
    expect(rows[0].con_id).toBe(444884769);
  });
});
