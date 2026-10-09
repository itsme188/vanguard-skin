import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isPreReleaseActual, type PreReleaseActualInput } from "@/lib/calendar/pre-release-actual";
import { preReleaseClearsAtMs } from "@/app/dashboard/today/pre-release-clear";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// 2026-10-07 is EDT (UTC-4): 16:00 ET = 20:00Z, 07:00 ET = 11:00Z.
function row(over: Partial<PreReleaseActualInput> = {}): PreReleaseActualInput {
  return {
    event_type: "earnings",
    event_date: "2026-10-07",
    event_time: "AMC",
    release_time: "16:05",
    raw_json: null,
    actual_value: "EPS 1.23",
    ...over,
  };
}

describe("preReleaseClearsAtMs", () => {
  it("AMC: lands just after 16:00 ET and agrees with isPreReleaseActual on both sides", () => {
    const now = new Date("2026-10-07T19:30:20Z");
    const at = preReleaseClearsAtMs(row(), now)!;
    expect(at).toBeGreaterThan(new Date("2026-10-07T20:00:00Z").getTime());
    expect(at).toBeLessThan(new Date("2026-10-07T20:00:01Z").getTime());
    expect(isPreReleaseActual(row(), new Date(at - 1000))).toBe(true);
    expect(isPreReleaseActual(row(), new Date(at))).toBe(false);
  });

  it("BMO uses the 07:00 ET floor", () => {
    const at = preReleaseClearsAtMs(row({ event_time: "BMO" }), new Date("2026-10-07T10:00:00Z"))!;
    expect(isPreReleaseActual(row({ event_time: "BMO" }), new Date(at))).toBe(false);
    expect(at - new Date("2026-10-07T10:00:00Z").getTime()).toBeLessThan(3_600_000 + 1000);
  });

  it("null when not pre-release, after the floor, with no actual, or for a later day", () => {
    expect(preReleaseClearsAtMs(row(), new Date("2026-10-07T20:30:00Z"))).toBeNull();
    expect(preReleaseClearsAtMs(row({ actual_value: null }), new Date("2026-10-07T13:00:00Z"))).toBeNull();
    expect(preReleaseClearsAtMs(row({ event_date: "2026-10-09" }), new Date("2026-10-07T13:00:00Z"))).toBeNull();
  });

  it("no slot, explicit release_time: that time is the floor", () => {
    const r = row({ event_time: null, release_time: "09:30" });
    const at = preReleaseClearsAtMs(r, new Date("2026-10-07T12:00:00Z"))!; // 08:00 ET
    expect(isPreReleaseActual(r, new Date(at))).toBe(false);
    expect(isPreReleaseActual(r, new Date(at - 1000))).toBe(true);
  });
});

// Display only (decision 2026-10-08): a slot-less row carrying the company's
// usual side clears at that side's window; the timer must agree with the chip.
describe("preReleaseClearsAtMs: slot-less row with a usual side attached", () => {
  const slotless = (over: Partial<PreReleaseActualInput> = {}) =>
    row({ event_time: null, release_time: "16:15", raw_json: null, ...over });

  it("usual side before the open: the timer lands just after 07:00 ET", () => {
    const r = slotless({ display_time: { slot: "bmo" } });
    const at = preReleaseClearsAtMs(r, new Date("2026-10-07T10:30:10Z"))!;
    expect(at).toBeGreaterThan(new Date("2026-10-07T11:00:00Z").getTime());
    expect(at).toBeLessThan(new Date("2026-10-07T11:00:01Z").getTime());
    expect(isPreReleaseActual(r, new Date(at - 1000))).toBe(true);
    expect(isPreReleaseActual(r, new Date(at))).toBe(false);
    expect(preReleaseClearsAtMs(r, new Date("2026-10-07T12:00:00Z"))).toBeNull();
  });

  it("usual side after the close: 16:00 ET, not the stored 16:15", () => {
    const r = slotless({ display_time: { slot: "amc" } });
    const at = preReleaseClearsAtMs(r, new Date("2026-10-07T19:30:00Z"))!;
    expect(at).toBeLessThan(new Date("2026-10-07T20:00:01Z").getTime());
    expect(isPreReleaseActual(r, new Date(at))).toBe(false);
  });

  it("no usual side: the stored 16:15 still sets the timer", () => {
    const at = preReleaseClearsAtMs(slotless(), new Date("2026-10-07T12:00:00Z"))!;
    expect(at).toBeGreaterThan(new Date("2026-10-07T20:15:00Z").getTime());
    expect(at).toBeLessThan(new Date("2026-10-07T20:15:01Z").getTime());
  });

  it("the timer and the chip read ONE floor (no second copy of the rule)", () => {
    const src = readFileSync("app/dashboard/today/pre-release-clear.ts", "utf8");
    expect(src).toContain("preReleaseFloorET(row)");
    expect(src).not.toContain("deriveEarningsSlot");
  });
});

