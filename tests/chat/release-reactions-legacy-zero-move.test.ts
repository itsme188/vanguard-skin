/**
 * The chat tool `query_release_reactions` applies the legacy zero-move rule
 * (P1, 2026-10-08): an older snapshot with no capture stamp whose leg rounds
 * to exactly 0.00% on a row enriched well before the reaction window ended is
 * not a measurement, so the tool hands the model `state: "pending"` and no
 * figure. That needs the row's `enriched_at`, which the query now selects.
 *
 * Synthetic ticker and prices. Release 20:15 UTC, two-hour window: measurable
 * from 22:15 UTC.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS } from "@/lib/chat/tools";
import { getRecentReleaseReactions } from "@/lib/queries/level-performance";
import { todayET, addDays } from "@/lib/calendar/date-utils";

const T0 = "2026-09-10T20:15:00.000Z";
const EARLY_ENRICHED_AT = "2026-09-10 20:20:00";
const LATE_ENRICHED_AT = "2026-09-10 22:30:00";

const QQQ = { t_pre: 500, t_post: 496, delta_pct: -0.8 };
const ZERO_SPY = { t_pre: 600, t_post: 600.001, delta_pct: 0 };
/** Older row (no captured_at): SPY rounds to 0.00%, QQQ moved. */
const LEGACY_ZERO_SPY = { t0_utc: T0, window_min: 120, source: "tws", spy: ZERO_SPY, qqq: QQQ };
/** Older row whose only leg is the zero SPY move. */
const LEGACY_ONLY_ZERO_SPY = { t0_utc: T0, window_min: 120, source: "tws", spy: ZERO_SPY };

type Leg = { t_pre?: number; t_post?: number; delta_pct?: number; state?: string };
type Reaction = { spy?: Leg; qqq?: Leg; state?: string } | null;

describe("chat tool query_release_reactions: legacy zero move and enriched_at", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedEvent(snapshot: unknown, enrichedAt: string): void {
    const date = addDays(todayET(), -3);
    db.prepare(
      `INSERT INTO calendar_events
         (source, source_key, event_type, event_date, week_of, title, symbol, actual_value,
          consensus_estimate, consensus_value, enriched_at, reaction_snapshot)
       VALUES ('finnhub', 'test:p1:1', 'earnings', ?, ?, 'ZZA earnings', 'ZZA', 'EPS 1.10',
               'EPS 1.00', 'EPS 1.00', ?, ?)`,
    ).run(date, date, enrichedAt, JSON.stringify(snapshot));
  }

  async function toolRow(): Promise<Record<string, unknown> & { reaction: Reaction }> {
    const result = (await executeTool(db, "query_release_reactions", {})) as {
      error?: string;
      data: { releases: Array<Record<string, unknown> & { reaction: Reaction }> };
    };
    expect(result.error).toBeUndefined();
    expect(result.data.releases).toHaveLength(1);
    return result.data.releases[0];
  }

  it("the query returns the row's enriched_at", () => {
    seedEvent(LEGACY_ZERO_SPY, EARLY_ENRICHED_AT);
    expect(getRecentReleaseReactions(db)[0].enriched_at).toBe(EARLY_ENRICHED_AT);
  });

  it("row enriched before the window ended: the zero leg is pending, the moved leg is kept", async () => {
    seedEvent(LEGACY_ZERO_SPY, EARLY_ENRICHED_AT);
    const { reaction } = await toolRow();
    expect(reaction?.spy).toEqual({ state: "pending" });
    expect(reaction?.qqq).toEqual(QQQ);
    expect(reaction?.state).toBeUndefined();
  });

  it("row enriched before the window ended, zero leg only: the whole reaction is pending, no figure", async () => {
    seedEvent(LEGACY_ONLY_ZERO_SPY, EARLY_ENRICHED_AT);
    const { reaction } = await toolRow();
    expect(reaction?.state).toBe("pending");
    expect(reaction?.spy).toEqual({ state: "pending" });
    expect(JSON.stringify(reaction)).not.toContain("delta_pct");
    expect(JSON.stringify(reaction)).not.toContain("t_post");
  });

  it("row enriched after the window ended: the zero leg is a real flat move and is kept as stored", async () => {
    seedEvent(LEGACY_ZERO_SPY, LATE_ENRICHED_AT);
    const { reaction } = await toolRow();
    expect(reaction?.spy).toEqual(ZERO_SPY);
    expect(reaction?.qqq).toEqual(QQQ);
  });

  it("the tool result does not grow an enriched_at field", async () => {
    seedEvent(LEGACY_ZERO_SPY, EARLY_ENRICHED_AT);
    const row = await toolRow();
    expect(Object.keys(row).sort()).toEqual(
      ["actual_value", "consensus_value", "event_date", "event_id", "event_type", "reaction", "symbol", "title"],
    );
  });

  it("the tool description tells the model what pending means", () => {
    const def = CHAT_TOOLS.find((t) => t.name === "query_release_reactions");
    expect(def?.description).toMatch(/state: "pending"/);
    expect(def?.description).toMatch(/no figure should be quoted/);
  });
});
