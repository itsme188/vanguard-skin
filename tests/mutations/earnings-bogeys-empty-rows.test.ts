/**
 * Owner ruling 2026-08-12 (qa: all-empty-newsletter-bogey-counts-as-coverage,
 * empty-manual-bogey-saved-flips-chip): a bogey row with every content column
 * empty is not coverage. It is never stored, and the stored ones are purged by
 * scripts/repair-empty-bogeys.ts.
 *
 * Every figure here is invented (AAA / ZZZ, round numbers): the repo is public.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  upsertBogey,
  saveBogeyWithRecompile,
  bogeyHasContent,
  bogeyHasContentSql,
  CONTENT_COLUMNS,
} from "@/lib/mutations/earnings-bogeys";
import {
  planEmptyBogeyRepair,
  runEmptyBogeyRepair,
  formatPlan,
  parseArgs,
} from "@/scripts/repair-empty-bogeys";
import { getBogeysForEvent, getBogeysWithContentForEvent } from "@/lib/queries/earnings-bogeys";

let db: Database.Database;

function seedEvent(id: number, symbol: string): void {
  db.prepare(
    `INSERT INTO calendar_events (id, source, event_type, event_date, title, symbol, source_key, fetched_at, week_of)
     VALUES (?, 'manual', 'earnings', '2026-04-28', ?, ?, ?, datetime('now'), '2026-04-27')`,
  ).run(id, `${symbol} Earnings`, symbol, `manual:${symbol}:2026-04-28:earnings`);
}

/** A stored empty row, the way the pre-ruling write path left them. */
function seedRawRow(eventId: number, label: string, cols: Record<string, unknown> = {}): number {
  const names = Object.keys(cols);
  const info = db
    .prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, uploaded_at${names.map((n) => `, ${n}`).join("")})
       VALUES (?, 'newsletter', ?, datetime('now')${names.map(() => ", ?").join("")})`,
    )
    .run(eventId, label, ...Object.values(cols));
  return Number(info.lastInsertRowid);
}

const count = () => (db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys`).get() as { n: number }).n;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  seedEvent(1, "AAA");
  seedEvent(2, "ZZZ");
});

describe("upsertBogey never stores an all-empty row", () => {
  it("overwrite mode, no row yet: nothing is inserted", () => {
    const r = upsertBogey(db, { event_id: 1, source: "manual", source_label: "desk" });
    expect(r).toEqual({ id: 0, created: false, skipped: true });
    expect(count()).toBe(0);
  });

  it("blank text and empty JSON containers are not content", () => {
    const r = upsertBogey(db, {
      event_id: 1,
      source: "pdf_upload",
      source_label: "sheet",
      notes: "   ",
      guidance_notes: "",
      segment_breakdown_json: "{}",
      extra_metrics_json: " [] ",
    });
    expect(r.skipped).toBe(true);
    expect(count()).toBe(0);
  });

  it("a note with no number IS content and is stored", () => {
    const r = upsertBogey(db, { event_id: 1, source: "manual", notes: "watch the guide" });
    expect(r.created).toBe(true);
    expect(count()).toBe(1);
  });

  it("a zero figure is a real figure and is stored", () => {
    const r = upsertBogey(db, { event_id: 1, source: "manual", eps_consensus: 0 });
    expect(r.created).toBe(true);
    expect(count()).toBe(1);
  });

  it("overwrite mode with an all-empty write leaves the stored figures alone", () => {
    const first = upsertBogey(db, { event_id: 1, source: "pdf_upload", source_label: "sheet", eps_consensus: 1.5 });
    const second = upsertBogey(db, { event_id: 1, source: "pdf_upload", source_label: "sheet" });
    expect(second).toEqual({ id: first.id, created: false, skipped: true });
    expect(count()).toBe(1);
    const row = db.prepare("SELECT eps_consensus FROM earnings_bogeys WHERE id = ?").get(first.id) as { eps_consensus: number };
    expect(row.eps_consensus).toBe(1.5);
  });

  it("the transaction wrapper reports the same skip and stores nothing", () => {
    const { result } = saveBogeyWithRecompile(db, { event_id: 1, source: "manual" });
    expect(result.skipped).toBe(true);
    expect(count()).toBe(0);
  });
});

