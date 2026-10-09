/**
 * Recap road 1 reads `enriched_at` in BOTH stored forms.
 *
 * The Mac stores the same UTC instant two ways: SQLite `datetime('now')`
 * ("2026-06-11 20:30:00", no zone marker) and ISO ("2026-06-11T20:30:00.000Z").
 * The scan used to append "Z" unconditionally, so the ISO form parsed to NaN;
 * and because the value was truthy the second recap road was skipped as well,
 * so the recap was silently missed. Both forms now read as the same instant.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FallbackEnv } from "../src/fallback-earnings";
import type { Snapshot } from "../src/state";

vi.mock("../src/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state")>();
  return { ...actual, loadLatestSnapshot: vi.fn() };
});
vi.mock("../src/resend", () => ({
  sendEmail: vi.fn(async () => ({ id: "mock-email-id" })),
}));
vi.mock("../src/ibkr-positions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ibkr-positions")>();
  return { ...actual, fetchLiveIbkrPositionsCached: vi.fn(async () => []) };
});

import { runEarningsFallback } from "../src/fallback-earnings";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";

const EVENT_DATE = "2026-06-11";
const EVENT_ID = 7;

function makeEnv(): FallbackEnv {
  const store = new Map<string, string>();
  return {
    CRON_KV: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace,
    ARCHIVE: {} as R2Bucket,
    BRIEFING_EMAIL_TO: "user@example.com",
    RESEND_API_KEY: "test-resend-key",
    RESEND_FROM_DOMAIN: "example.com",
  };
}

function snapshotWithEnrichedAt(enrichedAt: string): Snapshot {
  return {
    schemaVersion: 2,
    snapshotDate: EVENT_DATE,
    generatedAt: new Date().toISOString(),
    heldSymbols: ["ZZA"],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: [
      {
        id: EVENT_ID,
        week_of: "2026-06-08",
        event_date: EVENT_DATE,
        event_type: "earnings",
        title: "ZZA earnings",
        description: null,
        symbol: "ZZA",
        event_time: "AMC",
        release_time: "16:00",
        expected_impact: "high",
        source: "finnhub",
        source_key: `finnhub:ZZA:${EVENT_DATE}`,
        raw_json: {},
        superseded: 0,
        enriched_at: enrichedAt,
        consensus_estimate: "EPS 1.00 · Rev 1B",
        consensus_value: "EPS 1.00 · Rev 1000000000",
        actual_value: "EPS 1.00 · Rev 1000000000",
        previous_value: null,
        reaction_snapshot: null,
      },
    ],
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
  } as unknown as Snapshot;
}

async function recapOutcome(enrichedAt: string, now: string) {
  vi.clearAllMocks();
  (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "mock-email-id" });
  (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithEnrichedAt(enrichedAt));
  const result = await runEarningsFallback(makeEnv(), { now: new Date(now) });
  return result.details.map((d) => ({ eventId: d.eventId, phase: d.phase, status: d.status }));
}

const SENT = [{ eventId: EVENT_ID, phase: "recap", status: "sent" }];

describe("recap road 1: enriched_at in either stored form", () => {
  beforeEach(() => vi.clearAllMocks());

  it("space-separated form (today's stored form): recap sends thirty minutes after", async () => {
    expect(await recapOutcome("2026-06-11 20:30:00", "2026-06-11T21:00:00Z")).toEqual(SENT);
  });

  it("ISO form with T and Z: the same recap sends", async () => {
    expect(await recapOutcome("2026-06-11T20:30:00.000Z", "2026-06-11T21:00:00Z")).toEqual(SENT);
    expect(await recapOutcome("2026-06-11T20:30:00Z", "2026-06-11T21:00:00Z")).toEqual(SENT);
  });

  it("both forms agree at every age: just enriched, in the window, long past, and in the future", async () => {
    for (const now of [
      "2026-06-11T20:30:00Z",
      "2026-06-11T20:45:00Z",
      "2026-06-11T22:00:00Z",
      "2026-06-12T08:00:00Z",
      "2026-06-14T20:30:00Z",
      "2026-06-11T20:00:00Z",
    ]) {
      const spaced = await recapOutcome("2026-06-11 20:30:00", now);
      const iso = await recapOutcome("2026-06-11T20:30:00.000Z", now);
      expect(iso, `now=${now}`).toEqual(spaced);
    }
  });

  it("an unreadable value sends nothing and does not throw", async () => {
    expect(await recapOutcome("not a time", "2026-06-11T21:00:00Z")).toEqual([]);
  });
});
