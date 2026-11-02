import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dropRevisionSecondDates,
  fetchMacroEvents,
  reportingPeriodKey,
} from "@/lib/calendar/macro-events";

/**
 * Owner ruling 2026-11-01, item 4
 * [qa:today-releases--monthly-fred-release-duplicated-two-dates-not-superseded]:
 * FRED release 27 (Housing Starts) lists two dates a month; the later is the
 * Census revision slot and carries no new observation. The sync keeps only
 * the earliest date per reporting period for a release flagged
 * `revisionSecondDate`. JOLTS (192) catch-up double prints stay.
 */

const HOUSING = { releaseId: 27, reportingLag: 1 as const, revisionSecondDate: true as const };
const JOLTS = { releaseId: 192, reportingLag: 2 as const };

describe("reportingPeriodKey", () => {
  it("carries the year, so December data reported in January is the previous year", () => {
    expect(reportingPeriodKey("2027-01-20", 1)).toBe("2026-12");
    expect(reportingPeriodKey("2026-12-17", 1)).toBe("2026-11");
    expect(reportingPeriodKey("2026-10-20", 1)).toBe("2026-09");
    expect(reportingPeriodKey("2026-02-03", 2)).toBe("2025-12");
    expect(reportingPeriodKey("2026-01-29", "quarterly")).toBe("2025-Q4");
    expect(reportingPeriodKey("2026-07-30", "quarterly")).toBe("2026-Q2");
    expect(reportingPeriodKey("2026-07-30", "weekly")).toBeNull();
  });
});

describe("dropRevisionSecondDates", () => {
  it("keeps the earlier of two release-27 dates in one period", () => {
    const out = dropRevisionSecondDates([
      { date: "2026-10-27", config: HOUSING },
      { date: "2026-10-20", config: HOUSING },
    ]);
    expect(out.map((r) => r.date)).toEqual(["2026-10-20"]);
  });

  it("keeps release-27 dates of different periods", () => {
    const out = dropRevisionSecondDates([
      { date: "2026-10-20", config: HOUSING },
      { date: "2026-11-18", config: HOUSING },
    ]);
    expect(out.map((r) => r.date)).toEqual(["2026-10-20", "2026-11-18"]);
  });

  it("keeps BOTH dates of a release that is not flagged (JOLTS catch-up prints)", () => {
    const out = dropRevisionSecondDates([
      { date: "2026-11-03", config: JOLTS },
      { date: "2026-11-10", config: JOLTS },
    ]);
    expect(out.map((r) => r.date)).toEqual(["2026-11-03", "2026-11-10"]);
  });

  it("does not let a December/January year boundary collide", () => {
    // 2026-01-20 reports December 2025; 2026-12-29 reports November 2026;
    // 2027-01-20 reports December 2026. None share a period.
    const out = dropRevisionSecondDates([
      { date: "2026-01-20", config: HOUSING },
      { date: "2026-12-29", config: HOUSING },
      { date: "2027-01-20", config: HOUSING },
    ]);
    expect(out.map((r) => r.date)).toEqual(["2026-01-20", "2026-12-29", "2027-01-20"]);
  });
});

describe("fetchMacroEvents — the Housing Starts revision slot is not synced", () => {
  const savedFredKey = process.env.FRED_API_KEY;
  const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.FRED_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedFredKey === undefined) delete process.env.FRED_API_KEY;
    else process.env.FRED_API_KEY = savedFredKey;
    if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  });

  // A FRED stand-in that honours realtime_start/realtime_end like the real API.
  function stubFred(all: { release_id: number; release_name: string; date: string }[]) {
    const fetchMock = vi.fn(async (url: string) => {
      const u = new URL(url);
      const from = u.searchParams.get("realtime_start") ?? "";
      const to = u.searchParams.get("realtime_end") ?? "";
      return {
        ok: true,
        status: 200,
        json: async () => ({ release_dates: all.filter((d) => d.date >= from && d.date <= to) }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const SCHEDULE = [
    { release_id: 27, release_name: "New Residential Construction", date: "2026-10-20" },
    { release_id: 97, release_name: "New Residential Sales", date: "2026-10-24" },
    { release_id: 27, release_name: "New Residential Construction", date: "2026-10-27" },
    { release_id: 192, release_name: "Job Openings and Labor Turnover Survey", date: "2026-10-21" },
    { release_id: 192, release_name: "Job Openings and Labor Turnover Survey", date: "2026-10-28" },
  ];

  it("the week of the revision slot carries no 10-27 row, and the request was widened", async () => {
    const fetchMock = stubFred(SCHEDULE);
    const events = await fetchMacroEvents("2026-10-26", "2026-11-01", "2026-10-26");
    const keys = events.map((e) => e.source_key).filter((k) => k.startsWith("fred:"));
    expect(keys).not.toContain("fred:27:2026-10-27");
    // Nothing from before the week leaks into the answer.
    expect(keys).not.toContain("fred:27:2026-10-20");
    expect(keys).not.toContain("fred:97:2026-10-24");
    // JOLTS is not flagged: its in-week date stays.
    expect(keys).toContain("fred:192:2026-10-28");

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("realtime_start")).toBe("2026-10-05");
    expect(url.searchParams.get("realtime_end")).toBe("2026-11-01");
  });

  it("the week of the print still returns 10-20", async () => {
    stubFred(SCHEDULE);
    const events = await fetchMacroEvents("2026-10-19", "2026-10-25", "2026-10-19");
    const keys = events.map((e) => e.source_key).filter((k) => k.startsWith("fred:"));
    expect(keys).toEqual(
      expect.arrayContaining(["fred:27:2026-10-20", "fred:97:2026-10-24", "fred:192:2026-10-21"]),
    );
    expect(keys).not.toContain("fred:27:2026-10-27");
  });
});
