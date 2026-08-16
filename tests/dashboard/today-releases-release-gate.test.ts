import { describe, it, expect } from "vitest";
import {
  upcomingRowReleased,
  isReleaseEnriched,
} from "@/app/dashboard/components/TodayReleases";
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot-core";

// ── upcomingRowReleased (codex advisory #48) ──────────────────────────────
// mode="upcoming" renders future events; a date correction can strand a
// prior print's actual_value/enriched_at on a FUTURE row (same failure mode
// WeekAheadView's releasedFigureGates guards). Mirrors that gate — do not
// fork this check.
describe("upcomingRowReleased", () => {
  const TODAY = "2026-08-16";

  it("blocks a future event_date in upcoming mode", () => {
    expect(upcomingRowReleased({ event_date: "2026-08-20" }, "upcoming", TODAY)).toBe(false);
  });

  it("allows today's event_date in upcoming mode", () => {
    expect(upcomingRowReleased({ event_date: TODAY }, "upcoming", TODAY)).toBe(true);
  });

  it("allows a past event_date in upcoming mode", () => {
    expect(upcomingRowReleased({ event_date: "2026-08-10" }, "upcoming", TODAY)).toBe(true);
  });

  it("fails closed on an empty event_date in upcoming mode", () => {
    // event_date is typed `string` on CalendarEvent, but the component
    // already defends against a falsy value here (matches WeekAheadView's
    // same `!!event.event_date` guard) — exercise that branch directly.
    expect(upcomingRowReleased({ event_date: "" }, "upcoming", TODAY)).toBe(false);
  });

  it("is a no-op in today mode regardless of date (page.tsx only ever selects event_date === today)", () => {
    expect(upcomingRowReleased({ event_date: "2026-08-20" }, "today", TODAY)).toBe(true);
    expect(upcomingRowReleased({ event_date: "" }, "today", TODAY)).toBe(true);
  });
});

// ── isReleaseEnriched (the full gate the component renders from) ─────────
describe("isReleaseEnriched", () => {
  const TODAY = "2026-08-16";
  const snap: ReactionSnapshot = {
    t0_utc: "2026-08-16T14:55:00.000Z",
    window_min: 120,
    source: "tws",
    spy: { t_pre: 741.4, t_post: 742.23, delta_pct: 0.11 },
    qqq: { t_pre: 683.53, t_post: 687.28, delta_pct: 0.55 },
    tlt: { t_pre: 82.83, t_post: 82.72, delta_pct: -0.13 },
  };

  it("does NOT render enriched for an upcoming-mode event dated in the future, even with actual_value + enriched_at set (the codex #48 repro)", () => {
    const enriched = isReleaseEnriched(
      {
        event_date: "2026-08-20",
        enriched_at: "2026-08-09 21:10:00",
        actual_value: "EPS 1.10 · Rev 5000000",
      },
      null,
      "upcoming",
      TODAY,
    );
    expect(enriched).toBe(false);
  });

  it("does NOT render enriched for an upcoming-mode future event even when it also carries a reaction snapshot", () => {
    const enriched = isReleaseEnriched(
      {
        event_date: "2026-08-20",
        enriched_at: "2026-08-09 21:10:00",
        actual_value: null,
      },
      snap,
      "upcoming",
      TODAY,
    );
    expect(enriched).toBe(false);
  });

  it("keeps current behavior: upcoming-mode event dated today with actual_value + enriched_at renders enriched", () => {
    const enriched = isReleaseEnriched(
      {
        event_date: TODAY,
        enriched_at: "2026-08-16 21:10:00",
        actual_value: "EPS 1.10 · Rev 5000000",
      },
      null,
      "upcoming",
      TODAY,
    );
    expect(enriched).toBe(true);
  });

  it("keeps current behavior: upcoming-mode event dated in the past with actual_value + enriched_at renders enriched", () => {
    const enriched = isReleaseEnriched(
      {
        event_date: "2026-08-10",
        enriched_at: "2026-08-10 21:10:00",
        actual_value: "EPS 1.10 · Rev 5000000",
      },
      null,
      "upcoming",
      TODAY,
    );
    expect(enriched).toBe(true);
  });

  it("keeps current behavior in today mode: enriched_at + actual_value renders enriched regardless of the (irrelevant) release gate", () => {
    const enriched = isReleaseEnriched(
      {
        event_date: TODAY,
        enriched_at: "2026-08-16 21:10:00",
        actual_value: "3.2%",
      },
      null,
      "today",
      TODAY,
    );
    expect(enriched).toBe(true);
  });

  it("still falls through to Est/Pending when enriched_at is set but there is nothing to show (no actual, no snapshot)", () => {
    const enriched = isReleaseEnriched(
      { event_date: TODAY, enriched_at: "2026-08-16 21:10:00", actual_value: null },
      null,
      "today",
      TODAY,
    );
    expect(enriched).toBe(false);
  });
});
