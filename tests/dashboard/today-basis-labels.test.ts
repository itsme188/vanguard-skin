import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  ibkrSessionWord,
  ibkrSnapshotHeading,
  olderVanguardBasisNote,
  portfolioBaselineLabel,
} from "@/app/dashboard/today/basis-labels";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// qa:today-ibkr-snapshot--stale-session-move-labelled-today-beside-2d-ago-chip
// qa:today-vs-chat--portfolio-total-blends-valuation-dates-residual
//
// Interim honesty labels: they change words only. The move, the total and
// every stored row are untouched (the real fix is held for the owner).

const TODAY = "2026-09-22";

describe("ibkrSnapshotHeading", () => {
  it("says 'today' only when the move's session is today's Eastern date", () => {
    expect(ibkrSnapshotHeading("2026-09-22", TODAY)).toBe("IBKR today");
  });
  it("names the session when the move is from an earlier day", () => {
    expect(ibkrSnapshotHeading("2026-09-17", TODAY)).toBe("IBKR Sep 17 session");
    expect(ibkrSnapshotHeading("2026-09-21", TODAY)).toBe("IBKR Sep 21 session");
  });
  it("adds the year when the session is in another year", () => {
    expect(ibkrSnapshotHeading("2025-12-31", "2026-01-02")).toBe("IBKR Dec 31, 2025 session");
  });
  it("never says 'today' for a missing or unreadable session date", () => {
    for (const bad of [null, undefined, "", "garbage", "2026-13-45"]) {
      expect(ibkrSnapshotHeading(bad, TODAY)).toBe("IBKR last session");
    }
  });
  it("reads the date part of a stored datetime", () => {
    expect(ibkrSnapshotHeading("2026-09-22T20:00:00.000Z", TODAY)).toBe("IBKR today");
  });
});

describe("ibkrSessionWord", () => {
  it("says 'today' only when the move's session is today's Eastern date", () => {
    expect(ibkrSessionWord("2026-09-22", TODAY)).toBe("today");
    expect(ibkrSessionWord("2026-09-22T20:00:00.000Z", TODAY)).toBe("today");
  });
  it("says 'that session' for an earlier, missing or unreadable session date", () => {
    for (const other of ["2026-09-21", "2025-12-31", null, undefined, "", "garbage"]) {
      expect(ibkrSessionWord(other, TODAY)).toBe("that session");
    }
  });
});

describe("olderVanguardBasisNote", () => {
  it("is silent when the Vanguard holdings share the headline date", () => {
    expect(olderVanguardBasisNote("2026-09-20", "2026-09-20", TODAY)).toBeNull();
  });
  it("is silent when the Vanguard holdings are newer than the headline date", () => {
    expect(olderVanguardBasisNote("2026-09-21", "2026-09-20", TODAY)).toBeNull();
  });
  it("names the older Vanguard date", () => {
    expect(olderVanguardBasisNote("2026-09-17", "2026-09-20", TODAY)).toBe(
      "Vanguard holdings through Sep 17",
    );
    expect(olderVanguardBasisNote("2026-09-17", "2026-09-20T00:00:00", TODAY)).toBe(
      "Vanguard holdings through Sep 17",
    );
  });
  it("is silent when either date is unknown", () => {
    expect(olderVanguardBasisNote(null, "2026-09-20", TODAY)).toBeNull();
    expect(olderVanguardBasisNote("2026-09-17", null, TODAY)).toBeNull();
    expect(olderVanguardBasisNote("garbage", "2026-09-20", TODAY)).toBeNull();
  });
});

describe("Today page wiring (source pins)", () => {
  const page = readFileSync("app/dashboard/today/page.tsx", "utf8");

  it("the IBKR heading is the decided label, not a fixed 'IBKR today'", () => {
    const line = page.slice(anchorIndex(page, "IBKR today — one line"));
    expect(line).toContain("{ibkrHeading}</h2>");
    expect(line).not.toMatch(/<h2[^>]*>IBKR today<\/h2>/);
    expect(page).toMatch(/ibkrSnapshotHeading\(\s*movePair\?\.latest \?\? null,\s*todayET\(\)\s*\)/);
  });
  it("the opened / added notes take their 'when' word from the same session date as the heading", () => {
    expect(page).toMatch(/ibkrSessionWord\(\s*movePair\?\.latest \?\? null,\s*todayET\(\)\s*\)/);
    const line = page.slice(anchorIndex(page, "IBKR today — one line"));
    expect(line).toContain("opened {sessionWord}");
    expect(line).toContain("added to {sessionWord}");
    // Never a fixed "opened today": the session may be an earlier one.
    expect(line).not.toMatch(/opened today/);
  });
  it("the Portfolio strip appends the older-basis note beside its as-of date", () => {
    const strip = page.slice(anchorIndex(page, "as of ${fmtShortDate(portfolio.latestDate)}"));
    expect(strip.slice(0, 200)).toContain("{vanguardBasisNote && ` · ${vanguardBasisNote}`}");
    expect(page).toContain("olderVanguardBasisNote(vanguardSnapshotDate, portfolio.latestDate, todayET())");
  });
});

describe("portfolioBaselineLabel", () => {
  const today = "2025-09-17";
  it("names the one statement date", () => {
    expect(portfolioBaselineLabel("2025-08-31", "2025-08-31", today)).toBe("vs Aug 31 statement");
  });
  it("names the range when the baselines differ", () => {
    expect(portfolioBaselineLabel("2025-08-29", "2025-08-31", today)).toBe("vs statements of Aug 29 to Aug 31");
  });
  it("falls back to the old wording with no baseline", () => {
    expect(portfolioBaselineLabel(null, null, today)).toBe("vs prior month");
  });
  it("adds the year when it differs from today's", () => {
    expect(portfolioBaselineLabel("2024-12-31", "2024-12-31", today)).toBe("vs Dec 31, 2024 statement");
  });
  it("does not shift a day for a month-end", () => {
    expect(portfolioBaselineLabel("2025-01-01", "2025-01-01", today)).toBe("vs Jan 1 statement");
  });
});
