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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ release_dates: releaseDates }),
    })),
  );
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
});

// A source OUTAGE is not "the source no longer lists it". An empty answer
// from a failed request used to look exactly like a successful empty one, so
// the sync's orphan cleanup deleted the week's stored releases and reported
// them as dropped by the source. A failed or impossible request now throws;
// the sync's existing catch takes the upsert-only fallback road.
describe("fetchMacroEvents — a failed source request is an error, not an empty schedule", () => {
  it("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string) => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    await expect(fetchMacroEvents(START, END, WEEK)).rejects.toThrow(/FRED.*503/);
  });

  it("throws when the source key is not configured", async () => {
    delete process.env.FRED_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchMacroEvents(START, END, WEEK)).rejects.toThrow(/FRED_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still returns an empty FRED list for a successful response that lists nothing tracked", async () => {
    stubFred([]);
    const events = await fetchMacroEvents(START, END, WEEK);
    expect(events.some((e) => e.source_key.startsWith("fred:"))).toBe(false);
  });
});
