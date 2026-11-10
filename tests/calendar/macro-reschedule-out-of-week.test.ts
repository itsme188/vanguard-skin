import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * [qa:dashboard-today-refresh-from-finnhub-macro-step-week-ahead-nov-9-15-and-nov-2-8-refresh-deletes-the-november-u]
 *
 * A non-FRED release (UMich preliminary) that the publisher moved OUT of the
 * week being synced used to be skipped ("next week's sync will pick it up").
 * The other week never did: its fetch filters the schedule by the ORIGINAL
 * date. The release vanished from both weeks. It is now emitted on its new
 * date, under the new date's source_key, filed under the new date's Monday.
 */

const mockCreate = vi.fn();
vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  return { ...actual, getRawAnthropicClient: vi.fn(() => ({ messages: { create: mockCreate } })) };
});

import { fetchMacroEvents } from "@/lib/calendar/macro-events";

const savedFred = process.env.FRED_API_KEY;
const savedAnthropic = process.env.ANTHROPIC_API_KEY;

function verifierSays(items: unknown[]) {
  mockCreate.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(items) }] });
}

beforeEach(() => {
  process.env.FRED_API_KEY = "test-key";
  process.env.ANTHROPIC_API_KEY = "test-not-a-real-key";
  mockCreate.mockReset();
  // FRED answers with no releases, so the only rows are the hardcoded ones.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ release_dates: [] }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedFred === undefined) delete process.env.FRED_API_KEY;
  else process.env.FRED_API_KEY = savedFred;
  if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropic;
});

describe("fetchMacroEvents — a release rescheduled out of the week", () => {
  it("is emitted on the new date with the new key and the new week's Monday", async () => {
    // Week 2026-11-09..15 holds one non-FRED entry: UMich preliminary on 11-13.
    verifierSays([
      {
        index: 1,
        status: "rescheduled",
        newDate: "2026-11-06",
        sourceUrl: "https://data.sca.isr.umich.edu/schedule.php",
        note: "Moved a week earlier",
      },
    ]);
    const events = await fetchMacroEvents("2026-11-09", "2026-11-15", "2026-11-09");
    const umich = events.filter((e) => e.source_key.startsWith("nonfred:U._of_Michigan_Consumer_Sentiment_(Preliminary):"));
    expect(umich).toHaveLength(1);
    const row = umich[0];
    expect(row.event_date).toBe("2026-11-06");
    expect(row.source_key.endsWith(":2026-11-06")).toBe(true);
    expect(row.week_of).toBe("2026-11-02");
    const raw = JSON.parse(row.raw_json ?? "{}");
    expect(raw.verify_status).toBe("rescheduled");
    expect(raw.original_date).toBe("2026-11-13");
    expect(raw.source_url).toBe("https://data.sca.isr.umich.edu/schedule.php");
  });

  it("an in-week reschedule still lands in the synced week", async () => {
    verifierSays([{ index: 1, status: "rescheduled", newDate: "2026-11-12" }]);
    const events = await fetchMacroEvents("2026-11-09", "2026-11-15", "2026-11-09");
    const umich = events.filter((e) => e.source_key.startsWith("nonfred:U._of_Michigan_Consumer_Sentiment_(Preliminary):"));
    expect(umich.map((e) => [e.event_date, e.week_of])).toEqual([["2026-11-12", "2026-11-09"]]);
  });
});
