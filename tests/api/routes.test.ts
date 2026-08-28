/**
 * API route contract tests.
 *
 * These are HTTP-boundary tests for critical routes that poll-based UI
 * components or automation depend on. They assert:
 *   1. Status code shape (success vs 4xx/5xx)
 *   2. Payload envelope (`success` / `data` / error keys)
 *   3. That external services (Gmail, Claude) are gated correctly
 *
 * Covered routes:
 *   - GET  /api/tws/sync-status — polled every 3s by header indicators
 *   - POST /api/levels/extract  — auto-run after research sync
 *   - POST /api/research/sync   — SSE pipeline
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import {
  acquireResearchSyncLock,
  currentResearchSyncRunner,
  __resetResearchSyncLockForTests,
} from "@/lib/research/sync-lock";

// ── Shared mocks ────────────────────────────────────────────────
// All three routes import `@/lib/db`, which opens the production SQLite
// file at module load. Replace it with an in-memory DB scoped to the test
// run so we don't touch real user data.

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  extractLevelsFromNewArticles: vi.fn(async () => ({
    articles_scanned: 3,
    levels_extracted: 2,
    levels_inserted: 2,
  })),
  extractBogeysFromNewArticles: vi.fn(async () => ({
    articlesScanned: 2,
    bogeysStored: 1,
    eventsMatched: 1,
  })),
  isGmailConfigured: vi.fn(() => false),
  getGmailClient: vi.fn(),
  fetchNewArticles: vi.fn(async () => ({ fetched: 0, sources: [] })),
  processUnprocessedArticles: vi.fn(async () => ({ processed: 0, failed: 0 })),
  backfillArticleHtml: vi.fn(async () => ({ updated: 0 })),
  backfillSourceUrls: vi.fn(() => 0),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/alerts/extract-newsletter-levels", () => ({
  extractLevelsFromNewArticles: hoisted.extractLevelsFromNewArticles,
}));

vi.mock("@/lib/earnings/extract-newsletter-bogeys", () => ({
  extractBogeysFromNewArticles: hoisted.extractBogeysFromNewArticles,
}));

vi.mock("@/lib/gmail/auth", () => ({
  isGmailConfigured: hoisted.isGmailConfigured,
  getGmailClient: hoisted.getGmailClient,
}));

vi.mock("@/lib/gmail/fetch", () => ({
  fetchNewArticles: hoisted.fetchNewArticles,
  backfillArticleHtml: hoisted.backfillArticleHtml,
  backfillSourceUrls: hoisted.backfillSourceUrls,
}));

vi.mock("@/lib/gmail/process", () => ({
  processUnprocessedArticles: hoisted.processUnprocessedArticles,
}));

// Reset the sync-state singleton between runs.
function resetSyncState() {
  const g = globalThis as unknown as { __sync_state: Record<string, unknown> };
  g.__sync_state = {
    status: "idle",
    currentPhase: null,
    phaseProgress: null,
    lastSyncAt: null,
    lastSyncResult: null,
    error: null,
  };
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  resetSyncState();
  __resetResearchSyncLockForTests();
  vi.clearAllMocks();
});

// ── GET /api/tws/sync-status ───────────────────────────────────

describe("GET /api/tws/sync-status", () => {
  it("returns {success:true, data:SyncState} with idle baseline", async () => {
    const mod = await import("@/app/api/tws/sync-status/route");
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { status: string; currentPhase: unknown; lastSyncAt: unknown };
    };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("idle");
    expect(body.data.currentPhase).toBeNull();
    expect(body.data.lastSyncAt).toBeNull();
  });

  it("reflects a mid-sync state when sync-state is in progress", async () => {
    const { setSyncPhase } = await import("@/lib/tws/sync-state");
    setSyncPhase("prices", { current: 5, total: 10, label: "SPY" });

    const mod = await import("@/app/api/tws/sync-status/route");
    const res = await mod.GET();
    const body = (await res.json()) as {
      data: {
        status: string;
        currentPhase: string;
        phaseProgress: { current: number; total: number; label: string };
      };
    };
    expect(body.data.status).toBe("syncing");
    expect(body.data.currentPhase).toBe("prices");
    expect(body.data.phaseProgress.current).toBe(5);
  });
});

// ── POST /api/levels/extract ───────────────────────────────────

describe("POST /api/levels/extract", () => {
  it("returns {success:true, ...result} envelope", async () => {
    const mod = await import("@/app/api/levels/extract/route");
    const req = new NextRequest("http://test/api/levels/extract", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      articles_scanned: number;
      levels_extracted: number;
      levels_inserted: number;
    };
    expect(body.success).toBe(true);
    expect(body.articles_scanned).toBe(3);
    expect(body.levels_extracted).toBe(2);
    expect(body.levels_inserted).toBe(2);
    expect(hoisted.extractLevelsFromNewArticles).toHaveBeenCalledTimes(1);
  });

  it("passes through sinceDays + batchSize opts from the body", async () => {
    const mod = await import("@/app/api/levels/extract/route");
    const req = new NextRequest("http://test/api/levels/extract", {
      method: "POST",
      body: JSON.stringify({ sinceDays: 7, batchSize: 3 }),
    });
    await mod.POST(req);
    expect(hoisted.extractLevelsFromNewArticles).toHaveBeenCalledWith(
      expect.anything(),
      { sinceDays: 7, batchSize: 3 },
    );
  });

  it("returns {success:false, error} and 500 on extraction failure", async () => {
    hoisted.extractLevelsFromNewArticles.mockRejectedValueOnce(new Error("claude down"));

    const mod = await import("@/app/api/levels/extract/route");
    const req = new NextRequest("http://test/api/levels/extract", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("claude down");
  });
});

// ── POST /api/research/sync ────────────────────────────────────

/**
 * The route reads the runner off the request, so every call needs a real
 * Request. `runner` mirrors what lib/hooks/useResearchSync.ts sends on its
 * background pass; omit it for the manual "Sync Feeds" click.
 */
