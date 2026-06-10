import { describe, it, expect } from "vitest";
import { splitLateArrivals, renderLateArrivalsBlock } from "@/lib/digest/late-arrivals";

const mk = (received_at: string, subject = "Subj") => ({
  received_at,
  subject,
  source_name: "TMT Breakout",
  summary: "Summary text.",
  source_url: null as string | null,
  website_url: null as string | null,
});

describe("splitLateArrivals", () => {
  // Previous send: 2026-06-09T12:45:00.000Z (8:45 ET). 60-min window → late
  // means received in (12:45, 13:45].
  const since = "2026-06-09T12:45:00.000Z";

  it("flags articles received within 60 min after the previous send", () => {
    const late = mk("2026-06-09T12:48:00.000Z");      // 3 min after → late
    const onTime = mk("2026-06-09T15:00:00.000Z");    // hours later → rest
    const { late: l, rest } = splitLateArrivals([late, onTime], since);
    expect(l).toEqual([late]);
    expect(rest).toEqual([onTime]);
  });

  it("handles SQLite space-separated UTC timestamps", () => {
    const late = mk("2026-06-09 12:50:00"); // SQLite datetime('now') format, UTC
    const { late: l } = splitLateArrivals([late], since);
    expect(l).toEqual([late]);
  });

  it("returns everything as rest when sinceIso is date-only (no send time known)", () => {
    const a = mk("2026-06-09T12:48:00.000Z");
    const { late: l, rest } = splitLateArrivals([a], "2026-06-08");
    expect(l).toEqual([]);
    expect(rest).toEqual([a]);
  });

  it("respects a custom window", () => {
    const a = mk("2026-06-09T14:30:00.000Z"); // 105 min after
    expect(splitLateArrivals([a], since).late).toEqual([]);
    expect(splitLateArrivals([a], since, 120).late).toEqual([a]);
  });
});

describe("renderLateArrivalsBlock", () => {
  it("renders heading, per-article line with ET arrival time, and trailing rule", () => {
    const block = renderLateArrivalsBlock(
      [mk("2026-06-09T12:48:00.000Z", "TMTB Morning Wrap")],
      "this morning's email",
    );
    expect(block).toContain("## ⏰ Late arrivals");
    expect(block).toContain("**TMT Breakout — TMTB Morning Wrap**");
    expect(block).toContain("8:48 AM ET, just after this morning's email");
    expect(block).toContain("Summary text.");
    expect(block.trimEnd().endsWith("---")).toBe(true);
  });

  it("returns empty string for no late articles", () => {
    expect(renderLateArrivalsBlock([], "this morning's email")).toBe("");
  });
});
