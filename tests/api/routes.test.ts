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

describe("POST /api/research/sync", () => {
  it("returns 400 when Gmail isn't configured", async () => {
    hoisted.isGmailConfigured.mockReturnValueOnce(false);
    const mod = await import("@/app/api/research/sync/route");
    const res = await mod.POST();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Gmail OAuth not configured");
  });

  it("opens an SSE stream when Gmail IS configured", async () => {
    hoisted.isGmailConfigured.mockReturnValueOnce(true);
    hoisted.getGmailClient.mockReturnValueOnce({} as unknown);

    const mod = await import("@/app/api/research/sync/route");
    const res = await mod.POST();

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
});
