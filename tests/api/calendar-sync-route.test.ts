import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";

/**
 * HTTP-boundary test for POST /api/calendar/sync (nightly QA ledger findings
 * `today-earningshub-finnhub-refresh--54s-silent-no-feedback` and its twin
 * `...silent-partial-failure-no-outcome-report-regression-2`).
 *
 * Root cause: the `complete` SSE frame's `data` object dropped
 * `SyncCalendarResult.errors` (per-phase failures such as "finnhub: 429
 * Too Many Requests"), so EarningsHubRefreshButton had no way to tell the
 * desk a run "succeeded" while silently swallowing dozens of Finnhub 429s.
 * This test pins that the route's complete frame now always carries
 * `errors` — additive only, every other field on the frame is unchanged.
 *
 * `syncCalendarForWeek` is mocked directly (not via importOriginal) so this
 * test never pulls in the real WSH/Finnhub/Nasdaq/TWS dependency chain —
 * the route is a thin SSE bridge and that's all this test exercises.
 */

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  syncCalendarForWeek: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/calendar/sync", () => ({
  syncCalendarForWeek: hoisted.syncCalendarForWeek,
  SyncCalendarValidationError: class SyncCalendarValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SyncCalendarValidationError";
    }
  },
}));

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  vi.clearAllMocks();
});

function syncRequest(body: Record<string, unknown> = {}): Request {
  return new NextRequest("http://localhost/api/calendar/sync", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function drainSse(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value);
  }
  return received;
}

function completeFrame(received: string): { complete: true; data: Record<string, unknown> } {
  const line = received
    .split("\n\n")
    .map((l) => l.replace(/^data: /, ""))
    .find((l) => l.startsWith('{"complete"'));
  expect(line).toBeDefined();
  return JSON.parse(line!) as { complete: true; data: Record<string, unknown> };
}

const baseResult = {
  weekOf: "2026-09-07",
  startDate: "2026-09-07",
  endDate: "2026-09-13",
  wshEvents: 0,
  wshNew: 0,
  macroEvents: 0,
  macroNew: 0,
  finnhubEvents: 0,
  finnhubNew: 0,
  nasdaqEvents: 0,
  nasdaqNew: 0,
  totalSaved: 0,
  newEvents: 0,
  refreshedEvents: 0,
  errors: [] as string[],
};

describe("POST /api/calendar/sync — complete frame carries per-phase errors", () => {
  it("passes result.errors through into the complete frame's data (a run with failed phases)", async () => {
    hoisted.syncCalendarForWeek.mockResolvedValueOnce({
      ...baseResult,
      finnhubEvents: 5,
      finnhubNew: 3,
      totalSaved: 5,
      newEvents: 3,
      refreshedEvents: 2,
      errors: ["finnhub: 429 Too Many Requests", "finnhub: 429 Too Many Requests"],
    });

    const mod = await import("@/app/api/calendar/sync/route");
    const res = await mod.POST(syncRequest({ weekOf: "2026-09-07" }));
    expect(res.status).toBe(200);
    const frame = completeFrame(await drainSse(res));

    expect(frame.data.errors).toEqual([
      "finnhub: 429 Too Many Requests",
      "finnhub: 429 Too Many Requests",
    ]);
    // Existing fields are untouched by the addition.
    expect(frame.data.newEvents).toBe(3);
    expect(frame.data.refreshedEvents).toBe(2);
    expect(frame.data.totalSaved).toBe(5);
    expect(frame.data.weekOf).toBe("2026-09-07");
  });

  it("still carries an empty errors array on a clean run — the field is never omitted", async () => {
    hoisted.syncCalendarForWeek.mockResolvedValueOnce({ ...baseResult });

    const mod = await import("@/app/api/calendar/sync/route");
    const res = await mod.POST(syncRequest({ weekOf: "2026-09-07" }));
    const frame = completeFrame(await drainSse(res));

    expect(frame.data.errors).toEqual([]);
  });

  it("still emits progress frames shaped { progress: { phase, message } } (button reads evt.progress.message)", async () => {
    hoisted.syncCalendarForWeek.mockImplementationOnce(
      async (_db: unknown, _weekOf: string, opts: { onProgress?: (e: unknown) => void }) => {
        opts.onProgress?.({ phase: "finnhub_fetch", message: "Scanning 3 symbols via Finnhub..." });
        return { ...baseResult };
      },
    );

    const mod = await import("@/app/api/calendar/sync/route");
    const res = await mod.POST(syncRequest({ weekOf: "2026-09-07" }));
    const received = await drainSse(res);

    expect(received).toContain(
      '{"progress":{"phase":"finnhub_fetch","message":"Scanning 3 symbols via Finnhub..."}}',
    );
    // No top-level `message` field ships on any frame — the old button bug
    // was keying on one that never existed.
    for (const line of received.split("\n\n").filter((l) => l.startsWith("data: {"))) {
      const evt = JSON.parse(line.replace(/^data: /, "")) as Record<string, unknown>;
      expect(evt.message).toBeUndefined();
    }
  });

  it("emits an { error } frame (no data) when the library throws, and still terminates with [DONE]", async () => {
    hoisted.syncCalendarForWeek.mockRejectedValueOnce(new Error("Finnhub API key missing"));

    const mod = await import("@/app/api/calendar/sync/route");
    const res = await mod.POST(syncRequest({ weekOf: "2026-09-07" }));
    const received = await drainSse(res);

    expect(received).toContain('{"error":"Finnhub API key missing"}');
    expect(received.trim().endsWith("data: [DONE]")).toBe(true);
  });
});
