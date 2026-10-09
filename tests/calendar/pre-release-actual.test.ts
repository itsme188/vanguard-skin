import { describe, it, expect } from "vitest";
import {
  isPreReleaseActual,
  preReleaseActualChipText,
  type PreReleaseActualInput,
} from "@/lib/calendar/pre-release-actual";
import { checkPrePrintFloor } from "@/lib/earnings/pre-print-floor";

// QA finding (HIGH, owner ruling 2026-10-06, Option 1 display-only): a
// manually saved actual rendered as plain fact hours before the release it
// belongs to. Synthetic figures only.

// 2026-10-07 is EDT (UTC-4): 16:00 ET = 20:00Z, 07:00 ET = 11:00Z.
const at = (iso: string) => new Date(iso);

function row(over: Partial<PreReleaseActualInput> = {}): PreReleaseActualInput {
  return {
    event_type: "earnings",
    event_date: "2026-10-07",
    event_time: "AMC",
    release_time: "16:05",
    raw_json: null,
    actual_value: "EPS 1.23 · Rev 4560000000",
    ...over,
  };
}

describe("isPreReleaseActual", () => {
  it("AMC: true before the 16:00 ET slot floor, false from 16:00 ET on", () => {
    expect(isPreReleaseActual(row(), at("2026-10-07T13:00:00Z"))).toBe(true);
    expect(isPreReleaseActual(row(), at("2026-10-07T19:59:00Z"))).toBe(true);
    expect(isPreReleaseActual(row(), at("2026-10-07T20:00:00Z"))).toBe(false);
    expect(isPreReleaseActual(row(), at("2026-10-07T20:01:00Z"))).toBe(false);
  });

  it("BMO: true before 07:00 ET, false from 07:00 ET on", () => {
    const bmo = row({ event_time: "BMO", release_time: "08:30" });
    expect(isPreReleaseActual(bmo, at("2026-10-07T10:59:00Z"))).toBe(true);
    expect(isPreReleaseActual(bmo, at("2026-10-07T11:00:00Z"))).toBe(false);
  });

  it("reads the vendor slot from raw_json when event_time is null", () => {
    const vendor = row({
      event_time: null,
      release_time: "16:15",
      raw_json: JSON.stringify({ entry: { hour: "amc" } }),
    });
    expect(isPreReleaseActual(vendor, at("2026-10-07T19:30:00Z"))).toBe(true);
    expect(isPreReleaseActual(vendor, at("2026-10-07T20:00:00Z"))).toBe(false);
  });

  it("an AMC release_time later than the floor (a call time) never pushes the instant later", () => {
    const callTime = row({ release_time: "17:00" });
    expect(isPreReleaseActual(callTime, at("2026-10-07T20:10:00Z"))).toBe(false);
  });

  it("an explicit HH:MM release_time earlier than the AMC floor does not pull the instant earlier", () => {
    const early = row({ release_time: "12:00" });
    expect(isPreReleaseActual(early, at("2026-10-07T17:00:00Z"))).toBe(true);
  });

  it("a null or empty actual is never pre-release", () => {
    expect(isPreReleaseActual(row({ actual_value: null }), at("2026-10-07T13:00:00Z"))).toBe(false);
    expect(isPreReleaseActual(row({ actual_value: "" }), at("2026-10-07T13:00:00Z"))).toBe(false);
  });

  it("a past event date is never pre-release; a future date always is", () => {
    expect(isPreReleaseActual(row({ event_date: "2026-10-06" }), at("2026-10-07T13:00:00Z"))).toBe(false);
    expect(isPreReleaseActual(row({ event_date: "2026-10-08", event_time: null, release_time: null }), at("2026-10-07T23:00:00Z"))).toBe(true);
  });

  it("is ET-anchored: 23:30 ET on the event date is past the AMC floor even though UTC is the next day", () => {
    expect(isPreReleaseActual(row(), at("2026-10-08T03:30:00Z"))).toBe(false);
    // ...and 21:00 ET the day before (01:00Z on the event date) is still pre-release.
    expect(isPreReleaseActual(row(), at("2026-10-07T01:00:00Z"))).toBe(true);
  });

  it("no slot: falls back to an explicit HH:MM release_time, else trusts the row on its own date", () => {
    const tas = row({ event_time: "TAS", release_time: "12:00" });
    expect(isPreReleaseActual(tas, at("2026-10-07T15:59:00Z"))).toBe(true);
    expect(isPreReleaseActual(tas, at("2026-10-07T16:00:00Z"))).toBe(false);
    const none = row({ event_time: null, release_time: null });
    expect(isPreReleaseActual(none, at("2026-10-07T13:00:00Z"))).toBe(false);
  });

  it("macro events are out of scope (no BMO/AMC slot to floor on)", () => {
    expect(isPreReleaseActual(row({ event_type: "macro", event_time: "08:30" }), at("2026-10-07T11:00:00Z"))).toBe(false);
  });

  // Parity pin. It covers every row WITHOUT a usual-side estimate attached,
  // which is every row the save path ever sees. The one carve-out is the
  // display path below ("usual side"): a screen may attach the company's
  // usual side to a slot-less row, and the chip then follows that side while
  // the save floor keeps reading the stored time. Do not widen the carve-out.
  it("agrees with the save-path slot floor (checkPrePrintFloor useSlotFloor) on its own date", () => {
    const cases: Array<[Partial<PreReleaseActualInput>, string]> = [
      [{}, "2026-10-07T19:59:00Z"],
      [{}, "2026-10-07T20:00:00Z"],
      [{ event_time: "BMO", release_time: "08:30" }, "2026-10-07T10:59:00Z"],
      [{ event_time: "BMO", release_time: "08:30" }, "2026-10-07T11:00:00Z"],
      [{ event_time: "TAS", release_time: "12:00" }, "2026-10-07T15:59:00Z"],
      [{ event_time: "TAS", release_time: "12:00" }, "2026-10-07T16:00:00Z"],
    ];
    for (const [over, iso] of cases) {
      const r = row(over);
      const floor = checkPrePrintFloor(
        { event_date: r.event_date, release_time: r.release_time, event_time: r.event_time, raw_json: r.raw_json },
        at(iso),
        { useSlotFloor: true },
      );
      expect(isPreReleaseActual(r, at(iso)), `${JSON.stringify(over)} @ ${iso}`).toBe(floor.isPrePrint);
    }
  });
});

