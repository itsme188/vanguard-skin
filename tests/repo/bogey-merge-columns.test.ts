/**
 * Repo guard: the bogey collision rule's column lists must cover the WHOLE
 * `earnings_bogeys` table.
 *
 * mergeBogeys resolves a (source, source_label) collision by writing
 * `UPDATE earnings_bogeys SET <BOGEY_CONTENT ∪ BOGEY_PROVENANCE> = …` onto the
 * surviving row and then DELETEing the donor. Any column missing from those
 * two lists is therefore SILENTLY DESTROYED on every collision — the donor's
 * value is deleted and never copied across. That is a data-loss failure mode
 * with no runtime symptom, so it is pinned here instead: a migration that adds
 * a bogey column fails this test until `lib/earnings/event-merge.ts` is
 * updated.
 *
 * The remaining columns are the ones the merge handles by other means:
 *   id            — the surviving row's own primary key
 *   event_id      — the thing being merged (the repoint / the DELETE)
 *   source        — half the collision key, equal on both sides by definition
 *   source_label  — the other half, likewise
 *   uploaded_at   — written explicitly from the winning row
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { BOGEY_CONTENT, BOGEY_PROVENANCE } from "@/lib/earnings/event-merge";

/** Columns the merge deliberately does not carry through the SET list. */
const STRUCTURAL = ["id", "event_id", "source", "source_label", "uploaded_at"] as const;

describe("earnings_bogeys merge column lists cover the live schema", () => {
  it("BOGEY_CONTENT ∪ BOGEY_PROVENANCE ∪ structural == every column, exactly", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const schema = (
      db.prepare(`PRAGMA table_info('earnings_bogeys')`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    const covered = [...STRUCTURAL, ...BOGEY_CONTENT, ...BOGEY_PROVENANCE];

    // No column is claimed twice — a duplicate would make the SET list bind
    // the same column from two different sources.
    expect(new Set(covered).size).toBe(covered.length);

    const missing = schema.filter((c) => !covered.includes(c as (typeof covered)[number]));
    const extra = covered.filter((c) => !schema.includes(c));

    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    db.close();
  });
});
