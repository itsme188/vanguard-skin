import { describe, it, expect } from "vitest";
import { latestNoteLine } from "@/app/dashboard/security/[id]/TranscriptsRefreshButton";

// The fetch / refresh button must not drop the "this is not confirmed as the
// latest" flag the transcripts route returns. No DOM harness in this repo, so
// the pure helper that picks the line is tested; the wiring is browser-proved.
describe("latestNoteLine (TranscriptsRefreshButton, POST /api/transcripts reply)", () => {
  const note = "This call is for fiscal Q3 2026. A newer earnings print dated 2026-10-08 is on file.";

  it("returns the server's note when the document is not confirmed as the latest", () => {
    expect(latestNoteLine({ success: true, latestConfirmed: false, latestNote: note })).toBe(note);
  });

  it("falls back to a plain sentence when the flag is false but no note came with it", () => {
    expect(latestNoteLine({ success: true, latestConfirmed: false })).toBe(
      "This could not be confirmed as the most recent document; a newer one may exist.",
    );
    expect(latestNoteLine({ latestConfirmed: false, latestNote: "   " })).toBe(
      "This could not be confirmed as the most recent document; a newer one may exist.",
    );
  });

  it("is null when the latest print is confirmed, when no claim is made, and for an older reply shape", () => {
    expect(latestNoteLine({ latestConfirmed: true, latestNote: null })).toBeNull();
    expect(latestNoteLine({ latestConfirmed: null, latestNote: null })).toBeNull();
    expect(latestNoteLine({ success: true, fromCache: true })).toBeNull();
    expect(latestNoteLine(null)).toBeNull();
    expect(latestNoteLine("nope")).toBeNull();
  });

  it("never shows a note on a confirmed reply even if one is present", () => {
    expect(latestNoteLine({ latestConfirmed: true, latestNote: note })).toBeNull();
  });
});
