/**
 * Snapshot v13: `manualEarningsRows`.
 *
 * The "two hand-entered rows, one email" rule reads EVERY live hand-entered
 * earnings row on the Mac (lib/queries/manual-twin-email.ts), not a date
 * window. The Worker's copy of the rule used to see only the snapshot's
 * calendar window (yesterday to +7 days). The snapshot now ships the same
 * rows the Mac rule reads, as five columns and nothing else, so the Worker's
 * fallback refuses the same later row the Mac refuses.
 *
 * Runs the real snapshot builder and the real Worker union + rule on its
 * output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildSnapshot } from "@/scripts/snapshot-state-to-r2";
import { getEmailIgnoredManualTwins } from "@/lib/queries/manual-twin-email";
import { manualTwinRuleRows, issuerSiblings } from "../../workers/cron/src/fallback-earnings";
import { emailIgnoredManualTwins } from "../../workers/cron/src/manual-twin-email";
import type { Snapshot as WorkerSnapshot } from "../../workers/cron/src/state";

let db: Database.Database;

beforeEach(() => {
  // The later row's day: the earlier row (nine days before) is outside the
  // snapshot's calendar window, which starts yesterday.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-11T14:00:00Z"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function seedEvent(o: {
  id: number;
  symbol: string;
  eventDate: string;
  source?: string;
  eventType?: string;
  superseded?: number;
  consensus?: string | null;
  actual?: string | null;
}): void {
  const source = o.source ?? "manual";
  const eventType = o.eventType ?? "earnings";
  db.prepare(
    `INSERT INTO calendar_events
       (id, source, event_type, event_date, event_time, release_time, title, symbol,
        source_key, week_of, consensus_estimate, actual_value, superseded)
     VALUES (?, ?, ?, ?, 'AMC', '16:00', ?, ?, ?, '2026-06-08', ?, ?, ?)`,
  ).run(
    o.id,
    source,
    eventType,
    o.eventDate,
    `${o.symbol} ${eventType}`,
    o.symbol,
    `${source}:${o.symbol}:${o.eventDate}:${eventType}`,
    o.consensus ?? null,
    o.actual ?? null,
    o.superseded ?? 0,
  );
}

const snapshot = (): WorkerSnapshot => buildSnapshot(db) as unknown as WorkerSnapshot;

describe("snapshot manualEarningsRows", () => {
  it("is version 13", () => {
    expect(snapshot().schemaVersion).toBe(13);
  });

  it("carries every live hand-entered earnings row, in or out of the calendar window", () => {
    seedEvent({ id: 1, symbol: "ZZA", eventDate: "2026-06-02" }); // before the window
    seedEvent({ id: 2, symbol: "ZZA", eventDate: "2026-06-11" }); // inside it
    seedEvent({ id: 3, symbol: "ZZB", eventDate: "2026-09-01" }); // far after it
    seedEvent({ id: 4, symbol: "ZZB", eventDate: "2025-01-15" }); // long past

    const snap = snapshot();
    expect((snap.calendarEvents ?? []).map((e) => e.id)).toEqual([2]);
    expect(snap.manualEarningsRows).toEqual([
      { id: 1, symbol: "ZZA", event_date: "2026-06-02", source: "manual", event_type: "earnings" },
      { id: 2, symbol: "ZZA", event_date: "2026-06-11", source: "manual", event_type: "earnings" },
      { id: 3, symbol: "ZZB", event_date: "2026-09-01", source: "manual", event_type: "earnings" },
      { id: 4, symbol: "ZZB", event_date: "2025-01-15", source: "manual", event_type: "earnings" },
    ]);
  });

  it("leaves out superseded rows, vendor rows, rows of another kind and rows with no symbol", () => {
    seedEvent({ id: 1, symbol: "ZZA", eventDate: "2026-06-02", superseded: 1 });
    seedEvent({ id: 2, symbol: "ZZA", eventDate: "2026-06-03", source: "finnhub" });
    seedEvent({ id: 3, symbol: "ZZA", eventDate: "2026-06-04", eventType: "macro" });
    db.prepare(
      `INSERT INTO calendar_events (id, source, event_type, event_date, title, source_key, week_of)
       VALUES (4, 'manual', 'earnings', '2026-06-05', 'no symbol', 'manual::2026-06-05:earnings', '2026-06-01')`,
    ).run();
    seedEvent({ id: 5, symbol: "ZZA", eventDate: "2026-06-11" });

    expect((snapshot().manualEarningsRows ?? []).map((r) => r.id)).toEqual([5]);
  });

  it("ships those five columns and no figure: a row's estimate and actual stay out", () => {
    seedEvent({
      id: 1,
      symbol: "ZZA",
      eventDate: "2026-06-02",
      consensus: "EPS 7.77 · Rev 7770000",
      actual: "EPS 8.88 · Rev 8880000",
    });
    const rows = snapshot().manualEarningsRows ?? [];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["event_date", "event_type", "id", "source", "symbol"]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("7.77");
    expect(text).not.toContain("8.88");
  });

  it("is an empty list, not a missing field, when there are no hand-entered rows", () => {
    seedEvent({ id: 1, symbol: "ZZA", eventDate: "2026-06-11", source: "finnhub" });
    expect(snapshot().manualEarningsRows).toEqual([]);
  });

  it("nine days apart: the Worker's rule on the snapshot ignores the same row the Mac ignores", () => {
    seedEvent({ id: 1, symbol: "ZZA", eventDate: "2026-06-02" });
    seedEvent({ id: 2, symbol: "ZZA", eventDate: "2026-06-11" });
    seedEvent({ id: 3, symbol: "GOOG", eventDate: "2026-06-03" });
    seedEvent({ id: 4, symbol: "GOOGL", eventDate: "2026-06-12" }); // same issuer family
    seedEvent({ id: 5, symbol: "ZZB", eventDate: "2026-05-20" });
    seedEvent({ id: 6, symbol: "ZZB", eventDate: "2026-06-11" }); // 22 days: a different quarter

    const snap = snapshot();
    const mac = getEmailIgnoredManualTwins(db);
    expect([...mac.keys()].sort()).toEqual([2, 4]);

    const worker = emailIgnoredManualTwins(
      manualTwinRuleRows(snap, snap.calendarEvents ?? []),
      issuerSiblings,
    );
    expect([...worker.entries()].sort((a, b) => a[0] - b[0])).toEqual(
      [...mac.entries()].sort((a, b) => a[0] - b[0]),
    );

    // Without the field the Worker saw neither twin: the gap this closes.
    const { manualEarningsRows: _dropped, ...older } = snap;
    const before = emailIgnoredManualTwins(
      manualTwinRuleRows(older as WorkerSnapshot, snap.calendarEvents ?? []),
      issuerSiblings,
    );
    expect(before.size).toBe(0);
  });
});