function syncRequest(runner?: string): Request {
  return new NextRequest("http://localhost/api/research/sync", {
    method: "POST",
    headers: runner ? { "X-Sync-Runner": runner } : undefined,
  });
}

/** Park the pipeline inside fetchNewArticles so the SSE stream keeps holding
 *  the sync lock while the test fires a second, colliding request. Returns
 *  the resolver that lets the parked run finish. */
function parkPipeline(): () => void {
  let release!: () => void;
  hoisted.fetchNewArticles.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ fetched: 0, sources: [] });
      }),
  );
  return () => release();
}

async function drain(res: Response): Promise<void> {
  const reader = res.body!.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe("POST /api/research/sync", () => {
  it("returns 400 when Gmail isn't configured", async () => {
    hoisted.isGmailConfigured.mockReturnValueOnce(false);
    const mod = await import("@/app/api/research/sync/route");
    const res = await mod.POST(syncRequest());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Gmail OAuth not configured");
  });

  it("returns 409 already_running while a background pass holds the sync lock", async () => {
    hoisted.isGmailConfigured.mockReturnValueOnce(true);
    const held = acquireResearchSyncLock("background");
    if (!held.ok) throw new Error("expected lock acquire to succeed");

    const mod = await import("@/app/api/research/sync/route");
    const res = await mod.POST(syncRequest());
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      success: boolean;
      error: string;
      code: string;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe("already_running");
    expect(body.error).toContain("background refresh");

    // A refused request must never touch the pipeline.
    expect(hoisted.getGmailClient).not.toHaveBeenCalled();
  });

  it("opens an SSE stream when Gmail IS configured", async () => {
    hoisted.isGmailConfigured.mockReturnValueOnce(true);
    hoisted.getGmailClient.mockReturnValueOnce({} as unknown);

    const mod = await import("@/app/api/research/sync/route");
    const res = await mod.POST(syncRequest());

    expect(res.status).toBe(200);
    // SSE responses expose a ReadableStream body. Next's Response type
    // may re-wrap it, but the underlying body is present + readable.
    expect(res.body).not.toBeNull();

    // Drain the first event to confirm an SSE frame is emitted.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    // Loop a few reads to let the pipeline push some events.
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
      if (received.includes("data:")) break;
    }
    reader.cancel();
    expect(received).toContain("data:");
    expect(received).toMatch(/"phase":\s*"(fetch|process|backfill|urls|levels)"/);
  });

  it("runs bogey extraction immediately after level extraction, best-effort", async () => {
    hoisted.isGmailConfigured.mockReturnValueOnce(true);
    hoisted.getGmailClient.mockReturnValueOnce({} as unknown);

    const mod = await import("@/app/api/research/sync/route");
    const res = await mod.POST(syncRequest());

    // Drain the whole stream to completion.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }

    expect(hoisted.extractLevelsFromNewArticles).toHaveBeenCalledTimes(1);
    expect(hoisted.extractBogeysFromNewArticles).toHaveBeenCalledTimes(1);
    expect(received).toMatch(/"phase":\s*"bogeys",\s*"status":\s*"started"/);
    expect(received).toContain('"phase":"bogeys","status":"done"');
    expect(received).toContain('"bogeysStored":1');

    // Order: the levels "done" frame must appear before the bogeys "started"
    // frame — bogeys runs immediately AFTER levels, mirroring the same
    // try/catch discipline.
    const levelsDoneIdx = received.indexOf('"phase":"levels","status":"done"');
    const bogeysStartedIdx = received.indexOf('"phase":"bogeys","status":"started"');
    expect(levelsDoneIdx).toBeGreaterThan(-1);
    expect(bogeysStartedIdx).toBeGreaterThan(levelsDoneIdx);
  });

  it("a bogey-extraction failure is caught and streamed as an error event without aborting the sync", async () => {
    hoisted.isGmailConfigured.mockReturnValueOnce(true);
    hoisted.getGmailClient.mockReturnValueOnce({} as unknown);
    hoisted.extractBogeysFromNewArticles.mockRejectedValueOnce(new Error("claude down"));

    const mod = await import("@/app/api/research/sync/route");
    const res = await mod.POST(syncRequest());

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }

    expect(received).toContain('"phase":"bogeys","status":"error"');
    expect(received).toContain('"message":"claude down"');
    // The sync must still reach completion.
    expect(received).toContain('"phase":"complete"');
  });

  // Review finding (2026-08-28): the route acquired the lock as "manual" for
  // EVERY request, including the automatic background refresh from
  // lib/hooks/useResearchSync.ts. A collision during that automatic pass then
  // told the user "A sync you already started is still running" — a sync they
  // never started. The hook now labels itself with `X-Sync-Runner: background`
  // and the route acquires under that runner, so the 409 names the real owner.
  describe("runner attribution (X-Sync-Runner)", () => {
    it("acquires as 'background' when the hook's header is present, so a colliding request says so", async () => {
      hoisted.isGmailConfigured.mockReturnValue(true);
      hoisted.getGmailClient.mockReturnValue({} as unknown);
      const release = parkPipeline();

      const mod = await import("@/app/api/research/sync/route");
      const bg = await mod.POST(syncRequest("background"));
      expect(bg.status).toBe(200);
      expect(currentResearchSyncRunner()).toBe("background");

      // The user clicks Sync Feeds while that background pass is in flight.
      const collide = await mod.POST(syncRequest());
      expect(collide.status).toBe(409);
      const body = (await collide.json()) as { error: string; code: string };
      expect(body.code).toBe("already_running");
      expect(body.error).toContain("background refresh");
      expect(body.error).not.toContain("you already started");

      release();
      await drain(bg);
      expect(currentResearchSyncRunner()).toBeNull();
    });

    it("acquires as 'manual' with no header — the collision message names the user's own sync", async () => {
      hoisted.isGmailConfigured.mockReturnValue(true);
      hoisted.getGmailClient.mockReturnValue({} as unknown);
      const release = parkPipeline();

      const mod = await import("@/app/api/research/sync/route");
      const manual = await mod.POST(syncRequest());
      expect(manual.status).toBe(200);
      expect(currentResearchSyncRunner()).toBe("manual");

      const collide = await mod.POST(syncRequest());
      expect(collide.status).toBe(409);
      const body = (await collide.json()) as { error: string };
      expect(body.error).toContain("you already started");

      release();
      await drain(manual);
    });

    it.each(["cron", "manual", "BACKGROUND-ish", "", "not-a-runner"])(
      "treats an unrecognized X-Sync-Runner value (%j) as 'manual'",
      async (value) => {
        hoisted.isGmailConfigured.mockReturnValue(true);
        hoisted.getGmailClient.mockReturnValue({} as unknown);
        const release = parkPipeline();

        const mod = await import("@/app/api/research/sync/route");
        const res = await mod.POST(syncRequest(value));
        expect(res.status).toBe(200);
        expect(currentResearchSyncRunner()).toBe("manual");

        release();
        await drain(res);
      },
    );
  });

  // Hardening (same review): the lock is taken BEFORE the SSE stream is
  // built. A synchronous throw while constructing the encoder/stream would
  // skip the stream's `finally` and strand the lock for the process's life —
  // every later sync would 409 forever.
  it("releases the lock when stream construction itself throws", async () => {
    hoisted.isGmailConfigured.mockReturnValue(true);
    const RealReadableStream = globalThis.ReadableStream;
    globalThis.ReadableStream = class {
      constructor() {
        throw new Error("stream construction blew up");
      }
    } as unknown as typeof ReadableStream;

    try {
      const mod = await import("@/app/api/research/sync/route");
      await expect(mod.POST(syncRequest())).rejects.toThrow("stream construction blew up");
    } finally {
      globalThis.ReadableStream = RealReadableStream;
    }

    expect(currentResearchSyncRunner()).toBeNull();
  });
});
