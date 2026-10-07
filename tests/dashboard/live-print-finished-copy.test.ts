/**
 * QA B46: a finished print sheet carries no pending-source copy, and the
 * release-link input is clamped inside its card at phone width.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isPrintFinished } from "@/app/dashboard/today/LivePrintRow";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const win = { start: "2026-01-02T21:00:00Z", end: "2026-01-02T22:00:00Z" };
const before = Date.parse("2026-01-02T21:30:00Z");
const after = Date.parse("2026-01-02T23:00:00Z");

describe("isPrintFinished", () => {
  it("treats expired and disarmed as finished", () => {
    expect(isPrintFinished("expired", win, before)).toBe(true);
    expect(isPrintFinished("disarmed", null, before)).toBe(true);
  });
  it("parsed is finished only once the window has ended", () => {
    expect(isPrintFinished("parsed", win, after)).toBe(true);
    expect(isPrintFinished("parsed", win, before)).toBe(false);
    expect(isPrintFinished("parsed", null, after)).toBe(false);
  });
  it("scheduled and live states are never finished", () => {
    for (const s of ["scheduled", "window_open", "acquired"]) {
      expect(isPrintFinished(s, win, after)).toBe(false);
    }
  });
});

describe("source pins", () => {
  const row = readFileSync("app/dashboard/today/LivePrintRow.tsx", "utf8");
  const go = readFileSync("app/dashboard/today/live-print/GoControls.tsx", "utf8");
  it("gates the restart fallback and the prep line on the print being open", () => {
    const i = anchorIndex(row, "awaiting first poll");
    expect(row.slice(i - 60, i)).toContain("finished");
    expect(row).toContain("{!finished && <PrepareStatus");
  });
  it("release-link input clamps to the card", () => {
    const i = anchorIndex(go, 'placeholder="Paste the release link"');
    const chunk = go.slice(i, i + 200);
    expect(chunk).toContain("w-full sm:w-[20rem] min-w-0");
  });
});
