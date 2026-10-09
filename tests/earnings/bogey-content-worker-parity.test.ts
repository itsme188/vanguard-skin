/**
 * Mac and Worker must give one answer to "does this bogey row hold anything?"
 * (owner ruling 2026-08-12: an all-empty row is not coverage).
 *
 *   Mac:    bogeyHasContent / bogeyHasContentSql   lib/mutations/earnings-bogeys.ts
 *   Worker: snapshotBogeyHasContent                workers/cron/src/bogey-content.ts
 *
 * The Worker cannot import the Mac module (it pulls better-sqlite3), so the
 * parity is pinned from this side: the Worker file has no imports.
 *
 * Three links, so drift anywhere fails:
 *   1. the two column lists are the same list;
 *   2. the two rules agree on every probe value in every column;
 *   3. end to end: rows the Mac's snapshot select lets through are rows the
 *      Worker counts, except the one named gap (a column the snapshot does not
 *      carry), which reads as empty in the cloud and is pinned as such.
 *
 * Invented issuers and round figures only: the repo is public.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { bogeyHasContent, CONTENT_COLUMNS } from "@/lib/mutations/earnings-bogeys";
import { getBogeysWithContentForEvent } from "@/lib/queries/earnings-bogeys";
import { getEarningsBogeysForSnapshot } from "@/scripts/snapshot-state-to-r2";
import {
  snapshotBogeyHasContent,
  SNAPSHOT_BOGEY_CONTENT_COLUMNS,
} from "@/workers/cron/src/bogey-content";

/** Content columns the snapshot row does not carry. Adding one here is a
 *  decision: such a row counts on the Mac and reads as empty in the cloud. */
const NOT_IN_SNAPSHOT = ["extra_metrics_json"];

const PROBES: unknown[] = [
  null,
  undefined,
  0,
  1.5,
  -2,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "",
  "   ",
  "[]",
  " {} ",
  "{}",
  "watch the guide",
  '{"Cloud":{"consensus":100}}',
  '[{"label":"Bookings","value":"100"}]',
];

describe("bogey content rule: Mac and Worker agree", () => {
  it("the column lists are the same list", () => {
    expect([...SNAPSHOT_BOGEY_CONTENT_COLUMNS]).toEqual([...CONTENT_COLUMNS]);
  });

  it("an empty object is empty on both sides", () => {
    expect(bogeyHasContent({})).toBe(false);
    expect(snapshotBogeyHasContent({})).toBe(false);
  });

  it.each(CONTENT_COLUMNS.map((c) => [c]))("every probe value in %s gets the same answer", (col) => {
    for (const value of PROBES) {
      const row = { [col]: value };
      expect(snapshotBogeyHasContent(row), `${col} = ${JSON.stringify(value)}`).toBe(bogeyHasContent(row));
    }
  });
});

describe("end to end: Mac send reader, snapshot select and Worker count the same rows", () => {
  let db: Database.Database;
  let eventId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    eventId = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of)
           VALUES ('manual', 'earnings', '2026-04-28', 'ZZA earnings', 'ZZA', 'manual:ZZA:2026-04-28:earnings', '2026-04-27')`,
        )
        .run().lastInsertRowid,
    );
  });

  function seedRow(label: string, cols: Record<string, unknown> = {}): number {
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

  const SAMPLE: Record<string, unknown> = {
    eps_consensus: 0,
    eps_whisper: 1.5,
    revenue_consensus_usd: 100_000_000,
    revenue_whisper_usd: 110_000_000,
    expected_move_pct: 5,
    eps_consensus_vendor: 1,
    segment_breakdown_json: '{"Cloud":{"consensus":100}}',
    guidance_notes: "watch the guide",
    notes: "a note",
    extra_metrics_json: '[{"label":"Bookings","value":"100"}]',
  };

  const macIds = () => getBogeysWithContentForEvent(db, eventId).map((b) => b.id).sort((a, b) => a - b);
  const workerIds = () =>
    getEarningsBogeysForSnapshot(db, "2026-04-01", "2026-05-31")
      // What resolveBogeysForEvent does with the snapshot rows.
      .filter((b) => b.event_id === eventId && snapshotBogeyHasContent(b))
      .map((b) => b.id)
      .sort((a, b) => a - b);

  it("only-empty rows: no bogeys on either side", () => {
    seedRow("empty");
    seedRow("blank", { notes: " ", guidance_notes: "", segment_breakdown_json: "{}", extra_metrics_json: "[]" });
    expect(macIds()).toEqual([]);
    expect(workerIds()).toEqual([]);
  });

  it("one row per snapshot-carried content column: both sides count every one", () => {
    seedRow("empty");
    const ids = CONTENT_COLUMNS.filter((c) => !NOT_IN_SNAPSHOT.includes(c)).map((c) =>
      seedRow(`only ${c}`, { [c]: SAMPLE[c] }),
    );
    expect(macIds()).toEqual(ids);
    expect(workerIds()).toEqual(ids);
  });

  it("the named gap: a row whose only content is a column the snapshot does not carry counts on the Mac only", () => {
    const ids = NOT_IN_SNAPSHOT.map((c) => seedRow(`only ${c}`, { [c]: SAMPLE[c] }));
    expect(macIds()).toEqual(ids);
    expect(workerIds()).toEqual([]);
  });
});
