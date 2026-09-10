import { describe, it, expect } from "vitest";
import { formatReactionSnapshot } from "../../lib/digest/send-earnings-email";

describe("formatReactionSnapshot", () => {
  it("renders delta_pct as-is (values are already percent), never ×100", () => {
    const json = JSON.stringify({
      t0_utc: "2026-07-22T20:15:00Z",
      window_min: 120,
      source: "yahoo",
      symbol: { symbol: "TER", t_pre: 100, t_post: 104.12, delta_pct: 4.12 },
      spy: { t_pre: 600, t_post: 602.46, delta_pct: 0.41 },
      qqq: { t_pre: 500, t_post: 498.6, delta_pct: -0.28 },
    });
    const out = formatReactionSnapshot(json);
    expect(out).not.toBeNull();
    expect(out).toContain("TER: +4.12%");
    expect(out).toContain("SPY: +0.41%");
    expect(out).toContain("QQQ: -0.28%");
    expect(out).not.toContain("41.00%");
  });

  it("returns null for malformed json", () => {
    expect(formatReactionSnapshot("not json")).toBeNull();
    expect(formatReactionSnapshot(null)).toBeNull();
  });

  /**
   * Regression for the finding: a stored qqq leg of
   * {t_pre:0,t_post:0,delta_pct:0} (a 0/0 division on dead quotes) rendered
   * as a confident "QQQ @ T+2h | +0.00%" in a sent recap, while spy — a
   * genuinely usable leg — rendered correctly. Shape is the finding's own
   * fixture (synthetic values, not real prices).
   */
  it("omits the 0/0 qqq leg while a usable sibling leg (spy) still renders", () => {
    const json = JSON.stringify({
      symbol: { t_pre: 100, t_post: 100.002, delta_pct: 0 },
      qqq: { t_pre: 0, t_post: 0, delta_pct: 0 },
      spy: { t_pre: 500, t_post: 499.9, delta_pct: -0.02 },
      pre_anchor: "prior_close",
      source: "yahoo",
    });
    const out = formatReactionSnapshot(json);
    expect(out).not.toBeNull();
    expect(out).not.toContain("QQQ");
    expect(out).toContain("SPY: -0.02%");
    // Known predicate limitation (surfaced explicitly, not silently): the
    // symbol leg here is a pre-price ECHO (100 -> 100.002), not a genuine
    // 0/0 division — both prices are finite and positive, so
    // isUsableReactionLeg cannot tell it apart from a real (if tiny) move
    // and it still renders "+0.00%". Only the zero/negative/non-finite
    // sentinel class is caught by this predicate.
    expect(out).toContain("+0.00%");
  });
});
