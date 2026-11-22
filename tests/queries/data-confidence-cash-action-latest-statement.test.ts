import { describe, it, expect } from "vitest";
import { isCashAnchorLatestPossible } from "@/lib/queries/data-confidence";

describe("isCashAnchorLatestPossible", () => {
  it("previous month-end anchor, mid-month today: latest possible", () => {
    expect(isCashAnchorLatestPossible("2026-10-31", "2026-11-22")).toBe(true);
  });
  it("previous month-end anchor, today is the last day of the month: a newer date exists", () => {
    expect(isCashAnchorLatestPossible("2026-10-31", "2026-11-30")).toBe(false);
  });
  it("anchor two months old: not latest", () => {
    expect(isCashAnchorLatestPossible("2026-09-30", "2026-11-22")).toBe(false);
  });
  it("today is month-end and anchor is today", () => {
    expect(isCashAnchorLatestPossible("2026-11-30", "2026-11-30")).toBe(true);
  });
  it("January boundary", () => {
    expect(isCashAnchorLatestPossible("2026-12-31", "2027-01-15")).toBe(true);
    expect(isCashAnchorLatestPossible("2026-11-30", "2027-01-15")).toBe(false);
  });
  it("leap-year February", () => {
    expect(isCashAnchorLatestPossible("2028-02-29", "2028-03-10")).toBe(true);
    expect(isCashAnchorLatestPossible("2028-02-28", "2028-03-10")).toBe(false);
    expect(isCashAnchorLatestPossible("2028-01-31", "2028-02-29")).toBe(false);
    expect(isCashAnchorLatestPossible("2028-02-29", "2028-02-29")).toBe(true);
    expect(isCashAnchorLatestPossible("2027-02-28", "2027-02-28")).toBe(true);
  });
  it("no anchor: false", () => {
    expect(isCashAnchorLatestPossible(null, "2026-11-22")).toBe(false);
  });
});
