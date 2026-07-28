import { describe, it, expect } from "vitest";
import { eventFigureDisplays } from "@/app/dashboard/today/WeekAheadView";
import { effectiveConsensus } from "@/lib/calendar/consensus";
import type { CalendarEvent } from "@/lib/types";

type FigureEvent = Pick<
  CalendarEvent,
  "event_type" | "consensus_estimate" | "actual_value"
>;

function earningsEvent(consensus: string | null, actual: string | null): FigureEvent {
  return {
    event_type: "earnings",
    consensus_estimate: consensus,
    actual_value: actual,
  };
}

describe("eventFigureDisplays (WeekAheadView Next-releases card)", () => {
  it("suppresses an implausible earnings actual so the consensus line survives", () => {
    // KRC repro from the ledger: manual actual EPS 5.00 vs consensus EPS 0.41
    const d = eventFigureDisplays(
      earningsEvent("EPS 0.41 · Rev 280000000", "EPS 5.00 · Rev 275000000"),
    );
    expect(d.actualDisplay).toBeNull();
    expect(d.consensusDisplay).not.toBeNull();
  });

  it("shows a plausible earnings actual", () => {
    const d = eventFigureDisplays(
      earningsEvent("EPS 0.41 · Rev 280000000", "EPS 0.45 · Rev 285000000"),
    );
    expect(d.actualDisplay).not.toBeNull();
  });

  it("shows an actual with no consensus to compare against (no claim)", () => {
    const d = eventFigureDisplays(earningsEvent(null, "EPS 1.18"));
    expect(d.actualDisplay).not.toBeNull();
  });

  it("leaves macro rows untouched — raw values pass through with no plausibility gate", () => {
    const d = eventFigureDisplays({
      event_type: "fomc",
      consensus_estimate: "4.25%",
      actual_value: "4.50%",
    });
    expect(d.actualDisplay).toBe("4.50%");
    expect(d.consensusDisplay).toBe("4.25%");
  });

  it("returns nulls when neither figure exists", () => {
    const d = eventFigureDisplays(earningsEvent(null, null));
    expect(d.actualDisplay).toBeNull();
    expect(d.consensusDisplay).toBeNull();
  });

  // Consensus precedence — consensus_value (enrichment-time) wins over
  // consensus_estimate (sync-time). KRC 2026-07-27 repro: estimate 0.41 vs
  // value 0.54; the stale estimate turned a +3.7% beat into a fake +36.6%.
  it("prefers consensus_value over consensus_estimate for display AND the plausibility gate", () => {
    const d = eventFigureDisplays({
      event_type: "earnings",
      consensus_estimate: "EPS 0.41 · Rev 271197756",
      consensus_value: "EPS 0.54 · Rev 271197756",
      actual_value: "EPS 0.56 · Rev 272000000",
    });
    expect(d.consensusDisplay).toContain("0.54");
    expect(d.actualDisplay).not.toBeNull();
  });

  it("falls back to consensus_estimate when consensus_value is absent", () => {
    expect(
      effectiveConsensus({ consensus_estimate: "EPS 0.41", consensus_value: null }),
    ).toBe("EPS 0.41");
    expect(
      effectiveConsensus({ consensus_estimate: "EPS 0.41", consensus_value: "EPS 0.54" }),
    ).toBe("EPS 0.54");
    expect(effectiveConsensus({ consensus_estimate: null })).toBeNull();
  });
});
