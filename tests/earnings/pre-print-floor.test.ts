/**
 * Unit tests for the shared pre-print floor condition (QA finding
 * today-bogeys-actuals--future-print-actuals-accepted-no-guard). Both the
 * reporter-recap send path and the manual-actuals save path call
 * checkPrePrintFloor — these tests pin the condition itself so neither
 * caller can drift from it.
 */

import { describe, it, expect } from "vitest";
import {
  checkPrePrintFloor,
  describePrePrintFloor,
} from "@/lib/earnings/pre-print-floor";

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

/**
 * Slot floor (owner report, live 2026-08-26/27): the stored release_time for
 * an AMC name is frequently the CALL time, not the print time (the CRWD/RBRK
 * trap — a vendor/web "17:00" is the 5 PM call). Accepting a print-watch line
 * at 16:12 ET was refused as "still in the future" against that fiction.
 * With useSlotFloor the guard asks the only question that is actually
 * knowable ahead of the wire: has the slot's window opened at all — 16:00 ET
 * for an after-close print, 07:00 ET for a before-open one.
 *
 * All ET instants below are August/November EDT (UTC-4) unless noted.
 */
describe("checkPrePrintFloor — slot floor", () => {
  // A dominant-path vendor row: event_time NULL, slot only in raw_json,
  // release_time carrying the suspect 17:00 call time.
  const amcVendorRow = {
    event_date: "2026-08-27",
    release_time: "17:00",
    event_time: null,
    raw_json: JSON.stringify({ entry: { hour: "amc" } }),
  };

  it("blocks an AMC accept one minute before the 16:00 ET floor", () => {
    const now = new Date("2026-08-27T19:59:00Z"); // 15:59 ET
    const r = checkPrePrintFloor(amcVendorRow, now, { useSlotFloor: true });
    expect(r.isPrePrint).toBe(true);
    expect(r.basis).toBe("slot");
    expect(r.slot).toBe("amc");
    expect(r.floor?.toISOString()).toBe("2026-08-27T20:00:00.000Z"); // 16:00 ET
    // release still carries the composed release_time instant for messaging
    expect(r.release?.toISOString()).toBe("2026-08-27T21:00:00.000Z"); // 17:00 ET
  });

  it("passes an AMC accept exactly at the 16:00 ET floor", () => {
    const now = new Date("2026-08-27T20:00:00Z"); // 16:00 ET
    const r = checkPrePrintFloor(amcVendorRow, now, { useSlotFloor: true });
    expect(r.isPrePrint).toBe(false);
    expect(r.basis).toBe("slot");
    expect(r.slot).toBe("amc");
  });

  it("passes the live 16:12 ET repro that the 17:00 release_time refused", () => {
    const now = new Date("2026-08-27T20:12:00Z"); // 16:12 ET
    expect(
      checkPrePrintFloor(amcVendorRow, now, { useSlotFloor: true }).isPrePrint,
    ).toBe(false);
  });

  it("reads an explicit AMC event_time marker the same way as raw_json", () => {
    const now = new Date("2026-08-27T20:12:00Z"); // 16:12 ET
    const r = checkPrePrintFloor(
      { event_date: "2026-08-27", release_time: "17:00", event_time: "AMC", raw_json: null },
      now,
      { useSlotFloor: true },
    );
    expect(r.isPrePrint).toBe(false);
    expect(r.slot).toBe("amc");
  });

  const bmoVendorRow = {
    event_date: "2026-08-27",
    release_time: "08:00",
    event_time: null,
    raw_json: JSON.stringify({ entry: { hour: "bmo" } }),
  };

  it("blocks a BMO accept one minute before the 07:00 ET floor", () => {
    const now = new Date("2026-08-27T10:59:00Z"); // 06:59 ET
    const r = checkPrePrintFloor(bmoVendorRow, now, { useSlotFloor: true });
    expect(r.isPrePrint).toBe(true);
    expect(r.basis).toBe("slot");
    expect(r.slot).toBe("bmo");
    expect(r.floor?.toISOString()).toBe("2026-08-27T11:00:00.000Z"); // 07:00 ET
  });

  it("passes a BMO accept exactly at the 07:00 ET floor, an hour before release_time", () => {
    const now = new Date("2026-08-27T11:00:00Z"); // 07:00 ET
    const r = checkPrePrintFloor(bmoVendorRow, now, { useSlotFloor: true });
    expect(r.isPrePrint).toBe(false);
    expect(r.basis).toBe("slot");
  });

  it("composes the floor DST-aware: an EST (November) AMC floor is 21:00Z", () => {
    const row = { ...amcVendorRow, event_date: "2026-11-05" };
    const r = checkPrePrintFloor(row, new Date("2026-11-05T20:59:00Z"), {
      useSlotFloor: true,
    });
    expect(r.floor?.toISOString()).toBe("2026-11-05T21:00:00.000Z"); // 16:00 EST
    expect(r.isPrePrint).toBe(true);
  });

  it("falls back to the release_time basis for a TAS row (no side of noon)", () => {
    const tasRow = {
      event_date: "2026-08-27",
      release_time: "17:00",
      event_time: "TAS",
      raw_json: JSON.stringify({ entry: { hour: "amc" } }),
    };
    const r = checkPrePrintFloor(tasRow, new Date("2026-08-27T20:12:00Z"), {
      useSlotFloor: true,
    });
    expect(r.slot).toBeNull();
    expect(r.basis).toBe("release_time");
    expect(r.isPrePrint).toBe(true); // 16:12 ET is still before the 17:00 release
    expect(r.floor).toBeNull();
  });

  it("reports basis 'none' when neither a slot nor a release instant resolves", () => {
    const r = checkPrePrintFloor(
      { event_date: "2026-08-27", release_time: null, event_time: null, raw_json: null },
      new Date("2026-08-27T20:12:00Z"),
      { useSlotFloor: true },
    );
    expect(r.isPrePrint).toBe(false);
    expect(r.basis).toBe("none");
    expect(r.slot).toBeNull();
    expect(r.floor).toBeNull();
  });

  it("without useSlotFloor the 17:00 release_time still blocks a 16:12 ET save (unchanged default)", () => {
    const r = checkPrePrintFloor(amcVendorRow, new Date("2026-08-27T20:12:00Z"));
    expect(r.isPrePrint).toBe(true);
    expect(r.basis).toBe("release_time");
    expect(r.floor).toBeNull();
    expect(r.release?.toISOString()).toBe("2026-08-27T21:00:00.000Z");
  });

  it("without useSlotFloor a known slot is still reported, but never used as the floor", () => {
    const r = checkPrePrintFloor(bmoVendorRow, new Date("2026-08-27T11:30:00Z")); // 07:30 ET
    expect(r.slot).toBe("bmo");
    expect(r.basis).toBe("release_time");
    expect(r.isPrePrint).toBe(true); // 08:00 release_time still in the future
  });
});