describe("bogeyHasContent and its SQL twin agree, one content column at a time", () => {
  const sample: Record<(typeof CONTENT_COLUMNS)[number], unknown> = {
    eps_consensus: 1.5,
    eps_whisper: 1.6,
    revenue_consensus_usd: 2_000_000_000,
    revenue_whisper_usd: 2_100_000_000,
    expected_move_pct: 6,
    eps_consensus_vendor: 1.4,
    segment_breakdown_json: '{"Cloud":{"consensus":1000000000}}',
    guidance_notes: "guide above the street",
    notes: "a note",
    extra_metrics_json: '[{"id":"x"}]',
  };
  const sqlSays = (id: number) =>
    (db.prepare(`SELECT ${bogeyHasContentSql("b")} AS has FROM earnings_bogeys b WHERE b.id = ?`).get(id) as {
      has: number;
    }).has === 1;

  it("all-null is empty in both", () => {
    const id = seedRawRow(1, "empty");
    expect(bogeyHasContent({})).toBe(false);
    expect(sqlSays(id)).toBe(false);
  });

  it.each(CONTENT_COLUMNS.map((c) => [c]))("%s alone makes a row non-empty in both", (col) => {
    const id = seedRawRow(1, `only-${col}`, { [col]: sample[col] });
    expect(bogeyHasContent({ [col]: sample[col] })).toBe(true);
    expect(sqlSays(id)).toBe(true);
  });

  it.each([["notes", "  "], ["guidance_notes", ""], ["segment_breakdown_json", "{}"], ["extra_metrics_json", "[]"]])(
    "%s = %j is empty in both",
    (col, value) => {
      const id = seedRawRow(1, `blank-${col}`, { [col]: value });
      expect(bogeyHasContent({ [col]: value })).toBe(false);
      expect(sqlSays(id)).toBe(false);
    },
  );

  it("the no-alias form is usable in a single-table statement", () => {
    seedRawRow(1, "empty");
    seedRawRow(1, "full", { eps_consensus: 1.5 });
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys WHERE ${bogeyHasContentSql()}`).get() as { n: number }).n;
    expect(n).toBe(1);
  });
});

describe("scripts/repair-empty-bogeys.ts", () => {
  it("dry run lists the empty rows and writes nothing", () => {
    const emptyA = seedRawRow(1, "empty-a");
    seedRawRow(1, "full", { eps_consensus: 1.5 });
    const emptyZ = seedRawRow(2, "empty-z");
    seedRawRow(2, "note-only", { notes: "prose, no number" });
    seedRawRow(2, "vendor-only", { eps_consensus_vendor: 1.4 });

    const { plan, applied, deleted } = runEmptyBogeyRepair(db);
    expect(applied).toBe(false);
    expect(deleted).toBe(0);
    expect(plan.totalRows).toBe(5);
    expect(plan.emptyRows.map((r) => r.id)).toEqual([emptyA, emptyZ]);
    expect(plan.emptyRows[0]).toMatchObject({ eventId: 1, symbol: "AAA", eventDate: "2026-04-28", sourceLabel: "empty-a" });
    expect(plan.eventsLeftWithoutBogeys).toBe(0);
    expect(count()).toBe(5);
  });

  it("--apply deletes exactly the empty rows, and a second run changes nothing", () => {
    seedRawRow(1, "empty-a");
    const kept = seedRawRow(2, "full", { revenue_consensus_usd: 2_000_000_000 });

    const first = runEmptyBogeyRepair(db, { apply: true });
    expect(first.applied).toBe(true);
    expect(first.deleted).toBe(1);
    expect(first.plan.eventsLeftWithoutBogeys).toBe(1);
    expect((db.prepare(`SELECT id FROM earnings_bogeys`).all() as { id: number }[]).map((r) => r.id)).toEqual([kept]);

    const second = runEmptyBogeyRepair(db, { apply: true });
    expect(second.deleted).toBe(0);
    expect(planEmptyBogeyRepair(db).emptyRows).toEqual([]);
    expect(count()).toBe(1);
  });

  it("prints ids, events and labels, and names no figure column", () => {
    seedRawRow(1, "empty-a");
    const text = formatPlan(planEmptyBogeyRepair(db)).join("\n");
    expect(text).toContain("would delete");
    expect(text).toContain("[AAA 2026-04-28]");
    expect(text).toContain('label "empty-a"');
    expect(text).not.toMatch(/\$/);
  });

  it("dry run is the default and an unknown flag is refused", () => {
    expect(parseArgs([])).toEqual({ apply: false });
    expect(parseArgs(["--apply"])).toEqual({ apply: true });
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
  });
});

describe("getBogeysWithContentForEvent: the send-path reader skips all-empty rows", () => {
  it("an event whose only rows are empty reads exactly like an event with no rows", () => {
    seedRawRow(1, "Desk Notes 4/20");
    seedRawRow(1, "Desk Notes 4/21", { notes: "  ", segment_breakdown_json: "{}", extra_metrics_json: "[]" });
    expect(getBogeysWithContentForEvent(db, 1)).toEqual([]);
    expect(getBogeysWithContentForEvent(db, 2)).toEqual([]);
    // The unfiltered reader is unchanged: the edit modal still sees both rows.
    expect(getBogeysForEvent(db, 1)).toHaveLength(2);
  });

  it("keeps the rows that hold something, in the unfiltered reader's order", () => {
    seedRawRow(1, "empty");
    const withFigure = seedRawRow(1, "figure", { eps_consensus: 0 });
    const withNote = seedRawRow(1, "note", { notes: "watch the guide" });
    const all = getBogeysForEvent(db, 1).map((b) => b.id);
    const kept = getBogeysWithContentForEvent(db, 1).map((b) => b.id);
    expect(kept.sort()).toEqual([withFigure, withNote].sort());
    expect(getBogeysWithContentForEvent(db, 1).map((b) => b.id)).toEqual(
      all.filter((id) => id === withFigure || id === withNote),
    );
  });
});
