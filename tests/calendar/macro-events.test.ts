import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  releaseNameMatches,
  verifyNonFredReschedules,
} from "@/lib/calendar/macro-events";

describe("releaseNameMatches", () => {
  it("matches when a keyword is present (case-insensitive)", () => {
    expect(releaseNameMatches("Employment Situation", ["Employment Situation"])).toBe(true);
    expect(releaseNameMatches("EMPLOYMENT situation", ["Employment Situation"])).toBe(true);
  });

  it("matches when any one of multiple keywords is present", () => {
    expect(
      releaseNameMatches("Manufacturer's Shipments, Inventories, and Orders (M3) Survey", ["Manufacturer", "M3"])
    ).toBe(true);
  });

  it("rejects when no keyword matches — guards against FRED ID drift", () => {
    // Scenario: FRED release 13 returns "G.17 Industrial Production" but our
    // config previously (incorrectly) mapped 13 → Retail Sales. The guard
    // must reject so we don't mislabel Industrial Production as Retail Sales.
    expect(
      releaseNameMatches("G.17 Industrial Production and Capacity Utilization", ["Retail"])
    ).toBe(false);
  });

  it("rejects empty keyword list (no possible match)", () => {
    expect(releaseNameMatches("Anything", [])).toBe(false);
  });
});

describe("verifyNonFredReschedules", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    // Ensure we have a key so the function attempts the call and hits mocks
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it("returns empty map when no events given (short-circuit, no API call)", async () => {
    const result = await verifyNonFredReschedules([]);
    expect(result.size).toBe(0);
  });

  it("returns empty map when ANTHROPIC_API_KEY missing (graceful skip)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await verifyNonFredReschedules([
      { date: "2026-05-01", shortName: "ISM Manufacturing", eventType: "pmi", defaultImpact: "high", reportingLag: 1, releaseTime: "10:00" },
    ]);
    expect(result.size).toBe(0);
  });

  it("falls back to empty map (→ hardcoded dates used) when Claude call throws", async () => {
    // Mock Anthropic constructor to throw on messages.create
    vi.doMock("@anthropic-ai/sdk", () => {
      return {
        default: class MockAnthropic {
          messages = {
            create: vi.fn().mockRejectedValue(new Error("network timeout")),
          };
        },
      };
    });

    // Re-import with the mock in place
    vi.resetModules();
    const mod = await import("@/lib/calendar/macro-events");
    const result = await mod.verifyNonFredReschedules([
      { date: "2026-05-01", shortName: "ISM Manufacturing", eventType: "pmi", defaultImpact: "high", reportingLag: 1, releaseTime: "10:00" },
    ]);
    expect(result.size).toBe(0); // caller treats empty map as "use hardcoded"
  });

  it("applies reschedule when Claude returns a valid new date", async () => {
    vi.doMock("@anthropic-ai/sdk", () => {
      return {
        default: class MockAnthropic {
          messages = {
            create: vi.fn().mockResolvedValue({
              content: [
                {
                  type: "text",
                  text: JSON.stringify([
                    {
                      index: 1,
                      status: "rescheduled",
                      newDate: "2026-05-05",
                      sourceUrl: "https://www.ismworld.org/calendar",
                      note: "ISM rescheduled due to system maintenance",
                    },
                  ]),
                },
              ],
            }),
          };
        },
      };
    });

    vi.resetModules();
    const mod = await import("@/lib/calendar/macro-events");
    const result = await mod.verifyNonFredReschedules([
      { date: "2026-05-01", shortName: "ISM Manufacturing", eventType: "pmi", defaultImpact: "high", reportingLag: 1, releaseTime: "10:00" },
    ]);

    const entry = result.get("2026-05-01:ISM Manufacturing");
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("rescheduled");
    expect(entry?.newDate).toBe("2026-05-05");
    expect(entry?.sourceUrl).toBe("https://www.ismworld.org/calendar");
  });

  it("marks unverifiable events as 'unknown' rather than dropping them", async () => {
    vi.doMock("@anthropic-ai/sdk", () => {
      return {
        default: class MockAnthropic {
          messages = {
            create: vi.fn().mockResolvedValue({
              content: [
                {
                  type: "text",
                  text: JSON.stringify([
                    { index: 1, status: "unknown", note: "Could not access publisher calendar" },
                  ]),
                },
              ],
            }),
          };
        },
      };
    });

    vi.resetModules();
    const mod = await import("@/lib/calendar/macro-events");
    const result = await mod.verifyNonFredReschedules([
      { date: "2026-05-01", shortName: "ISM Manufacturing", eventType: "pmi", defaultImpact: "high", reportingLag: 1, releaseTime: "10:00" },
    ]);

    const entry = result.get("2026-05-01:ISM Manufacturing");
    expect(entry?.status).toBe("unknown");
    expect(entry?.newDate).toBeUndefined();
  });

  it("returns empty map when Claude returns malformed JSON (graceful fallback)", async () => {
    vi.doMock("@anthropic-ai/sdk", () => {
      return {
        default: class MockAnthropic {
          messages = {
            create: vi.fn().mockResolvedValue({
              content: [{ type: "text", text: "not json at all, just prose" }],
            }),
          };
        },
      };
    });

    vi.resetModules();
    const mod = await import("@/lib/calendar/macro-events");
    const result = await mod.verifyNonFredReschedules([
      { date: "2026-05-01", shortName: "ISM Manufacturing", eventType: "pmi", defaultImpact: "high", reportingLag: 1, releaseTime: "10:00" },
    ]);
    expect(result.size).toBe(0);
  });
});