describe("describePrePrintFloor", () => {
  const now = new Date("2026-08-27T19:30:00Z"); // 15:30 ET

  it("names the 4:00 PM ET window for an AMC slot floor", () => {
    const r = checkPrePrintFloor(
      { event_date: "2026-08-27", release_time: "17:00", event_time: "AMC" },
      now,
      { useSlotFloor: true },
    );
    const msg = describePrePrintFloor("2026-08-27", r, now);
    expect(msg).toMatch(/after-close print/);
    expect(msg).toContain("4:00 PM ET");
    expect(msg).toContain("Aug 27, 2026");
    // Same-day click: the "now" label is a time only, no second date.
    expect(msg).toContain("(now 3:30 PM ET)");
  });

  it("names the 7:00 AM ET window for a BMO slot floor, dating 'now' when it is another day", () => {
    const r = checkPrePrintFloor(
      { event_date: "2026-08-27", release_time: "08:00", event_time: "BMO" },
      now,
      { useSlotFloor: true },
    );
    // "now" is 2026-08-27 in ET but the print is dated a day later here, so
    // the label must carry the date — a click a day early cannot be allowed
    // to read as "any minute now".
    const msg = describePrePrintFloor("2026-08-28", r, now);
    expect(msg).toMatch(/before-open print/);
    expect(msg).toContain("7:00 AM ET");
    expect(msg).toContain("Aug 27, 2026, 3:30 PM ET");
  });

  it("names the recorded release instant on the release_time basis", () => {
    const r = checkPrePrintFloor(
      { event_date: "2026-08-27", release_time: "17:00", event_time: "TAS" },
      now,
      { useSlotFloor: true },
    );
    expect(r.basis).toBe("release_time");
    const msg = describePrePrintFloor("2026-08-27", r, now);
    expect(msg).toContain("Aug 27, 2026, 5:00 PM ET");
    expect(msg).toMatch(/still in the future/);
  });

  it("still forms a sentence when no anchor could be composed", () => {
    const r = checkPrePrintFloor({ event_date: "2026-08-27", release_time: null }, now);
    expect(r.basis).toBe("none");
    expect(describePrePrintFloor("2026-08-27", r, now)).toMatch(
      /does not look to have happened yet/,
    );
  });
});
