import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchMacroEvents } from "@/lib/calendar/macro-events";

/**
 * Owner ruling 2026-10-06
 * [qa:today-earningshub-refresh--deletes-scheduled-macro-release-never-recreated]:
 * FRED release 291 (Existing Home Sales) is no longer tracked — the source
 * stopped publishing dates for it, so a row for it could never be re-created
 * once cleaned up. No hand-maintained schedule replaces it.
 *
 * FRED's `releases/dates` answers one request with every release in the
 * window; tracking is the filter applied to that answer. So "no longer
 * fetched or created" is pinned here: even when the source DOES list 291, no
 * calendar row is built for it.
 */

const WEEK = "2026-04-20";
const START = "2026-04-20";
const END = "2026-04-26";

const savedFredKey = process.env.FRED_API_KEY;
const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.FRED_API_KEY = "test-key";
  // No AI key: titles fall back to "<period> <short name>", no network call.
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedFredKey === undefined) delete process.env.FRED_API_KEY;
  else process.env.FRED_API_KEY = savedFredKey;
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
});

function stubFred(releaseDates: { release_id: number; release_name: string; date: string }[]) {
  const fetchMock = vi.fn(async (_url: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ release_dates: releaseDates }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchMacroEvents — tracked FRED releases", () => {
  it("builds no row for release 291 even when the source lists it", async () => {
    stubFred([
      { release_id: 291, release_name: "Existing Home Sales", date: "2026-04-22" },
      { release_id: 97, release_name: "New Residential Sales", date: "2026-04-23" },
    ]);

    const events = await fetchMacroEvents(START, END, WEEK);

    const keys = events.map((e) => e.source_key);
    expect(keys.some((k) => k.startsWith("fred:291:"))).toBe(false);
    expect(events.some((e) => /existing home sales/i.test(e.title))).toBe(false);
    // The neighbouring housing release is still tracked.
    expect(keys).toContain("fred:97:2026-04-23");
  });

  it("asks the source for the window once, not per release", async () => {
    const fetchMock = stubFred([]);

    await fetchMacroEvents(START, END, WEEK);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/fred/releases/dates");
    expect(url).not.toContain("291");
  });
});
