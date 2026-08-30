import { describe, it, expect } from "vitest";
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
