/**
 * Unit tests for the shared pre-print floor condition (QA finding
 * today-bogeys-actuals--future-print-actuals-accepted-no-guard). Both the
 * reporter-recap send path and the manual-actuals save path call
 * checkPrePrintFloor — these tests pin the condition itself so neither
 * caller can drift from it.
 */

import { describe, it, expect } from "vitest";
import { checkPrePrintFloor } from "@/lib/earnings/pre-print-floor";

describe("checkPrePrintFloor", () => {
  it("flags a release instant that is still in the future", () => {
    // 07:30 ET on 2026-07-31 = 11:30 UTC; "now" is 2h before that.
    const now = new Date("2026-07-31T09:30:00Z");
    const result = checkPrePrintFloor(
      { event_date: "2026-07-31", release_time: "07:30" },
      now,
    );
    expect(result.isPrePrint).toBe(true);
    expect(result.release?.toISOString()).toBe("2026-07-31T11:30:00.000Z");
  });

  it("does not flag a release instant in the past", () => {
    const now = new Date("2026-07-31T12:30:00Z");
    const result = checkPrePrintFloor(
      { event_date: "2026-07-31", release_time: "07:30" },
      now,
    );
    expect(result.isPrePrint).toBe(false);
  });

  it("does not flag an event two days in the future when release_time is missing", () => {
    const now = new Date("2026-07-31T12:00:00Z");
    const result = checkPrePrintFloor(
      { event_date: "2026-08-02", release_time: null },
      now,
    );
    expect(result.isPrePrint).toBe(false);
    expect(result.release).toBeNull();
  });

  it("flags an event whose date is two days ahead when release_time is present (matches the QA repro)", () => {
    const now = new Date("2026-08-19T12:00:00Z");
    const result = checkPrePrintFloor(
      { event_date: "2026-08-21", release_time: "07:30" },
      now,
    );
    expect(result.isPrePrint).toBe(true);
  });

  it("treats an unparseable event_date/release_time pair as not pre-print", () => {
    const now = new Date("2026-07-31T12:00:00Z");
    const result = checkPrePrintFloor(
      { event_date: "not-a-date", release_time: "07:30" },
      now,
    );
    expect(result.isPrePrint).toBe(false);
    expect(result.release).toBeNull();
  });

  it("defaults `now` to the current instant when omitted", () => {
    const farFuture = { event_date: "2099-01-01", release_time: "09:00" };
    expect(checkPrePrintFloor(farFuture).isPrePrint).toBe(true);
  });
});
