/**
 * Ledger finding alerts--view-param-ignored-acted-dismissed-all-fall-through-
 * to-pending: `/dashboard/alerts?view=ignored|acted|dismissed|all` silently
 * rendered the Pending tab with the Pending pill active while the URL kept
 * the requested value. Cause: the page's `initialFilter` was a nested
 * ternary that recognised only review/armed/conflicts/emails and fell
 * through to "pending" for every other value — including five of the nine
 * FILTER_OPTIONS tabs.
 *
 * `parseAlertsViewParam` is the single-sourced fix: every FILTER_OPTIONS
 * value must round-trip through it, and unknown/absent values still fall
 * back to "pending" (that part of the old behavior was correct).
 */

import { describe, it, expect } from "vitest";
import { FILTER_OPTIONS, parseAlertsViewParam } from "@/lib/alerts/view-param";

describe("parseAlertsViewParam", () => {
  it("round-trips every FILTER_OPTIONS value", () => {
    for (const opt of FILTER_OPTIONS) {
      expect(parseAlertsViewParam(opt.value)).toBe(opt.value);
    }
  });

  it("covers all nine known tabs (guards against FILTER_OPTIONS drifting silently)", () => {
    expect(FILTER_OPTIONS.map((o) => o.value).sort()).toEqual(
      [
        "pending",
        "review",
        "armed",
        "conflicts",
        "emails",
        "acted",
        "ignored",
        "dismissed",
        "all",
      ].sort()
    );
  });

  it("falls back to pending for null", () => {
    expect(parseAlertsViewParam(null)).toBe("pending");
  });

  it("falls back to pending for an empty string", () => {
    expect(parseAlertsViewParam("")).toBe("pending");
  });

  it("falls back to pending for an unrecognized value", () => {
    expect(parseAlertsViewParam("banana")).toBe("pending");
  });
});
