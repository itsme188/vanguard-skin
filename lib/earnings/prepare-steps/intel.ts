/**
 * Live print v2 slice A, spec §4.1 step 3 — the intel prepare step. Runs the
 * same intel orchestrator (`ensureIntelForEvents`, D4) an armed name would
 * otherwise only get from cockpit polling on a HELD name, so an armed-but-
 * not-yet-held name has implied-move data ready by print time.
 *
 * `forceFresh: false` — this step rides the orchestrator's own 30-min TTL
 * (INTEL_TTL_MS) rather than forcing a compute on every prepare pass.
 */
import type Database from "better-sqlite3";
import { ensureIntelForEvents, type IntelEvent } from "@/lib/earnings/intel";
import { stableHash, type PrepareStepDefinition } from "../prepare-armed-event";

export function makeIntelStep(deps: { ensure?: typeof ensureIntelForEvents } = {}): PrepareStepDefinition {
  const ensure = deps.ensure ?? ensureIntelForEvents;
  const read = (db: Database.Database, eventId: number) =>
    db.prepare(`SELECT id, symbol, event_date, event_time, release_time FROM calendar_events WHERE id = ?`).get(eventId) as (IntelEvent & { release_time: string | null }) | undefined;
  return {
    // Spec §4.1: intel = hash(symbol, eventDate, releaseTime) [C-16c]
    fingerprint(db, eventId) { const e = read(db, eventId); return stableHash(["intel", 1, e?.symbol ?? null, e?.event_date ?? null, e?.release_time ?? null]); },
    async run(db, eventId) {
      const e = read(db, eventId);
      if (!e || !e.symbol) return { status: "failed", error: `event ${eventId} has no symbol` };
      try { await ensure(db, [{ id: e.id, symbol: e.symbol, event_date: e.event_date, event_time: e.event_time }], { forceFresh: false }); }
      catch (err) { return { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }; }
      return { status: "done" };
    },
  };
}
export const intelStep = makeIntelStep();
