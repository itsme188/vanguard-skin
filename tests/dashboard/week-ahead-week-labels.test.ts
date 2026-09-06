import { describe, it, expect } from "vitest";
import { weekAheadHeaderState, weekAheadEmptyStateCopy } from "@/app/dashboard/today/WeekAheadView";
import { earningsHubEmptyStateCopy } from "@/app/dashboard/today/EarningsHub";

// QA finding today-week-ahead--weekend-current-week-labelled-past-week-this-week-jumps-forward-regression-1:
// getCurrentMonday() deliberately returns NEXT Monday on Sat/Sun (the
// business week is over — that's the intended default landing). But the
// header micro-label and the "This week" control compared weekOf straight
// against getCurrentMonday(), so on a weekend the week containing TODAY got
// labelled "Past week" and "This week" pointed at next week instead of the
// week the user is actually in. weekAheadHeaderState fixes this by checking
// mondayOf(todayIso) — the week that CONTAINS today — before falling back
// to past/upcoming.
describe("weekAheadHeaderState", () => {
  describe("Saturday 2026-09-05 (currentMonday rolled forward to 2026-09-07)", () => {
    const todayIso = "2026-09-05";
    const currentMonday = "2026-09-07";

    it("labels the week containing today as 'This week', not 'Past week'", () => {
      const s = weekAheadHeaderState("2026-08-31", todayIso, currentMonday);
      expect(s.microLabel).toBe("This week");
      expect(s.showThisWeekLink).toBe(false);
      expect(s.thisWeekMonday).toBe("2026-08-31");
    });

    it("labels the default-landing week (currentMonday) 'Week ahead' and offers the This week link back", () => {
      const s = weekAheadHeaderState("2026-09-07", todayIso, currentMonday);
      expect(s.microLabel).toBe("Week ahead");
      expect(s.showThisWeekLink).toBe(true);
      expect(s.thisWeekMonday).toBe("2026-08-31");
    });

    it("labels a week that ended before today 'Past week'", () => {
      const s = weekAheadHeaderState("2026-08-24", todayIso, currentMonday);
      expect(s.microLabel).toBe("Past week");
    });

    it("labels a week further out 'Upcoming week'", () => {
      const s = weekAheadHeaderState("2026-09-14", todayIso, currentMonday);
      expect(s.microLabel).toBe("Upcoming week");
    });
  });

  describe("Sunday 2026-09-06 (mondayOf rolls Sunday back to the prior Monday)", () => {
    const todayIso = "2026-09-06";
    const currentMonday = "2026-09-07";

    it("still labels the week containing today as 'This week'", () => {
      const s = weekAheadHeaderState("2026-08-31", todayIso, currentMonday);
      expect(s.microLabel).toBe("This week");
    });
  });

  describe("Wednesday 2026-09-02 (currentMonday is this week, business as usual)", () => {
    const todayIso = "2026-09-02";
    const currentMonday = "2026-08-31";

    it("labels the current week 'Week ahead' (default landing keeps its name) with no This week link", () => {
      const s = weekAheadHeaderState("2026-08-31", todayIso, currentMonday);
      expect(s.microLabel).toBe("Week ahead");
      expect(s.showThisWeekLink).toBe(false);
    });

    it("labels last week 'Past week'", () => {
      const s = weekAheadHeaderState("2026-08-24", todayIso, currentMonday);
      expect(s.microLabel).toBe("Past week");
    });

    it("labels next week 'Upcoming week' and points the This week link at the current week", () => {
      const s = weekAheadHeaderState("2026-09-07", todayIso, currentMonday);
      expect(s.microLabel).toBe("Upcoming week");
      expect(s.showThisWeekLink).toBe(true);
      expect(s.thisWeekMonday).toBe("2026-08-31");
    });
  });
});

