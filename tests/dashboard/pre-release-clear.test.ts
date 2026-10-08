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
