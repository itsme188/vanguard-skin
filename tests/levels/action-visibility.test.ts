import { describe, it, expect } from "vitest";
import {
  levelPauseRefusal,
  levelActionVisibility,
  levelNotWatchedExplanation,
  levelReviewGuidance,
} from "@/lib/levels/action-visibility";

// Codex advisory #49: a prior change hid Pause/Deactivate for every "unarmed
// review" row (is_active=1, review_status != 'auto_approved'), leaving
// Delete as the only visible action on a rejected level, and the rejected
// chip's guidance ("approve or reject it on the Alerts Review tab") pointed
// at a tab whose query only ever returns pending_review rows.

describe("levelActionVisibility", () => {
  it("active + auto_approved: Pause visible, Reactivate/Re-queue hidden", () => {
    const v = levelActionVisibility({
      is_active: 1,
      review_status: "auto_approved",
      scanner_watching: true,
    });
    expect(v).toEqual({
      unarmedReview: false,
      showPause: true,
      showReactivate: false,
      showRequeue: false,
      showRejectedChip: false,
    });
  });

  it("active + auto_approved + expired: Pause hidden because the scanner no longer watches it", () => {
    const input = { is_active: 1, review_status: "auto_approved" as const, scanner_watching: false };
    expect(levelActionVisibility(input)).toEqual({
      unarmedReview: false,
      showPause: false,
      showReactivate: false,
      showRequeue: false,
      showRejectedChip: false,
    });
    expect(levelNotWatchedExplanation(input)).toBe("Expired — no longer watched");
  });

  it("active + auto_approved + live: Pause remains visible and no explanation renders", () => {
    const input = { is_active: 1, review_status: "auto_approved" as const, scanner_watching: true };
    expect(levelActionVisibility(input).showPause).toBe(true);
    expect(levelNotWatchedExplanation(input)).toBeNull();
  });

  // 2026-10-07 ruling (reactivate finding, sibling fix): Pause is offered only
  // on a row the scanner actually watches. Pausing a rejected or pending row
  // would stop nothing. Neither row is a dead end: a pending row is decided on
  // the Alerts Review tab, a rejected row has Re-queue.
  it("active + pending_review: unarmed, no Pause (the scanner ignores it), Re-queue hidden — the Review tab covers pending rows", () => {
    const v = levelActionVisibility({ is_active: 1, review_status: "pending_review" });
    expect(v).toEqual({
      unarmedReview: true,
      showPause: false,
      showReactivate: false,
      showRequeue: false,
      showRejectedChip: false,
    });
  });

  it("active + rejected: unarmed, no Pause (the scanner ignores it), Re-queue visible — the path back to the Review tab", () => {
    const v = levelActionVisibility({ is_active: 1, review_status: "rejected" });
    expect(v).toEqual({
      unarmedReview: true,
      showPause: false,
      showReactivate: false,
      showRequeue: true,
      showRejectedChip: true,
    });
  });

  it("inactive + pending_review: Reactivate visible — an inactive never-approved row must not be left with Delete only", () => {
    const v = levelActionVisibility({ is_active: 0, review_status: "pending_review" });
    expect(v).toEqual({
      unarmedReview: false,
      showPause: false,
      showReactivate: true,
      showRequeue: false,
      showRejectedChip: false,
    });
  });

  it("inactive + rejected: Reactivate visible, Re-queue hidden (row must be reactivated before it can be re-queued)", () => {
    const v = levelActionVisibility({ is_active: 0, review_status: "rejected" });
    expect(v).toEqual({
      unarmedReview: false,
      showPause: false,
      showReactivate: true,
      showRequeue: false,
      showRejectedChip: true,
    });
  });

  it("inactive + auto_approved (paused/triggered level): Reactivate visible, nothing review-related", () => {
    const v = levelActionVisibility({ is_active: 0, review_status: "auto_approved" });
    expect(v).toEqual({
      unarmedReview: false,
      showPause: false,
      showReactivate: true,
      showRequeue: false,
      showRejectedChip: false,
    });
  });

  it("paused rows do not show the expired not-watched explanation", () => {
    const input = { is_active: 0, review_status: "auto_approved" as const, scanner_watching: false };
    expect(levelActionVisibility(input).showReactivate).toBe(true);
    expect(levelNotWatchedExplanation(input)).toBeNull();
  });

  it("pending review rows keep their review action path, not the expired explanation", () => {
    const input = { is_active: 1, review_status: "pending_review" as const, scanner_watching: false };
    expect(levelActionVisibility(input)).toMatchObject({
      unarmedReview: true,
      showPause: false,
      showReactivate: false,
    });
    expect(levelNotWatchedExplanation(input)).toBeNull();
  });

  it("Pause and Reactivate are never offered together, and every inactive row can be reactivated", () => {
    for (const is_active of [0, 1]) {
      for (const review_status of ["auto_approved", "pending_review", "rejected"] as const) {
        const v = levelActionVisibility({ is_active, review_status });
        expect(v.showPause && v.showReactivate).toBe(false);
        expect(v.showReactivate).toBe(is_active === 0);
      }
    }
  });

  it("no row is a dead end: an unarmed active row has Re-queue or is pending on the Review tab", () => {
    for (const review_status of ["pending_review", "rejected"] as const) {
      const v = levelActionVisibility({ is_active: 1, review_status });
      expect(v.showRequeue || review_status === "pending_review").toBe(true);
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

describe("showRejectedChip — a paused rejected row still says rejected", () => {
  it("shows on every rejected row, active or paused, and on no other", () => {
    expect(levelActionVisibility({ is_active: 0, review_status: "rejected" }).showRejectedChip).toBe(true);
    expect(levelActionVisibility({ is_active: 1, review_status: "rejected" }).showRejectedChip).toBe(true);
    expect(levelActionVisibility({ is_active: 0, review_status: "auto_approved" }).showRejectedChip).toBe(false);
    expect(levelActionVisibility({ is_active: 1, review_status: "pending_review" }).showRejectedChip).toBe(false);
  });
});

describe("levelPauseRefusal — the server twin of showPause", () => {
  it("allows only an auto-approved level, and agrees with the UI rule", () => {
    expect(levelPauseRefusal("auto_approved")).toBeNull();
    for (const rs of ["pending_review", "rejected"] as const) {
      expect(levelPauseRefusal(rs)).toMatch(/not armed/i);
      // No active row of this status is offered Pause, so the UI never sends it.
      expect(levelActionVisibility({ is_active: 1, review_status: rs }).showPause).toBe(false);
    }
  });
});