// Landing-review follow-up #2 (commit 256833e5): EarningsHub's own weekend
// copy sibling. getCurrentMonday() rolls Sat/Sun FORWARD to next Monday (the
// hub looks ahead by design), so "No earnings events this week." on a
// weekend actually describes NEXT week. earningsHubEmptyStateCopy names the
// week explicitly whenever weekOf isn't the week containing today, and keeps
// the plain "this week" phrasing when it is — reusing mondayOf(todayIso), the
// same "week containing today" check weekAheadHeaderState uses above.
describe("earningsHubEmptyStateCopy", () => {
  it("keeps 'this week' phrasing on a weekday, when weekOf is the week containing today", () => {
    expect(earningsHubEmptyStateCopy("2026-08-31", "2026-09-02")).toBe(
      "No earnings events this week.",
    );
  });

  it("names the week explicitly on a weekend, when weekOf (next Monday) is NOT the week containing today", () => {
    expect(earningsHubEmptyStateCopy("2026-09-07", "2026-09-05")).toBe(
      "No earnings events for the week of Sep 7 – Sep 13, 2026.",
    );
  });

  it("keeps 'this week' phrasing on a weekend when weekOf IS the week containing today", () => {
    expect(earningsHubEmptyStateCopy("2026-08-31", "2026-09-05")).toBe(
      "No earnings events this week.",
    );
  });

  it("names the week explicitly for an arbitrary week further out", () => {
    expect(earningsHubEmptyStateCopy("2026-09-14", "2026-09-05")).toBe(
      "No earnings events for the week of Sep 14 – Sep 20, 2026.",
    );
  });
});

// Landing-review follow-up #3 (commit 256833e5): the WeekAheadView empty-state
// copy used to be driven by an independently-computed `isCurrentWeek = weekOf
// === currentMonday` while the header's microLabel came from
// weekAheadHeaderState — two separate comparisons that could (and did, on a
// weekend) disagree: a header reading "This week" paired with the
// past-tense "no events recorded... history since spring 2026" body copy.
// weekAheadEmptyStateCopy now derives its present/past decision from the
// SAME weekAheadHeaderState call the header renders from, so the two can
// never diverge — verified here by checking both together for every
// scenario already covered above.
describe("weekAheadEmptyStateCopy agrees with weekAheadHeaderState (header/body never disagree)", () => {
  const PRESENT_COPY =
    "No events scheduled this week. Calendar sync may not have run yet — check Charts › Calendar (or trigger via the Sunday briefing).";
  const pastOrUpcomingCopy = (weekOf: string) =>
    `No events recorded for the week of ${weekOf}. Calendar sync covers roughly four weeks ahead and history since spring 2026.`;

  describe("Saturday 2026-09-05 (currentMonday rolled forward to 2026-09-07)", () => {
    const todayIso = "2026-09-05";
    const currentMonday = "2026-09-07";

    it("uses present-tense copy for the week containing today ('This week' in the header)", () => {
      expect(weekAheadHeaderState("2026-08-31", todayIso, currentMonday).microLabel).toBe(
        "This week",
      );
      expect(weekAheadEmptyStateCopy("2026-08-31", todayIso, currentMonday)).toBe(PRESENT_COPY);
    });

    it("uses present-tense copy for the default-landing week too ('Week ahead' in the header)", () => {
      expect(weekAheadHeaderState("2026-09-07", todayIso, currentMonday).microLabel).toBe(
        "Week ahead",
      );
      expect(weekAheadEmptyStateCopy("2026-09-07", todayIso, currentMonday)).toBe(PRESENT_COPY);
    });

    it("uses the historical copy for a week the header calls 'Past week'", () => {
      expect(weekAheadHeaderState("2026-08-24", todayIso, currentMonday).microLabel).toBe(
        "Past week",
      );
      expect(weekAheadEmptyStateCopy("2026-08-24", todayIso, currentMonday)).toBe(
        pastOrUpcomingCopy("2026-08-24"),
      );
    });

    it("uses the historical copy for a week the header calls 'Upcoming week'", () => {
      expect(weekAheadHeaderState("2026-09-14", todayIso, currentMonday).microLabel).toBe(
        "Upcoming week",
      );
      expect(weekAheadEmptyStateCopy("2026-09-14", todayIso, currentMonday)).toBe(
        pastOrUpcomingCopy("2026-09-14"),
      );
    });
  });

  describe("Wednesday 2026-09-02 (currentMonday is this week, business as usual)", () => {
    const todayIso = "2026-09-02";
    const currentMonday = "2026-08-31";

    it("uses present-tense copy for the current week (labelled 'Week ahead')", () => {
      expect(weekAheadHeaderState("2026-08-31", todayIso, currentMonday).microLabel).toBe(
        "Week ahead",
      );
      expect(weekAheadEmptyStateCopy("2026-08-31", todayIso, currentMonday)).toBe(PRESENT_COPY);
    });

    it("uses the historical copy for last week ('Past week')", () => {
      expect(weekAheadHeaderState("2026-08-24", todayIso, currentMonday).microLabel).toBe(
        "Past week",
      );
      expect(weekAheadEmptyStateCopy("2026-08-24", todayIso, currentMonday)).toBe(
        pastOrUpcomingCopy("2026-08-24"),
      );
    });
  });
});
