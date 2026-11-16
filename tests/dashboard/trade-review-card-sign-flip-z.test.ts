/**
 * Trade Reviews card, review round 3 (Analysis tab fix wave 2026-11-15), Z5.
 *
 * A change of sign in the period's realized P&L is announced only when the
 * move is also material by the card's rule (at least PNL_DRIFT_MIN_USD and
 * PNL_DRIFT_MIN_SHARE of the saved figure). A cent-level wobble across zero
 * (+0.01 to -0.01) is not news. Every sign flip already moves at least 100%
 * of the saved figure, so for a flip the dollar floor is what decides.
 * All figures are synthetic.
 */
import { describe, expect, it } from "vitest";
import { savedReviewPnlDrift } from "@/app/dashboard/components/TradeReviewView";

describe("a sign change is announced only when the move is material", () => {
  it("a cent-level move across zero is no drift", () => {
    expect(savedReviewPnlDrift(0.01, { totalRealizedPnl: -0.01 })).toBeNull();
    expect(savedReviewPnlDrift(-0.4, { totalRealizedPnl: 0.4 })).toBeNull(); // moved 0.80 < $1
  });

  it("a flip that moves at least $1 is announced as a change of sign", () => {
    expect(savedReviewPnlDrift(0.5, { totalRealizedPnl: -0.5 })).toEqual({ currentPnl: -0.5, signFlipped: true });
    expect(savedReviewPnlDrift(1000, { totalRealizedPnl: -200 })).toEqual({ currentPnl: -200, signFlipped: true });
  });

  it("a material move on one side of zero is still drift without a sign change", () => {
    expect(savedReviewPnlDrift(1000, { totalRealizedPnl: 800 })).toEqual({ currentPnl: 800, signFlipped: false });
    expect(savedReviewPnlDrift(1000, { totalRealizedPnl: 1005 })).toBeNull();
  });
});
