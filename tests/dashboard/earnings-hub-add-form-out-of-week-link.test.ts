import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { outOfWeekSaveLink, outOfWeekSaveNote } from "@/app/dashboard/today/EarningsHubAddForm";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// qa:today-earningshub-add-ticker--other-week-saves-silently-unreachable-regression-4
//
// Interim fix: the "Saved to the week of ..." notice gains a real link to the
// week-ahead view for that week. Nothing about the save itself changes.

const SHOWN_WEEK = "2026-09-07"; // a Monday; the Hub shows 09-07 through 09-13

describe("outOfWeekSaveLink", () => {
  it("has no link for a save inside the shown week", () => {
    expect(outOfWeekSaveLink("2026-09-07", SHOWN_WEEK)).toBeNull();
    expect(outOfWeekSaveLink("2026-09-09", SHOWN_WEEK)).toBeNull();
    expect(outOfWeekSaveLink("2026-09-13", SHOWN_WEEK)).toBeNull(); // the shown week's Sunday
  });

  it("links to the Monday of the saved date's week", () => {
    expect(outOfWeekSaveLink("2026-09-16", SHOWN_WEEK)).toEqual({
      href: "/dashboard/today?view=week-ahead&weekOf=2026-09-14",
      label: "View week of 2026-09-14",
    });
  });

  it("files a Sunday under the Monday six days before it, not the day after", () => {
    expect(outOfWeekSaveLink("2026-09-20", SHOWN_WEEK)?.href).toBe(
      "/dashboard/today?view=week-ahead&weekOf=2026-09-14",
    );
  });

  it("handles a date in a later year, including a week that straddles the new year", () => {
    expect(outOfWeekSaveLink("2027-03-10", SHOWN_WEEK)?.href).toBe(
      "/dashboard/today?view=week-ahead&weekOf=2027-03-08",
    );
    // Sunday 2027-01-03 belongs to the week that began Monday 2026-12-28.
    expect(outOfWeekSaveLink("2027-01-03", SHOWN_WEEK)?.href).toBe(
      "/dashboard/today?view=week-ahead&weekOf=2026-12-28",
    );
  });

  it("links to an earlier week too", () => {
    expect(outOfWeekSaveLink("2026-09-04", SHOWN_WEEK)?.href).toBe(
      "/dashboard/today?view=week-ahead&weekOf=2026-08-31",
    );
  });

  it("names the same week the notice does", () => {
    for (const date of ["2026-09-16", "2026-09-20", "2027-01-03", "2026-09-04"]) {
      const monday = outOfWeekSaveLink(date, SHOWN_WEEK)!.href.split("weekOf=")[1];
      expect(outOfWeekSaveNote(date, SHOWN_WEEK)).toContain(`week of ${monday}`);
    }
  });
});

describe("the link is wired beside the notice and uses the app's own week URL", () => {
  const form = readFileSync("app/dashboard/today/EarningsHubAddForm.tsx", "utf8");
  const weekAhead = readFileSync("app/dashboard/today/WeekAheadView.tsx", "utf8");

  it("is set on the successful-save path and rendered as a real link after the notice", () => {
    expect(form).toContain("setOutOfWeekLink(outOfWeekSaveLink(date, weekOf))");
    const note = anchorIndex(form, "{outOfWeekNote}</span>");
    const link = anchorIndex(form, "<Link", note);
    const tag = form.slice(link, anchorIndex(form, "</Link>", link));
    expect(tag).toContain("href={outOfWeekLink.href}");
    // Always visible and tappable: no hover-only or hidden styling.
    expect(tag).not.toMatch(/opacity-0|group-hover|\bhidden\b/);
    expect(tag).toContain("pointer-coarse:after:-inset-y-3");
  });

  it("matches the URL shape WeekAheadView uses for another week", () => {
    expect(weekAhead).toContain("/dashboard/today?view=week-ahead&weekOf=${monday}");
    expect(form).toContain("/dashboard/today?view=week-ahead&weekOf=${monday}");
  });
});
