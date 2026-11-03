import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchMacroEvents } from "@/lib/calendar/macro-events";

/**
 * [qa:earnings-hub-refresh-from-finnhub-lib-calendar-sync-ts-macro-phase-lib-calendar-macro-events-ts-fetchfredrelea]
 *
 * FRED `releases/dates` lists every release of every series. The request is
 * widened 21 days back (revision-second-date rule), so a busy window holds
 * more rows than one page (limit 500). Sorted ascending, the first page can
 * end BEFORE the asked week: the asked week's releases are simply not in it.
 * That truncated answer is a SUCCESS, so it read as "the source dropped these
 * dates" and the sync deleted the week's FRED rows.
 *
 * Now the fetch pages with `offset` until `count` is exhausted (or a page
 * passes the asked week), and an answer that is still short of the week
 * throws (the sync's outage road: delete nothing, report the error).
 *
 * Synthetic schedule, mocked fetch, no network, no real key.
 */

type Row = { release_id: number; release_name: string; date: string };

const WEEK_START = "2026-11-02";
const WEEK_END = "2026-11-08";

// An untracked release id that fills the pages before the asked week.
const FILLER_ID = 999_001;

function buildSchedule(): Row[] {
  const rows: Row[] = [];
  // 600 filler rows dated inside the lookback, before the asked week.
  const lookbackDays = ["2026-10-12", "2026-10-15", "2026-10-20", "2026-10-26", "2026-10-29"];
  for (let i = 0; i < 600; i++) {
    rows.push({ release_id: FILLER_ID, release_name: "Filler Release", date: lookbackDays[i % lookbackDays.length] });
  }
  rows.push({ release_id: 192, release_name: "Job Openings and Labor Turnover Survey", date: "2026-11-03" });
  rows.push({ release_id: 50, release_name: "Employment Situation", date: "2026-11-06" });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

// A FRED stand-in honouring realtime_start/end, limit, offset and count.
function stubPagedFred(all: Row[], opts: { ignoreOffset?: boolean } = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url);
    const from = u.searchParams.get("realtime_start") ?? "";
    const to = u.searchParams.get("realtime_end") ?? "";
    const limit = Number(u.searchParams.get("limit") ?? "1000");
    const offset = opts.ignoreOffset ? 0 : Number(u.searchParams.get("offset") ?? "0");
    const inWindow = all.filter((d) => d.date >= from && d.date <= to);
    const page = opts.ignoreOffset && Number(u.searchParams.get("offset") ?? "0") > 0
      ? []
      : inWindow.slice(offset, offset + limit);
    return {
      ok: true,
      status: 200,
      json: async () => ({ count: inWindow.length, offset, limit, release_dates: page }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchMacroEvents — a FRED answer longer than one page", () => {
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

  it("pages with offset, and the asked week's tracked releases come back", async () => {
    const fetchMock = stubPagedFred(buildSchedule());
    const events = await fetchMacroEvents(WEEK_START, WEEK_END, WEEK_START);
    const keys = events.map((e) => e.source_key).filter((k) => k.startsWith("fred:"));
    expect(keys).toEqual(expect.arrayContaining(["fred:192:2026-11-03", "fred:50:2026-11-06"]));

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const offsets = fetchMock.mock.calls.map((c) => new URL(c[0] as string).searchParams.get("offset") ?? "0");
    expect(offsets[0]).toBe("0");
    expect(Number(offsets[1])).toBeGreaterThan(0);
    // The revision lookback is kept.
    const first = new URL(fetchMock.mock.calls[0][0] as string);
    expect(first.searchParams.get("realtime_start")).toBe("2026-10-12");
    expect(first.searchParams.get("realtime_end")).toBe(WEEK_END);
  });

  it("a truncated answer that cannot be paged throws instead of reading as no releases", async () => {
    stubPagedFred(buildSchedule(), { ignoreOffset: true });
    await expect(fetchMacroEvents(WEEK_START, WEEK_END, WEEK_START)).rejects.toThrow(/truncated|incomplete/i);
  });

  it("an answer with no count field and one short page is taken as complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          release_dates: [{ release_id: 192, release_name: "Job Openings and Labor Turnover Survey", date: "2026-11-03" }],
        }),
      })),
    );
    const events = await fetchMacroEvents(WEEK_START, WEEK_END, WEEK_START);
    expect(events.map((e) => e.source_key)).toContain("fred:192:2026-11-03");
  });
});