// Owner decision taken on recommendation 2026-10-08 (display only, the same
// shape as the 2026-10-06 slot-less ruling): a vendor row with no slot stores
// the 16:15 default, so a figure typed in after a before-the-open print stayed
// "pre-release" all day. When the screen has worked out the company's usual
// side for that row, the chip clears at that side's window instead.
describe("isPreReleaseActual: a slot-less row follows the company's usual side (display only)", () => {
  // What the sync stores for a vendor row with no slot.
  const slotless = (over: Partial<PreReleaseActualInput> = {}) =>
    row({ event_time: null, release_time: "16:15", raw_json: JSON.stringify({ entry: { hour: null } }), ...over });

  it("with no usual side attached, the stored 16:15 default still decides", () => {
    expect(isPreReleaseActual(slotless(), at("2026-10-07T12:00:00Z"))).toBe(true); // 08:00 ET
    expect(isPreReleaseActual(slotless(), at("2026-10-07T20:14:00Z"))).toBe(true);
    expect(isPreReleaseActual(slotless(), at("2026-10-07T20:15:00Z"))).toBe(false);
    const nullSide = slotless({ display_time: { slot: null } });
    expect(isPreReleaseActual(nullSide, at("2026-10-07T12:00:00Z"))).toBe(true);
    expect(isPreReleaseActual(slotless({ display_time: {} }), at("2026-10-07T12:00:00Z"))).toBe(true);
  });

  it("usual side before the open: clears at 07:00 ET, not at 16:15", () => {
    const r = slotless({ display_time: { slot: "bmo" } });
    expect(isPreReleaseActual(r, at("2026-10-07T10:59:00Z"))).toBe(true);
    expect(isPreReleaseActual(r, at("2026-10-07T11:00:00Z"))).toBe(false);
    expect(isPreReleaseActual(r, at("2026-10-07T12:00:00Z"))).toBe(false);
  });

  it("usual side after the close: clears at 16:00 ET like any after-close row", () => {
    const r = slotless({ display_time: { slot: "amc" } });
    expect(isPreReleaseActual(r, at("2026-10-07T19:59:00Z"))).toBe(true);
    expect(isPreReleaseActual(r, at("2026-10-07T20:00:00Z"))).toBe(false);
  });

  it("a real slot on the row always wins over an attached usual side", () => {
    const amc = row({ display_time: { slot: "bmo" } }); // event_time AMC
    expect(isPreReleaseActual(amc, at("2026-10-07T12:00:00Z"))).toBe(true);
    const vendorBmo = slotless({
      raw_json: JSON.stringify({ entry: { hour: "bmo" } }),
      display_time: { slot: "amc" },
    });
    expect(isPreReleaseActual(vendorBmo, at("2026-10-07T12:00:00Z"))).toBe(false);
  });

  it("the usual side never reaches a later or an earlier date", () => {
    const r = slotless({ display_time: { slot: "bmo" } });
    expect(isPreReleaseActual({ ...r, event_date: "2026-10-08" }, at("2026-10-07T12:00:00Z"))).toBe(true);
    expect(isPreReleaseActual({ ...r, event_date: "2026-10-06" }, at("2026-10-07T09:00:00Z"))).toBe(false);
  });

  it("THE CARVE-OUT: the save floor has no usual-side input and keeps the stored time", () => {
    const r = slotless({ display_time: { slot: "bmo" } });
    const now = at("2026-10-07T12:00:00Z"); // 08:00 ET, after a before-the-open print
    // The whole row, estimate included, goes to the save floor: it must not read it.
    const floor = checkPrePrintFloor(r, now, { useSlotFloor: true });
    expect(floor.basis).toBe("release_time");
    expect(floor.slot).toBeNull();
    expect(floor.isPrePrint).toBe(true); // still asks for the confirmation until 16:15
    expect(isPreReleaseActual(r, now)).toBe(false); // the screen alone un-mutes
  });
});

describe("preReleaseActualChipText", () => {
  it("names a manual entry as such, and says only pre-release otherwise", () => {
    expect(preReleaseActualChipText("2026-10-07 09:00:00")).toBe("pre-release · entered manually");
    expect(preReleaseActualChipText(null)).toBe("pre-release");
  });
});
