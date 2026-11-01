import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { vi } from "vitest";
import {
  WeekAheadView,
  WITHHELD_ACTUAL_LABEL,
  showsWithheldActual,
} from "@/app/dashboard/today/WeekAheadView";
import type { CalendarEvent } from "@/lib/types";
import { anchorIndex } from "@/tests/helpers/source-anchor";

vi.mock("@/app/dashboard/today/EarningsDeleteButton", () => ({
  EarningsDeleteButton: () => null,
}));

const TODAY = "2026-09-01";
const PAST = "2026-08-25";

const ev = (o: Partial<CalendarEvent> = {}) =>
  ({
    id: 1,
    event_type: "earnings",
    event_date: PAST,
    source: "finnhub",
    source_key: "finnhub:AAA:2026-08-25",
    symbol: "AAA",
    title: "AAA earnings",
    week_of: "2026-08-24",
    consensus_estimate: "EPS 1.00",
    consensus_value: null,
    actual_value: "EPS 9.00",
    manual_actuals_at: null,
    reaction_snapshot: null,
    enriched_at: null,
    superseded: 0,
    ...o,
  }) as unknown as CalendarEvent;

describe("withheld stored actual says so", () => {
  it("true for a past earnings row whose stored actual the gate rejects", () => {
    expect(showsWithheldActual(ev(), TODAY)).toBe(true);
  });
  it("false for a plausible, empty, today, future, non-earnings or hand-confirmed actual", () => {
    expect(showsWithheldActual(ev({ actual_value: "EPS 1.05" }), TODAY)).toBe(false);
    expect(showsWithheldActual(ev({ actual_value: null }), TODAY)).toBe(false);
    expect(showsWithheldActual(ev({ actual_value: "  " }), TODAY)).toBe(false);
    expect(showsWithheldActual(ev({ event_date: TODAY }), TODAY)).toBe(false);
    expect(showsWithheldActual(ev({ event_date: "2026-10-09" }), TODAY)).toBe(false);
    expect(showsWithheldActual(ev({ event_type: "economic_release" as CalendarEvent["event_type"] }), TODAY)).toBe(false);
    expect(showsWithheldActual(ev({ manual_actuals_at: "2026-08-26 10:00:00" }), TODAY)).toBe(false);
  });
  it("source pin: label rendered behind the predicate, after refusedNote", () => {
    const src = readFileSync("app/dashboard/today/WeekAheadView.tsx", "utf8");
    const refused = anchorIndex(src, "{refusedNote && (");
    const gate = anchorIndex(src, "!refusedNote && showsWithheldActual(event, todayIso)", refused);
    anchorIndex(src, "{WITHHELD_ACTUAL_LABEL}", gate);
    expect(WITHHELD_ACTUAL_LABEL).toMatch(/withheld/);
  });
  it("the card prints it once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T15:00:00Z"));
    try {
      const html = renderToStaticMarkup(
        createElement(WeekAheadView, { events: [ev()], weekOf: "2026-08-24" }),
      );
      expect(html.split(WITHHELD_ACTUAL_LABEL).length - 1).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
