/**
 * The nightly snapshot is what the Worker composes a fallback earnings email
 * from. A bogey row with every content column empty is not coverage (owner
 * ruling 2026-08-12), so it never leaves the Mac: the snapshot select carries
 * the same predicate every Mac reader uses.
 *
 * Invented issuers and round figures only: the repo is public.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getEarningsBogeysForSnapshot } from "@/scripts/snapshot-state-to-r2";

let db: Database.Database;

function seedEvent(symbol: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of)
         VALUES ('manual', 'earnings', '2026-04-28', ?, ?, ?, '2026-04-27')`,
      )
      .run(`${symbol} earnings`, symbol, `manual:${symbol}:2026-04-28:earnings`).lastInsertRowid,
  );
}

function seedRow(eventId: number, label: string, cols: Record<string, unknown> = {}): number {
  const names = Object.keys(cols);
  return Number(
    db
      .prepare(
        `INSERT INTO earnings_bogeys (event_id, source, source_label, uploaded_at${names.map((n) => `, ${n}`).join("")})
         VALUES (?, 'newsletter', ?, datetime('now')${names.map(() => ", ?").join("")})`,
      )
      .run(eventId, label, ...Object.values(cols)).lastInsertRowid,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getEarningsBogeysForSnapshot", () => {
  it("leaves out rows that hold nothing", () => {
    const zza = seedEvent("ZZA");
    const zzb = seedEvent("ZZB");
    seedRow(zza, "empty");
    seedRow(zza, "blank text", { notes: "  ", guidance_notes: "", segment_breakdown_json: "{}", extra_metrics_json: "[]" });
    const figure = seedRow(zzb, "figure", { eps_consensus: 0 });
    const note = seedRow(zzb, "note", { guidance_notes: "watch the guide" });

    const rows = getEarningsBogeysForSnapshot(db, "2026-04-01", "2026-05-31");
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([figure, note]);
    // ZZA's only rows are empty: the Worker sees it exactly as an event with none.
    expect(rows.filter((r) => r.event_id === zza)).toEqual([]);
  });
});
