import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot-core";
import { assessReactionSnapshot } from "@/lib/calendar/reaction-validity";
import {
  planPrematureReactionRepair,
  runPrematureReactionRepair,
} from "@/scripts/repair-premature-reaction-snapshots";

// All prices are invented round figures; tickers are synthetic.

const T0 = "2026-01-05T15:00:00.000Z"; // 10:00 ET
const MIN = 60 * 1000;
const at = (min: number) => new Date(Date.parse(T0) + min * MIN).toISOString();
const LONG_AFTER = new Date("2026-02-01T00:00:00.000Z");

function snap(extra: Partial<ReactionSnapshot> = {}): ReactionSnapshot {
  return {
    t0_utc: T0,
    window_min: 120,
    source: "yahoo",
    spy: { t_pre: 500, t_post: 505, delta_pct: 1 },
    qqq: { t_pre: 400, t_post: 398, delta_pct: -0.5 },
    tlt: { t_pre: 90, t_post: 90.45, delta_pct: 0.5 },
    ...extra,
  };
}

let n = 0;
function seed(
  db: Database.Database,
  snapshot: ReactionSnapshot | string | null,
  opts: { enrichedAt?: string | null; symbol?: string | null } = {},
): number {
  n += 1;
  const raw = snapshot == null || typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot);
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, event_time, release_time, title, symbol,
            source_key, week_of, actual_value, enriched_at, reaction_snapshot)
         VALUES ('finnhub', 'earnings', '2026-01-05', '10:00', '10:00', 'Test event', ?,
                 ?, '2026-01-05', 'EPS 1.00', ?, ?)`,
      )
      .run(opts.symbol ?? "ZZA", `test:${n}`, opts.enrichedAt ?? "2026-01-05 17:05:00", raw).lastInsertRowid,
  );
}

function stored(db: Database.Database, id: number): string | null {
  return (db.prepare("SELECT reaction_snapshot AS s FROM calendar_events WHERE id = ?").get(id) as { s: string | null }).s;
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("repair-premature-reaction-snapshots", () => {
  it("dry-run by default: plans, writes nothing", () => {
    const db = freshDb();
    const early = seed(db, snap({ captured_at: at(7) }));
    const before = stored(db, early);

    const result = runPrematureReactionRepair(db, { now: LONG_AFTER });

    expect(result.applied).toBe(false);
    expect(result.plan.items.map((i) => [i.eventId, i.action])).toEqual([[early, "clear"]]);
    expect(stored(db, early)).toBe(before);
  });

  it("refuses to write without the acknowledgement", () => {
    const db = freshDb();
    const early = seed(db, snap({ captured_at: at(7) }));
    expect(() => runPrematureReactionRepair(db, { apply: true, now: LONG_AFTER })).toThrow(
      /--acknowledge-repair/,
    );
    expect(stored(db, early)).not.toBeNull();
  });

  it("clears premature snapshots, strips bad legs from old ones, leaves good ones, and is idempotent", () => {
    const db = freshDb();
    const good = seed(db, snap({ captured_at: at(121) }));
    const goodLegacy = seed(db, snap(), { enrichedAt: "2026-01-05 15:07:00" });
    const flatButStamped = seed(
      db,
      snap({ captured_at: at(125), tlt: { t_pre: 90, t_post: 90, delta_pct: 0 } }),
    );
    const early = seed(db, snap({ captured_at: at(7) }));
    // The reported shape: enriched 7 minutes in, the stock's own leg rounds to 0.00%.
    const reported = seed(
      db,
      snap({
        symbol: { symbol: "ZZB", t_pre: 100.006, t_post: 100.01, delta_pct: 0 },
        qqq: { t_pre: 0, t_post: 0, delta_pct: 0 },
      }),
      { enrichedAt: "2026-01-05 15:07:00", symbol: "ZZB" },
    );
    const nothingLeft = seed(
      db,
      snap({
        spy: { t_pre: 500, t_post: 500, delta_pct: 0 },
        qqq: { t_pre: 0, t_post: 0, delta_pct: 0 },
        tlt: { t_pre: 0, t_post: 0, delta_pct: 0 },
      }),
    );
    const unreadable = seed(db, "{not json");
    const empty = seed(db, null);

    const untouchedBefore = [good, goodLegacy, flatButStamped, unreadable].map((id) => stored(db, id));

    const plan = planPrematureReactionRepair(db, { now: LONG_AFTER });
    expect(plan.scanned).toBe(7);
    expect(plan.unreadable).toBe(1);
    expect(plan.items.map((i) => [i.eventId, i.action, i.willBeRecaptured])).toEqual([
      [early, "clear", false],
      [reported, "strip_legs", false],
      [nothingLeft, "clear", false],
    ]);
    const reportedItem = plan.items.find((i) => i.eventId === reported)!;
    expect(reportedItem.label).toBe("ZZB");
    expect([...reportedItem.strippedLegs].sort()).toEqual(["qqq", "symbol"]);

    const result = runPrematureReactionRepair(db, {
      apply: true,
      acknowledgeRepair: true,
      now: LONG_AFTER,
    });
    expect(result).toMatchObject({ applied: true, cleared: 2, stripped: 1 });

    expect(stored(db, early)).toBeNull();
    expect(stored(db, nothingLeft)).toBeNull();
    expect(stored(db, empty)).toBeNull();
    const kept = JSON.parse(stored(db, reported)!) as ReactionSnapshot;
    expect(kept.spy).toEqual({ t_pre: 500, t_post: 505, delta_pct: 1 });
    expect(kept.tlt).toEqual({ t_pre: 90, t_post: 90.45, delta_pct: 0.5 });
    expect("symbol" in kept).toBe(false);
    expect("qqq" in kept).toBe(false);
    expect(assessReactionSnapshot(kept, { rowEnrichedAt: "2026-01-05 15:07:00" }).valid).toBe(true);
    expect([good, goodLegacy, flatButStamped, unreadable].map((id) => stored(db, id))).toEqual(untouchedBefore);

    // Nothing else on the row moved.
    const row = db
      .prepare("SELECT actual_value, enriched_at FROM calendar_events WHERE id = ?")
      .get(early) as { actual_value: string; enriched_at: string };
    expect(row).toEqual({ actual_value: "EPS 1.00", enriched_at: "2026-01-05 17:05:00" });

    // Second run: nothing to do.
    const again = runPrematureReactionRepair(db, {
      apply: true,
      acknowledgeRepair: true,
      now: LONG_AFTER,
    });
    expect(again.plan.items).toEqual([]);
    expect(again).toMatchObject({ cleared: 0, stripped: 0 });
  });

  it("inside the runner's re-capture window a bad-leg snapshot is cleared whole so every leg is re-read", () => {
    const db = freshDb();
    const id = seed(db, snap({ qqq: { t_pre: 400, t_post: 400, delta_pct: 0 } }));

    const plan = planPrematureReactionRepair(db, { now: new Date(Date.parse(T0) + 130 * MIN) });
    expect(plan.items.map((i) => [i.eventId, i.action, i.willBeRecaptured])).toEqual([[id, "clear", true]]);

    // The same row one minute past the window (release + 150m) is stripped instead.
    const later = planPrematureReactionRepair(db, { now: new Date(Date.parse(T0) + 151 * MIN) });
    expect(later.items.map((i) => [i.eventId, i.action, i.willBeRecaptured])).toEqual([
      [id, "strip_legs", false],
    ]);
  });

  it("makes no network call and prints no price", () => {
    const src = readFileSync(join(process.cwd(), "scripts/repair-premature-reaction-snapshots.ts"), "utf8");
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toContain("captureReaction");
    expect(src).not.toMatch(/console\.log\([^)]*t_(pre|post)/);
    expect(src).toContain("REPAIR_DB_PATH");
  });
});
