import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

/**
 * Source pin: tests/mutations/calendar-macro-consensus.test.ts calls the
 * mutation directly with a keep list, but nothing proved that
 * `syncCalendarForWeek` actually passes one. Without it, a re-listed macro row
 * is deleted and re-minted every refresh (new id, stored consensus lost).
 */
describe("syncCalendarForWeek macro delete passes the keep list", () => {
  const src = readFileSync("lib/calendar/sync.ts", "utf8");

  it("passes the freshly built macro source_keys as the fourth argument", () => {
    // First call whose arguments name claude_macro (an earlier "claude_macro"
    // belongs to writeAndCollectRemoved, so anchor on the delete call itself).
    const callStart = anchorIndex(
      src,
      "deleteUnenrichedEventsForWeek(\n",
      0,
      "multi-line macro delete call",
    );
    const callEnd = anchorIndex(src, ");", callStart, "end of delete call");
    const call = src.slice(callStart, callEnd + 2).replace(/\s+/g, " ");
    expect(call).toBe(
      'deleteUnenrichedEventsForWeek( db, weekOf, "claude_macro", macroInputs.map((e) => e.source_key), );',
    );
  });

  it("deletes before it upserts, inside the same write callback", () => {
    const del = anchorIndex(src, 'macroInputs.map((e) => e.source_key)', 0, "keep list");
    const ups = anchorIndex(src, "upsertCalendarEvents(db, macroInputs)", del, "macro upsert");
    expect(ups).toBeGreaterThan(del);
  });
});
