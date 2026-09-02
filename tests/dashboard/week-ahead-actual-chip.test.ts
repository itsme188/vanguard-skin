import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { actualChipClass } from "@/app/dashboard/today/WeekAheadView";
import type { CalendarEvent } from "@/lib/types";

type ChipEvent = Pick<CalendarEvent, "event_type" | "consensus_estimate" | "actual_value"> &
  Partial<Pick<CalendarEvent, "consensus_value" | "manual_actuals_at">>;

function earningsEvent(consensus: string | null, actual: string | null): ChipEvent {
  return {
    event_type: "earnings",
    consensus_estimate: consensus,
    actual_value: actual,
  };
}

// QA finding today-week-ahead--actual-chip-always-green-miss-reads-as-beat-regression-3:
// the "actual …" chip was hard-coded to the up/green tone, so an earnings
// miss painted as a beat. actualChipClass must color the chip by print-vs-
// consensus (up on a beat, down on a miss) and fall back to neutral whenever
// there's no judgeable direction (in-line, unparseable, or macro).
describe("actualChipClass (WeekAheadView EventRow)", () => {
  it("colors an EPS beat up", () => {
    const cls = actualChipClass(earningsEvent("EPS 0.41", "EPS 0.45"));
    expect(cls).toContain("text-up");
    expect(cls).not.toContain("text-down");
  });

  it("colors an EPS miss down", () => {
    const cls = actualChipClass(earningsEvent("EPS 0.41", "EPS 0.30"));
    expect(cls).toContain("text-down");
    expect(cls).not.toContain("text-up");
  });

  it("is neutral for an implausible actual even though the raw delta would read as a beat", () => {
    // Same gate as eventFigureDisplays (2026-08-30 landing-review nit —
    // actualChipClass must be safe standalone, not only via its call site).
    // EPS 5.11 vs consensus 2.70 is 1.89x — the documented GOOGL bogus-scrape
    // case isPlausibleEarnings rejects.
    const cls = actualChipClass(earningsEvent("EPS 2.70", "EPS 5.11"));
    expect(cls).not.toContain("text-up");
    expect(cls).not.toContain("text-down");
  });

  it("a manual override (manual_actuals_at) bypasses the plausibility gate and colors normally", () => {
    const cls = actualChipClass({
      ...earningsEvent("EPS 2.70", "EPS 5.11"),
      manual_actuals_at: "2026-08-30 12:00:00",
    });
    expect(cls).toContain("text-up");
  });

  it("is neutral when the print is in-line (within 0.05%)", () => {
    const cls = actualChipClass(earningsEvent("EPS 1.00", "EPS 1.0001"));
    expect(cls).not.toContain("text-up");
    expect(cls).not.toContain("text-down");
  });

  it("is neutral for earnings with consensus but no parseable actual EPS", () => {
    const cls = actualChipClass(earningsEvent("EPS 0.41", "Rev 4305870107"));
    expect(cls).not.toContain("text-up");
    expect(cls).not.toContain("text-down");
  });

  it("is neutral for a macro event even with numeric-looking figures — CPI up is not a beat", () => {
    const cls = actualChipClass({
      event_type: "fomc",
      consensus_estimate: "4.25%",
      actual_value: "4.50%",
    });
    expect(cls).not.toContain("text-up");
    expect(cls).not.toContain("text-down");
  });

  it("prefers consensus_value over consensus_estimate (effectiveConsensus precedence)", () => {
    // A stale consensus_estimate would read this as a beat (0.56 > 0.41);
    // the fresher consensus_value (0.60) makes it a miss.
    const cls = actualChipClass({
      event_type: "earnings",
      consensus_estimate: "EPS 0.41",
      consensus_value: "EPS 0.60",
      actual_value: "EPS 0.56",
    });
    expect(cls).toContain("text-down");
    expect(cls).not.toContain("text-up");
  });
});

// QA finding today-week-ahead--actual-chip-overflows-card-4th-recurrence:
// the chip's TONE never overflowed — its WIDTH did. shrink-0 + whitespace-nowrap
// kept the chip's intrinsic width (~157px) intact even in day columns as
// narrow as ~130px (5-up grid, chat rail open at >=1280px), so the neighboring
// column painted over it and truncated the figure mid-number. actualChipClass
// only owns the tone classes (asserted above); the layout classes are static
// JSX on the <span> in WeekAheadView.tsx, so pin them by source inspection —
// same technique as tests/dashboard/security-trade-grade-group-caption.test.ts.
describe("WeekAheadView actual chip — width contract (source-pinned)", () => {
  const src = readFileSync("app/dashboard/today/WeekAheadView.tsx", "utf8");
  const match = src.match(
    /actualDisplay && \(\s*<span\s*\n\s*className=\{`([^`]*)\$\{actualChipClass\(event\)\}`\}/,
  );

  it("finds the actual chip's className template in the source", () => {
    expect(match).not.toBeNull();
  });

  it("caps the chip to the card width and lets it wrap instead of overflow", () => {
    const cls = match?.[1] ?? "";
    expect(cls).toContain("max-w-full");
    expect(cls).not.toContain("whitespace-nowrap");
    expect(cls).not.toContain("shrink-0");
  });

  it("keeps the drop-to-own-line alignment (ml-auto) untouched", () => {
    const cls = match?.[1] ?? "";
    expect(cls).toContain("ml-auto");
  });
});