describe("the three Today surfaces hand the usual side to the chip", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  it("Today releases and the Hub pass the whole row, which carries display_time", () => {
    const releases = read("app/dashboard/components/TodayReleases.tsx");
    expect(releases).toContain("type DisplayedEvent = CalendarEvent & { display_time?: EarningsDisplayTime };");
    expect(releases).toContain("isPreReleaseActual(event)");
    expect(releases).toContain("preReleaseClearsAtMs(r, now)");
    const hub = read("app/dashboard/today/EarningsHub.tsx");
    expect(hub).toContain("display_time: EarningsDisplayTime;");
    expect(hub).toContain("isPreReleaseActual(event)");
    expect(hub).toContain("preReleaseClearsAtMs(event)");
  });
  it("the week card's chip colour passes it through its hand-built row", () => {
    const week = read("app/dashboard/today/WeekAheadView.tsx");
    const at = anchorIndex(week, "export function actualChipClass(");
    const body = week.slice(at, anchorIndex(week, "return PRE_RELEASE_ACTUAL_CHIP_CLASS;", at));
    expect(body).toContain("display_time: event.display_time");
  });
});

describe("pre-release chip timer wiring (source pins)", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  it("the hook sets one timer and cleans it up", () => {
    const src = read("app/dashboard/today/use-pre-release-clear.ts");
    expect(src).toContain("setTimeout(");
    expect(src).toContain("clearTimeout(id)");
  });
  it("EarningsRowChips gates the title through the hook", () => {
    const src = read("app/dashboard/today/EarningsRowChips.tsx");
    expect(src).toContain("usePreReleaseActive(preReleaseActualTitleProp !== null, preReleaseClearsAtMs)");
    expect(src).toContain("const preReleaseActualTitle = stillPreRelease ? preReleaseActualTitleProp : null;");
  });
  it("TodayReleases re-arms one timer for the soonest window and cleans it up", () => {
    const src = read("app/dashboard/components/TodayReleases.tsx");
    const at = anchorIndex(src, "const [tick, setTick] = useState(0);");
    const effect = src.slice(at, anchorIndex(src, "}, [releases, tick]);", at));
    expect(effect).toContain("preReleaseClearsAtMs(r, now)");
    expect(effect).toContain("setTimeout(");
    expect(effect).toContain("clearTimeout(id)");
  });
});

describe("date-correction note and hub upcoming time", () => {
  it("note expires on a timer and on a week change", () => {
    const src = readFileSync("app/dashboard/today/EarningsHubDateCorrectionNote.tsx", "utf8");
    expect(src).toContain("CORRECTION_NOTE_TTL_MS");
    expect(src).toContain("clearTimeout(id)");
    expect(src).toContain("note.weekOf !== weekOf");
  });
  it("security hub upcoming row prints displayEarningsTime for earnings", () => {
    const src = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");
    expect(src).toContain('import { displayEarningsTime } from "@/lib/calendar/display-earnings-time"');
    expect(src).toContain('event.event_type === "earnings" && (');
    expect(src).toContain("displayEarningsTime(db, event).label");
  });
});
