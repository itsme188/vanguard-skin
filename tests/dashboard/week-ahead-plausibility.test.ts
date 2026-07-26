import { describe, it, expect } from "vitest";
import { eventFigureDisplays } from "@/app/dashboard/today/WeekAheadView";
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
});
