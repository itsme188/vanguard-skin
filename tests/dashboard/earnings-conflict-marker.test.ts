import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EarningsConflictMarker } from "@/app/dashboard/components/calendar/EarningsConflictMarker";

// QA findings:
//   security-detail-upcoming-events--date-conflicted-earnings-row-rendered-as-settled-no-marker
//   today-week-ahead--date-conflicted-earnings-row-rendered-as-settled-no-marker
//
// A calendar_events row with date_status === 'conflict' (migration 057)
// rendered identically to a settled row on the security hub's Upcoming
// Events list and the Today week-ahead view — no chip, no mention of the
// competing vendor date, which can be EARLIER than the date shown. This
// repo has no DOM test harness (no jsdom/@testing-library/react) — a real
// render pass via renderToStaticMarkup is the strongest check available
// (same idiom as tests/dashboard/enrichment-chips-placeholder.test.ts),
// since EarningsConflictMarker is a pure server component with no hooks.
describe("EarningsConflictMarker", () => {
  it("renders nothing for a non-conflict status", () => {
    for (const status of ["confirmed", "single", "user_confirmed", null, undefined] as const) {
      const html = renderToStaticMarkup(
        createElement(EarningsConflictMarker, {
          dateStatus: status,
          dateConflictWith: null,
        }),
      );
      expect(html).toBe("");
    }
  });

  it("names the competing vendor and short date for a conflict row", () => {
    const html = renderToStaticMarkup(
      createElement(EarningsConflictMarker, {
        dateStatus: "conflict",
        dateConflictWith: "finnhub:2026-09-28",
      }),
    );
    expect(html).toContain("Finnhub");
    expect(html).toContain("Sep 28");
    expect(html).toContain("⚠");
  });

  it("labels a nasdaq conflict source too (not hardcoded to finnhub)", () => {
    const html = renderToStaticMarkup(
      createElement(EarningsConflictMarker, {
        dateStatus: "conflict",
        dateConflictWith: "nasdaq:2026-10-02",
      }),
    );
    expect(html).toContain("Nasdaq");
    expect(html).toContain("Oct 2");
  });

  it("carries a title attribute with the full sentence (accessibility)", () => {
    const html = renderToStaticMarkup(
      createElement(EarningsConflictMarker, {
        dateStatus: "conflict",
        dateConflictWith: "finnhub:2026-09-28",
      }),
    );
    const match = /title="([^"]*)"/.exec(html);
    expect(match).not.toBeNull();
    const title = match![1];
    expect(title).toContain("Sources disagree");
    expect(title).toContain("Finnhub");
    expect(title).toContain("Sep 28");
  });

  it("degrades gracefully (still warns) when date_conflict_with is missing or malformed", () => {
    const html = renderToStaticMarkup(
      createElement(EarningsConflictMarker, {
        dateStatus: "conflict",
        dateConflictWith: null,
      }),
    );
    expect(html).not.toBe("");
    expect(html).toContain("⚠");
  });

  it("uses the contrast-vetted gold chip tokens, not a bare unstyled span", () => {
    const html = renderToStaticMarkup(
      createElement(EarningsConflictMarker, {
        dateStatus: "conflict",
        dateConflictWith: "finnhub:2026-09-28",
      }),
    );
    // Chip's "gold" tone (app/dashboard/components/Chip.tsx) — documented
    // 4.5:1 small-text contrast pairing, the same semantic warning color
    // EarningsDateChip's "⚠ confirm" chip uses on the Earnings Hub.
    expect(html).toContain("text-gold-ink");
    expect(html).toContain("whitespace-nowrap");
  });
});
