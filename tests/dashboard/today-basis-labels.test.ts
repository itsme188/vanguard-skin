import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ibkrSnapshotHeading, olderVanguardBasisNote } from "@/app/dashboard/today/basis-labels";
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
  it("the Portfolio strip appends the older-basis note beside its as-of date", () => {
    const strip = page.slice(anchorIndex(page, "as of ${fmtShortDate(portfolio.latestDate)}"));
    expect(strip.slice(0, 200)).toContain("{vanguardBasisNote && ` · ${vanguardBasisNote}`}");
    expect(page).toContain("olderVanguardBasisNote(vanguardSnapshotDate, portfolio.latestDate, todayET())");
  });
});
