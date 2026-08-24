/**
 * Footer "Generated <date>" stamp for briefingToHtml.
 *
 * The shared email shell stamps its footer at render time. That is correct
 * for live sends, but the archive viewer (/api/earnings/email-content)
 * re-renders stored markdown through the same shell — so every archived
 * email claimed it was "Generated" on the day it was VIEWED, contradicting
 * the Sent date in its own header. briefingToHtml now takes an optional
 * generatedAt date; the archive path passes the audit row's sent_at.
 *
 * Worker mirror: workers/cron/test/html.test.ts pins the same signature
 * (parity-pinned files — change both).
 */

import { describe, it, expect } from "vitest";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { parseDbTimestamp } from "@/lib/calendar/date-utils";

const ET_DATE_OPTS = {
  timeZone: "America/New_York",
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
} as const;

describe("briefingToHtml generatedAt", () => {
  it("stamps the provided generatedAt date, not render time", () => {
    const sent = new Date("2026-08-13T12:48:50Z"); // 08:48 ET, Thursday
    const html = briefingToHtml("body", "t", undefined, sent);
    expect(html).toContain("Generated Thursday, August 13, 2026");
  });

  it("anchors the stamp to ET, not UTC", () => {
    // 02:00 UTC on Aug 14 is still 22:00 ET on Aug 13.
    const sent = new Date("2026-08-14T02:00:00Z");
    const html = briefingToHtml("body", "t", undefined, sent);
    expect(html).toContain("Generated Thursday, August 13, 2026");
  });

  it("defaults to render time when generatedAt is omitted (live sends)", () => {
    const today = new Date().toLocaleDateString("en-US", ET_DATE_OPTS);
    const html = briefingToHtml("body", "t");
    expect(html).toContain(`Generated ${today}`);
  });
});

describe("parseDbTimestamp", () => {
  it("parses SQLite datetime('now') shape as UTC", () => {
    const d = parseDbTimestamp("2026-08-13 12:48:50");
    expect(d?.toISOString()).toBe("2026-08-13T12:48:50.000Z");
  });

  it("passes real ISO strings through", () => {
    const d = parseDbTimestamp("2026-08-13T12:48:50.000Z");
    expect(d?.toISOString()).toBe("2026-08-13T12:48:50.000Z");
  });

  it("returns null on garbage", () => {
    expect(parseDbTimestamp("not a date")).toBeNull();
    expect(parseDbTimestamp("")).toBeNull();
  });
});
