import { describe, it, expect } from "vitest";
import {
  errorFeedback,
  progressFeedback,
  readSyncFailure,
  shouldAutoDismiss,
  nextFeedback,
  syncFailureText,
} from "@/lib/research/sync-feedback";

// REGRESSION PIN — qa finding research-feeds-sync-feeds--silent-400-no-
// feedback-regression-4 (5th occurrence). Research -> Feeds -> "Sync Feeds"
// POSTs /api/research/sync; when Gmail OAuth isn't configured the route
// answers 400 and the button used to read as completely inert.
//
// The failure was surfaced, but only transiently and remotely, which is why
// it kept coming back after four "fixes":
//   1. the message was wiped by an unconditional 5s auto-dismiss in the
//      handler's finally block — errors evaporated along with progress text;
//   2. the background auto-sync (useResearchSync) shares the same status slot
//      and could overwrite a manual sync's error with "Refreshing in
//      background…";
//   3. the 400 body is a bare {error} — NOT the project's {success:false,
//      error} envelope — so any handler that gated on data.success saw
//      nothing to report.
//
// This repo has no React rendering harness (no jsdom / @testing-library/react
// — see the precedent note in tests/dashboard/data-confidence-indicator-
// privacy.test.ts), so the pin lives on the extracted pure helpers that own
// each of those three rules.

describe("readSyncFailure (what the user is told when the POST fails)", () => {
  it("surfaces the server's message from a real 400 Response (the live repro)", async () => {
    const res = new Response(JSON.stringify({ error: "Gmail OAuth not configured" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

    const feedback = await readSyncFailure(res);

    expect(feedback.tone).toBe("error");
    expect(feedback.text).toBe("Gmail OAuth not configured");
  });

  it("also reads the project-standard {success:false,error} envelope", async () => {
    const res = new Response(JSON.stringify({ success: false, error: "Gmail token expired" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

    expect((await readSyncFailure(res)).text).toBe("Gmail token expired");
  });

  it("never renders an empty or placeholder line when the body has no message", async () => {
    const res = new Response("<html>502 Bad Gateway</html>", { status: 502 });

    const feedback = await readSyncFailure(res);

    expect(feedback.tone).toBe("error");
    expect(feedback.text).toBe("Sync failed (502)");
    expect(feedback.text.trim().length).toBeGreaterThan(0);
  });

  it("ignores a success-shaped body on a failing status", async () => {
    // A route that answers 400 with {success:true} is lying; the status wins.
    const res = new Response(JSON.stringify({ success: true }), { status: 400 });
    expect((await readSyncFailure(res)).text).toBe("Sync failed (400)");
  });
});

describe("syncFailureText", () => {
  it("prefers `error`, then `message`, then a status fallback", () => {
    expect(syncFailureText(400, { error: "no gmail" })).toBe("no gmail");
    expect(syncFailureText(400, { message: "stream broke" })).toBe("stream broke");
    expect(syncFailureText(400, {})).toBe("Sync failed (400)");
    expect(syncFailureText(400, null)).toBe("Sync failed (400)");
    expect(syncFailureText(400, "not json")).toBe("Sync failed (400)");
  });

  it("does not surface a blank or whitespace-only server message", () => {
    expect(syncFailureText(400, { error: "   " })).toBe("Sync failed (400)");
  });
});

describe("shouldAutoDismiss (rule 1 — errors must not evaporate)", () => {
  it("auto-dismisses a progress/completion line", () => {
    expect(shouldAutoDismiss(progressFeedback("Up to date — no new articles"))).toBe(true);
  });

  it("NEVER auto-dismisses an error line", () => {
    expect(shouldAutoDismiss(errorFeedback("Gmail OAuth not configured"))).toBe(false);
  });

  it("has nothing to dismiss when there is no feedback", () => {
    expect(shouldAutoDismiss(null)).toBe(false);
  });
});

describe("nextFeedback (rule 2 — background sync must not clobber an error)", () => {
  const err = errorFeedback("Gmail OAuth not configured");

  it("lets a background progress line through when nothing is showing", () => {
    expect(nextFeedback(null, progressFeedback("Refreshing in background…"))).toEqual(
      progressFeedback("Refreshing in background…"),
    );
  });

  it("refuses to overwrite a standing error with background progress", () => {
    expect(nextFeedback(err, progressFeedback("Refreshing in background…"))).toBe(err);
  });

  it("lets a NEW error replace a standing error", () => {
    const worse = errorFeedback("Gmail token expired");
    expect(nextFeedback(err, worse)).toBe(worse);
  });

  it("lets an explicit clear (null) through — a fresh manual sync resets", () => {
    expect(nextFeedback(err, null)).toBeNull();
  });

  it("replaces one progress line with the next", () => {
    const a = progressFeedback("Connecting to Gmail...");
    const b = progressFeedback("Fetching new articles...");
    expect(nextFeedback(a, b)).toBe(b);
  });
});
