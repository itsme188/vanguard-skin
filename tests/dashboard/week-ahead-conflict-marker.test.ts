import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WeekAheadView } from "@/app/dashboard/today/WeekAheadView";
import type { CalendarEvent } from "@/lib/types";

// QA finding today-week-ahead--date-conflicted-earnings-row-rendered-as-settled-no-marker:
// an earnings card for a calendar_events row with date_status === 'conflict'
// (migration 057) was identical in shape to every other card — no chip, no
// mention of the competing vendor date. This is a genuine renderToStaticMarkup
// pass of the real WeekAheadView (it's a pure props-driven server component,
// no DB access, so a full render is possible — no source-pin needed here).
// Every symbol is synthetic (XMPL convention, matching tests/dashboard/
// earnings-hub-live.test.ts's R-F8 rule).

const WEEK_OF = "2026-09-28"; // Monday

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    source: "finnhub",
    event_type: "earnings",
    event_date: WEEK_OF,
    event_time: null,
    title: "XMPL1 Q3 Earnings",
    description: null,
    security_id: null,
    symbol: "XMPL1",
    ib_con_id: null,
    expected_impact: null,
    consensus_estimate: null,
    previous_value: null,
    raw_json: null,
    source_key: "test:xmpl1:earnings:2026-09-28",
    week_of: WEEK_OF,
    fetched_at: "2026-09-20 00:00:00",
    created_at: "2026-09-20 00:00:00",
    release_time: "16:00",
    actual_value: null,
    consensus_value: null,
    reaction_snapshot: null,
    enriched_at: null,
    date_status: null,
    date_conflict_with: null,
    superseded: 0,
    manual_actuals_at: null,
    ...overrides,
  };
}

describe("WeekAheadView — date-conflicted earnings row", () => {
  it("renders the conflict marker naming the competing date for a 'conflict' row", () => {
    const html = renderToStaticMarkup(
      createElement(WeekAheadView, {
        weekOf: WEEK_OF,
        events: [
          makeEvent({
            date_status: "conflict",
            date_conflict_with: "finnhub:2026-10-05",
          }),
        ],
      }),
    );
    expect(html).toContain("XMPL1");
    expect(html).toContain("⚠");
    expect(html).toContain("Finnhub");
    expect(html).toContain("Oct 5");
  });

  it("renders no conflict marker for an ordinary confirmed row", () => {
    const html = renderToStaticMarkup(
      createElement(WeekAheadView, {
        weekOf: WEEK_OF,
        events: [makeEvent({ date_status: "confirmed" })],
      }),
    );
    expect(html).toContain("XMPL1");
    expect(html).not.toContain("⚠");
  });

  it("renders no conflict marker when date_status is null (unreconciled row)", () => {
    const html = renderToStaticMarkup(
      createElement(WeekAheadView, {
        weekOf: WEEK_OF,
        events: [makeEvent({ date_status: null })],
      }),
    );
    expect(html).not.toContain("⚠");
  });
});
