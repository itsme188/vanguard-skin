import { describe, it, expect } from "vitest";
import { levelActionVisibility, levelReviewGuidance } from "@/lib/levels/action-visibility";

// Codex advisory #49: a prior change hid Pause/Deactivate for every "unarmed
// review" row (is_active=1, review_status != 'auto_approved'), leaving
// Delete as the only visible action on a rejected level, and the rejected
// chip's guidance ("approve or reject it on the Alerts Review tab") pointed
// at a tab whose query only ever returns pending_review rows.

describe("levelActionVisibility", () => {
  it("active + auto_approved: Pause visible, Reactivate/Re-queue hidden", () => {
    const v = levelActionVisibility({ is_active: 1, review_status: "auto_approved" });
    expect(v).toEqual({
      unarmedReview: false,
      showPause: true,
      showReactivate: false,
      showRequeue: false,
    });
  });

  it("active + pending_review: unarmed, Pause visible (restored), Re-queue hidden — the Review tab already covers pending rows", () => {
    const v = levelActionVisibility({ is_active: 1, review_status: "pending_review" });
    expect(v).toEqual({
      unarmedReview: true,
      showPause: true,
      showReactivate: false,
      showRequeue: false,
    });
  });

  it("active + rejected: unarmed, Pause visible (restored) AND Re-queue visible — the only path back to the Review tab", () => {
    const v = levelActionVisibility({ is_active: 1, review_status: "rejected" });
    expect(v).toEqual({
      unarmedReview: true,
      showPause: true,
      showReactivate: false,
      showRequeue: true,
    });
  });

  it("inactive + rejected: Reactivate visible, Re-queue hidden (row must be reactivated before it can be re-queued)", () => {
    const v = levelActionVisibility({ is_active: 0, review_status: "rejected" });
    expect(v).toEqual({
      unarmedReview: false,
      showPause: false,
      showReactivate: true,
      showRequeue: false,
    });
  });

  it("inactive + auto_approved (paused/triggered level): Reactivate visible, nothing review-related", () => {
    const v = levelActionVisibility({ is_active: 0, review_status: "auto_approved" });
    expect(v).toEqual({
      unarmedReview: false,
      showPause: false,
      showReactivate: true,
      showRequeue: false,
    });
  });

  it("showPause and showReactivate are always mutually exclusive", () => {
    for (const is_active of [0, 1]) {
      for (const review_status of ["auto_approved", "pending_review", "rejected"] as const) {
        const v = levelActionVisibility({ is_active, review_status });
        expect(v.showPause).toBe(!v.showReactivate);
      }
    }
  });
});

describe("levelReviewGuidance", () => {
  it("tells a rejected row's guidance to use Re-queue, not the Review tab directly", () => {
    const text = levelReviewGuidance("rejected");
    expect(text).toContain("Re-queue");
    expect(text).not.toContain("Approve or reject it on the Alerts Review tab");
  });

  it("tells a pending_review row it can be approved/rejected on the Alerts Review tab", () => {
    const text = levelReviewGuidance("pending_review");
    expect(text).toContain("Alerts Review tab");
  });
});
