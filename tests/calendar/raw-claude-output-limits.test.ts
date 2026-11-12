/**
 * The two calendar web-search calls that use the raw Anthropic client
 * (2026-11-12). On the 5.5 generation thinking is on by default and counts
 * against max_tokens, so a small cap could cut the answer off. Each call
 * now leaves room for thinking, and a reply that DID hit the cap is treated
 * as "no answer" with a warning instead of being parsed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const mockCreate = vi.fn();
vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  return { ...actual, getRawAnthropicClient: vi.fn(() => ({ messages: { create: mockCreate } })) };
});

import { verifyNonFredReschedules } from "@/lib/calendar/macro-events";
import { fetchActualForEvent } from "@/lib/calendar/enrich-actuals";

/** Room for default-on thinking plus the answer, and still under the SDK's non-streaming guard. */
const MIN_CAP = 16_000;
const MAX_NON_STREAMING_CAP = 21_000;

const ISM = {
  date: "2026-05-01",
  shortName: "ISM Manufacturing",
  eventType: "pmi" as const,
  defaultImpact: "high" as const,
  reportingLag: 1,
  releaseTime: "10:00",
};

function textReply(text: string, stopReason: string) {
  return { content: [{ type: "text", text }], stop_reason: stopReason };
}

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test-stub";
  mockCreate.mockReset();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  vi.restoreAllMocks();
});

describe("verifyNonFredReschedules (macro-events)", () => {
  it("asks with room for thinking", async () => {
    mockCreate.mockResolvedValue(textReply(JSON.stringify([{ index: 1, status: "unchanged" }]), "end_turn"));
    const out = await verifyNonFredReschedules([ISM]);
    const params = mockCreate.mock.calls[0][0];
    expect(params.max_tokens).toBeGreaterThanOrEqual(MIN_CAP);
    expect(params.max_tokens).toBeLessThanOrEqual(MAX_NON_STREAMING_CAP);
    expect(out.get("2026-05-01:ISM Manufacturing")?.status).toBe("unchanged");
  });

  it("a reply cut off at max_tokens counts as no answer, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCreate.mockResolvedValue(
      textReply(JSON.stringify([{ index: 1, status: "rescheduled", newDate: "2026-05-05" }]), "max_tokens"),
    );
    const out = await verifyNonFredReschedules([ISM]);
    expect(out.size).toBe(0);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/max_tokens/);
  });
});

describe("fetchActualForEvent, non-FRED road (enrich-actuals)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  const row = {
    id: 1,
    source: "claude_macro",
    source_key: "nonfred:ISM_Manufacturing:2026-05-01",
    event_type: "pmi",
    event_date: "2026-05-01",
    release_time: "10:00",
    symbol: null,
    title: "ISM Manufacturing",
    consensus_estimate: "49.5",
    raw_json: null,
    previous_value: "49.0",
  };

  it("asks with room for thinking", async () => {
    mockCreate.mockResolvedValue(textReply("50.1", "end_turn"));
    const out = await fetchActualForEvent(db, row);
    const params = mockCreate.mock.calls[0][0];
    expect(params.max_tokens).toBeGreaterThanOrEqual(MIN_CAP);
    expect(params.max_tokens).toBeLessThanOrEqual(MAX_NON_STREAMING_CAP);
    expect(out.actual).toBe("50.1");
  });

  it("a reply cut off at max_tokens stores no actual, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockCreate.mockResolvedValue(textReply("50.1", "max_tokens"));
    const out = await fetchActualForEvent(db, row);
    expect(out.actual).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/max_tokens/);
  });
});
