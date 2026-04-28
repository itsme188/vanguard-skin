import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertBogey, deleteBogey } from "@/lib/mutations/earnings-bogeys";
import {
  getBogeysForEvent,
  getPrimaryBogeyForEvent,
} from "@/lib/queries/earnings-bogeys";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Seed a calendar_events row to satisfy the FK.
  db.prepare(
    `INSERT INTO calendar_events
       (id, source, event_type, event_date, title, source_key, fetched_at, week_of)
     VALUES
       (1, 'manual', 'earnings', '2026-04-28', 'GLW Earnings', 'manual:GLW:2026-04-28:earnings', datetime('now'), '2026-04-27')`,
  ).run();
  return db;
}

describe("upsertBogey", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("creates a new manual bogey", () => {
    const r = upsertBogey(db, {
      event_id: 1,
      source: "manual",
      eps_consensus: 0.46,
      eps_whisper: 0.5,
      revenue_consensus_usd: 3_850_000_000,
    });
    expect(r.created).toBe(true);
    expect(r.id).toBeGreaterThan(0);

    const all = getBogeysForEvent(db, 1);
    expect(all).toHaveLength(1);
    expect(all[0].eps_consensus).toBe(0.46);
    expect(all[0].eps_whisper).toBe(0.5);
    expect(all[0].revenue_consensus_usd).toBe(3_850_000_000);
  });

  it("updates in place on (event_id, source, source_label) conflict", () => {
    const a = upsertBogey(db, {
      event_id: 1,
      source: "pdf_upload",
      source_label: "TMT Breakout 2026-04-28",
      eps_consensus: 0.46,
    });
    const b = upsertBogey(db, {
      event_id: 1,
      source: "pdf_upload",
      source_label: "TMT Breakout 2026-04-28",
      eps_consensus: 0.48, // updated
      eps_whisper: 0.5, // newly populated
    });

    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);

    const all = getBogeysForEvent(db, 1);
    expect(all).toHaveLength(1);
    expect(all[0].eps_consensus).toBe(0.48);
    expect(all[0].eps_whisper).toBe(0.5);
  });

  it("allows different sources to coexist on the same event", () => {
    upsertBogey(db, {
      event_id: 1,
      source: "pdf_upload",
      source_label: "TMT Breakout",
      eps_consensus: 0.46,
    });
    upsertBogey(db, {
      event_id: 1,
      source: "manual",
      source_label: "user note",
      eps_whisper: 0.5,
    });

    const all = getBogeysForEvent(db, 1);
    expect(all).toHaveLength(2);
  });

  it("returns most-recently-uploaded as primary", () => {
    const first = upsertBogey(db, {
      event_id: 1,
      source: "pdf_upload",
      source_label: "old",
      eps_consensus: 0.4,
    });
    // Sleep to advance datetime('now') tick.
    db.prepare("UPDATE earnings_bogeys SET uploaded_at = '2026-04-27 10:00:00' WHERE id = ?").run(first.id);

    upsertBogey(db, {
      event_id: 1,
      source: "manual",
      source_label: "fresh",
      eps_consensus: 0.5,
    });

    const primary = getPrimaryBogeyForEvent(db, 1);
    expect(primary?.source_label).toBe("fresh");
  });

  it("supports delete", () => {
    const r = upsertBogey(db, {
      event_id: 1,
      source: "manual",
      eps_consensus: 0.46,
    });
    expect(getBogeysForEvent(db, 1)).toHaveLength(1);
    const ok = deleteBogey(db, r.id);
    expect(ok).toBe(true);
    expect(getBogeysForEvent(db, 1)).toHaveLength(0);
  });
});
