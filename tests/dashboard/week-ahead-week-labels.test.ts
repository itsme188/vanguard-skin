import { describe, it, expect } from "vitest";
import { weekAheadHeaderState } from "@/app/dashboard/today/WeekAheadView";

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
