import { describe, it, expect } from "vitest";
import { chartFooterStalenessText } from "@/app/dashboard/components/SecurityChart";

// deep-QA: charts-watchlist-panels--no-bars-through-date-staleness-footer
// Compact (Watchlist grid) SecurityChart panels used to render NO staleness
// text at all, so a panel whose cached data ends months ago was
// indistinguishable from a current one. The compact footer now renders this
// same string — verify the shared formatter directly (no component-test
// harness exists in this repo; see CLAUDE.md testing conventions).
describe("chartFooterStalenessText", () => {
  it("renders 'N bars · through YYYY-MM-DD' when bars and a last date are present", () => {
    expect(
      chartFooterStalenessText({ barCount: 128, lastDate: "2026-04-28" }),
    ).toBe("128 bars · through 2026-04-28");
  });

  it("renders 'N bars' with no date suffix when lastDate is null", () => {
    expect(chartFooterStalenessText({ barCount: 128, lastDate: null })).toBe(
      "128 bars",
    );
  });

  it("renders 'No data' when barCount is 0, regardless of lastDate", () => {
    expect(chartFooterStalenessText({ barCount: 0, lastDate: null })).toBe(
      "No data",
    );
  });

  it("renders 'No data · through YYYY-MM-DD' when barCount is 0 but a stale lastDate exists", () => {
    // Mirrors chartEmptyStateMessage's "cached history ends <date>" case —
    // barCount here is scoped to the selected window (can be 0 even with a
    // non-null lastDate from a wider cached range).
    expect(
      chartFooterStalenessText({ barCount: 0, lastDate: "2026-01-15" }),
    ).toBe("No data · through 2026-01-15");
  });
});
