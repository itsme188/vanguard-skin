import { describe, it, expect } from "vitest";
import { formatReleasedEventForPrompt } from "@/lib/calendar/briefing";
import type { CalendarEvent } from "@/lib/types";

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    source: "finnhub",
    event_type: "earnings",
    event_date: "2026-05-12",
    event_time: "AMC",
    title: "TER earnings",
    description: null,
    security_id: null,
    symbol: "TER",
    ib_con_id: null,
    expected_impact: null,
    consensus_estimate: "EPS 1.35 · Rev 750M",
    previous_value: null,
    raw_json: null,
    source_key: "finnhub:TER:2026-05-12",
    week_of: "2026-05-11",
    fetched_at: "2026-05-04 00:00:00",
    created_at: "2026-05-04 00:00:00",
    release_time: "16:01",
    actual_value: "EPS 1.42 · Rev 775M",
    consensus_value: null,
    reaction_snapshot: null,
    enriched_at: "2026-05-12 20:15:00",
    ...overrides,
  };
}

describe("formatReleasedEventForPrompt — reaction line", () => {
  it("renders a usable reaction leg", () => {
    const event = makeEvent({
      reaction_snapshot: JSON.stringify({
        spy: { t_pre: 600, t_post: 602.46, delta_pct: 0.41 },
        qqq: { t_pre: 500, t_post: 498.6, delta_pct: -0.28 },
      }),
    });
    const out = formatReleasedEventForPrompt(event, 1);
    expect(out).toContain("SPY +0.41%");
    expect(out).toContain("QQQ -0.28%");
  });

  /**
   * Regression for the finding (earnings-recap--zero-priced-reaction-snapshot…):
   * a bare truthy check (`if (snap.qqq)`) does NOT catch a 0/0 sentinel leg —
   * a {t_pre:0,t_post:0,delta_pct:0} object is still truthy and printed as
   * "QQQ +0.00%" in the weekly briefing prompt, which then feeds the model
   * a fabricated flat-move claim. isUsableReactionLeg must exclude it while
   * a genuinely usable sibling leg (spy) still renders.
   */
  it("omits a 0/0 sentinel leg (never '+0.00%'), while a usable sibling leg (spy) still renders", () => {
    const event = makeEvent({
      reaction_snapshot: JSON.stringify({
        spy: { t_pre: 500, t_post: 499.9, delta_pct: -0.02 },
        qqq: { t_pre: 0, t_post: 0, delta_pct: 0 },
      }),
    });
    const out = formatReleasedEventForPrompt(event, 1);
    expect(out).toContain("SPY -0.02%");
    expect(out).not.toContain("QQQ");
    expect(out).not.toContain("+0.00%");
  });

  it("omits the whole reaction segment when every leg is unusable", () => {
    const event = makeEvent({
      reaction_snapshot: JSON.stringify({
        spy: { t_pre: 0, t_post: 0, delta_pct: 0 },
        qqq: { t_pre: 0, t_post: 0, delta_pct: 0 },
        tlt: { t_pre: 0, t_post: 0, delta_pct: 0 },
      }),
    });
    const out = formatReleasedEventForPrompt(event, 1);
    expect(out).not.toContain("SPY");
    expect(out).not.toContain("QQQ");
    expect(out).not.toContain("TLT");
    expect(out).not.toContain("+0.00%");
  });

  it("still tolerates malformed reaction_snapshot JSON (skips the reaction line)", () => {
    const event = makeEvent({ reaction_snapshot: "{not valid json" });
    const out = formatReleasedEventForPrompt(event, 1);
    expect(out).toContain("TER earnings");
    expect(out).not.toContain("SPY");
  });
});
