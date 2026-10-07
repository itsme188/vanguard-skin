/**
 * Pure action-visibility rules for a security_levels row's Pause / Reactivate
 * / Re-queue buttons (LevelsPanel.tsx). Extracted so the rules are unit-
 * testable independent of the two near-duplicate render branches (terminal
 * "embedded" rows + the compact list rows) that both need them.
 *
 * History. Codex advisory #49 (2026-08-16): a prior change hid Pause for
 * every "unarmed review" row and left Delete as the only action on a rejected
 * level. The fix then was to show Pause/Reactivate on every row.
 *
 * Rule since the 2026-10-07 ruling (reactivate finding, sibling fix): Pause is
 * offered only on a row the scanner actually watches (active AND
 * auto_approved). Pausing a rejected or pending row would stop nothing, and it
 * read as if the row had been armed. Reactivate stays on EVERY inactive row,
 * whatever its review status, so no inactive row is left with Delete only (the
 * dead end #49 removed). An active unarmed row is not a dead end either: a
 * pending row is decided on the Alerts Review tab and a rejected row has
 * Re-queue. This helper is the single owner of these rules — LevelsPanel must
 * not add conditions on top of its result.
 *
 * The rejected chip also told the user to "approve or reject it on the
 * Alerts Review tab" — but that tab's query (getPendingReviewLevels) only
 * ever returns review_status='pending_review' rows, so a rejected level had
 * no real action path back to a decision. showRequeue flags when a
 * "Re-queue for review" action should render — it flips the row back to
 * pending_review (via the existing PATCH /api/levels/review status=
 * pending_review path, which calls setLevelReviewStatus, NOT
 * approveLevelGuarded) so the Review tab can act on it again.
 */

import type { LevelReviewStatus } from "@/lib/types";

export interface LevelActionVisibilityInput {
  is_active: number;
  review_status: LevelReviewStatus;
}

export interface LevelActionVisibility {
  /** Not armed — is_active=1 but review_status isn't auto_approved yet
   *  (still pending_review) or was rejected. Mirrors the scanner's
   *  whitelist check (lib/queries/security-levels.ts findCrossedLevels). */
  unarmedReview: boolean;
  /** Pause is available on an active row the scanner watches
   *  (auto_approved) — a reversible way to stop watching it without deleting
   *  it. Not offered on a pending or rejected row: there is nothing to pause. */
  showPause: boolean;
  /** Reactivate is available on every inactive row, regardless of review
   *  status. Re-activating a rejected or pending row does not arm it (the
   *  server skips the arm guard and reports armed:false). */
  showReactivate: boolean;
  /** Re-queue is the only path back onto the Alerts Review tab for a
   *  rejected row still worth reconsidering; scoped to active+rejected so
   *  it doesn't duplicate the Review tab's own Approve/Reject actions on a
   *  level that's still mid-review (pending_review). */
  showRequeue: boolean;
}

export function levelActionVisibility(l: LevelActionVisibilityInput): LevelActionVisibility {
  const unarmedReview = l.is_active === 1 && l.review_status !== "auto_approved";
  return {
    unarmedReview,
    showPause: l.is_active === 1 && !unarmedReview,
    showReactivate: l.is_active !== 1,
    showRequeue: unarmedReview && l.review_status === "rejected",
  };
}

/** Guidance text for the "Rejected" / "Pending Review" chip's title —
 *  matched to what the UI can actually do about each state. */
export function levelReviewGuidance(reviewStatus: LevelReviewStatus): string {
  if (reviewStatus === "rejected") {
    return "Not armed — rejected. Use Re-queue to send it back to the Alerts Review tab for another decision.";
  }
  return "Not armed — the alert scanner only watches auto-approved levels. Approve or reject it on the Alerts Review tab.";
}
