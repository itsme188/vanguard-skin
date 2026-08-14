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

// ── releasedFigureGates (qa: prior-quarter reaction rendered on future print) ──
// A date correction can carry a prior print's actual/reaction onto a FUTURE
// row; the forward-looking week view must never render post-release data for
// an event whose date hasn't arrived, and mirrors TodayReleases' enriched_at
// gate for the reaction line.
import { releasedFigureGates } from "@/app/dashboard/today/WeekAheadView";

describe("releasedFigureGates (WeekAheadView)", () => {
  const TODAY = "2026-08-09";
  const base = {
    event_date: "2026-08-12",
    enriched_at: "2026-07-24 21:10:00",
    reaction_snapshot: '{"source":"tws"}',
  };

  it("suppresses reaction AND actual on a future print carrying migrated enrichment", () => {
    const g = releasedFigureGates(base, TODAY);
    expect(g.released).toBe(false);
    expect(g.showReaction).toBe(false);
  });

  it("shows both for a released, enriched event (event_date == today counts as released)", () => {
    // Snapshot t0 on the event's own date — 14:55Z = 10:55 ET same day.
    const g = releasedFigureGates(
      {
        ...base,
        event_date: TODAY,
        reaction_snapshot: `{"source":"tws","t0_utc":"${TODAY}T14:55:00.000Z"}`,
      },
      TODAY,
    );
    expect(g.released).toBe(true);
    expect(g.showReaction).toBe(true);
  });

  it("keeps the reaction hidden until enrichment stamps, even on a past date", () => {
    const g = releasedFigureGates(
      { ...base, event_date: "2026-08-05", enriched_at: null },
      TODAY,
    );
    expect(g.released).toBe(true);
    expect(g.showReaction).toBe(false);
  });

  it("no snapshot → no reaction line", () => {
    const g = releasedFigureGates(
      { ...base, event_date: "2026-08-05", reaction_snapshot: null },
      TODAY,
    );
    expect(g.showReaction).toBe(false);
  });
});

// ── snapshotCoversEventDate (qa: reaction snapshot t0 outside release window) ──
// A stored snapshot only belongs to a print when its t0 falls on the event's
// own date (ET wall-clock — an 8 PM ET print rolls the UTC date). Date
// corrections can strand a snapshot measured for a different day on this row.
import { snapshotCoversEventDate } from "@/lib/calendar/reaction-snapshot";
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot";

function snap(t0: string | undefined): ReactionSnapshot {
  return { t0_utc: t0 } as unknown as ReactionSnapshot;
}

describe("snapshotCoversEventDate", () => {
  it("accepts a t0 on the event's ET date", () => {
    // 14:55Z on Aug 13 = 10:55 ET Aug 13.
    expect(snapshotCoversEventDate("2026-08-13", snap("2026-08-13T14:55:00.000Z"))).toBe(true);
  });

  it("accepts an evening AMC print whose UTC date rolled over", () => {
    // 00:15Z Aug 14 = 20:15 ET Aug 13 — same ET date as the event.
    expect(snapshotCoversEventDate("2026-08-13", snap("2026-08-14T00:15:00.000Z"))).toBe(true);
  });

  it("rejects a t0 measured the day BEFORE the event (pre-print snapshot)", () => {
    // LAC shape: event 2026-08-13, snapshot measured 10:55 ET on Aug 12.
    expect(snapshotCoversEventDate("2026-08-13", snap("2026-08-12T14:55:00.000Z"))).toBe(false);
  });

  it("rejects a t0 measured the day AFTER the event", () => {
    // OCUL shape: event 2026-08-03, snapshot measured 16:15 ET on Aug 4.
    expect(snapshotCoversEventDate("2026-08-03", snap("2026-08-04T20:15:00.000Z"))).toBe(false);
  });

  it("rejects a snapshot with no t0 and a garbage t0", () => {
    expect(snapshotCoversEventDate("2026-08-13", snap(undefined))).toBe(false);
    expect(snapshotCoversEventDate("2026-08-13", snap("not-a-date"))).toBe(false);
    expect(snapshotCoversEventDate("2026-08-13", null)).toBe(false);
  });
});

describe("releasedFigureGates t0 window check", () => {
  const TODAY = "2026-08-13";

  it("suppresses the reaction when the snapshot's t0 is outside the event's date", () => {
    const g = releasedFigureGates(
      {
        event_date: "2026-08-13",
        enriched_at: "2026-08-13 12:00:00",
        reaction_snapshot: '{"source":"tws","t0_utc":"2026-08-12T14:55:00.000Z"}',
      },
      TODAY,
    );
    expect(g.released).toBe(true);
    expect(g.showReaction).toBe(false);
  });

  it("still shows the reaction when t0 matches the event date", () => {
    const g = releasedFigureGates(
      {
        event_date: "2026-08-13",
        enriched_at: "2026-08-13 12:00:00",
        reaction_snapshot: '{"source":"tws","t0_utc":"2026-08-13T14:55:00.000Z"}',
      },
      TODAY,
    );
    expect(g.showReaction).toBe(true);
  });
});
