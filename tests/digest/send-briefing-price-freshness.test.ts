import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

/**
 * Regression for the 2026-05-12 Sunday-briefing-stale-prices fix.
 *
 * Pre-fix: `sendBriefingEmail` called `syncPortfolio(db)` (positions only)
 * but NOT `fetchSnapshotPrices` — Sunday 5/11 went out with Thursday-close
 * prices because the `prices` table hadn't been touched since Friday close
 * and TWS wasn't connected during the launchd-Sunday-3pm fire.
 *
 * Fix: after `syncPortfolio` succeeds, call `runAutoRefresh(db, "quick")`
 * which runs Step 3 (snapshot prices) + Step 4 (valuations recompute). Both
 * calls are best-effort — a failure must NOT block the email.
 *
 * These tests mock the TWS layer and assert call ordering / fallback
 * behavior, without doing real network IO.
 */

vi.mock("@/lib/tws/positions", () => ({
  syncPortfolio: vi.fn(),
}));

vi.mock("@/lib/tws/auto-refresh", () => ({
  runAutoRefresh: vi.fn(),
}));

vi.mock("@/lib/calendar/sync", () => ({
  syncCalendarForWeek: vi.fn().mockResolvedValue({ errors: [] }),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/calendar/briefing", () => ({
  generateWeeklyBriefing: vi.fn().mockResolvedValue({ eventCount: 1 }),
}));

vi.mock("@/lib/queries/calendar", () => ({
  getBriefingByWeek: vi.fn().mockReturnValue({
    content: "fake briefing markdown",
    title: "Test Briefing",
    event_count: 1,
  }),
  isBriefingStale: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/compute/analysis-narratives", () => ({
  NARRATIVE_SURFACES: [],
  generateNarrative: vi.fn(),
}));

vi.mock("@/lib/compute/macro-themes", () => ({
  generateMacroThemes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/compute/security-regression-backfill", () => ({
  backfillSecurityRegressions: vi
    .fn()
    .mockReturnValue({ processed: 0, succeeded: 0, skipped: 0, failed: 0 }),
}));

vi.mock("@/lib/ai/model-catalog", () => ({
  refreshModelCatalog: vi.fn(async () => []),
}));

vi.mock("@/lib/calendar/briefing-html", () => ({
  briefingToHtml: vi.fn().mockReturnValue("<html>fake</html>"),
}));

import { sendBriefingEmail } from "@/lib/digest/send-briefing";
import { syncPortfolio } from "@/lib/tws/positions";
import { runAutoRefresh } from "@/lib/tws/auto-refresh";

const mockedSyncPortfolio = vi.mocked(syncPortfolio);
const mockedRunAutoRefresh = vi.mocked(runAutoRefresh);

let db: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Set BRIEFING_EMAIL_TO for the test
  process.env.BRIEFING_EMAIL_TO = "test@example.com";
});

describe("sendBriefingEmail price-freshness ordering", () => {
  it("calls syncPortfolio BEFORE runAutoRefresh(db, 'quick')", async () => {
    const callOrder: string[] = [];
    mockedSyncPortfolio.mockImplementation(async () => {
      callOrder.push("syncPortfolio");
      return undefined as never;
    });
    mockedRunAutoRefresh.mockImplementation(async (_db, level) => {
      callOrder.push(`runAutoRefresh:${level}`);
      return {
        positionsSynced: 0,
        securitiesEnriched: 0,
        pricesUpdated: 30,
        valuationsRecomputed: true,
        benchmarksSynced: 0,
        alertsFired: 0,
        errors: [],
        durationMs: 1000,
      };
    });

    await sendBriefingEmail(db, { weekOf: "2026-05-11" });

    expect(callOrder[0]).toBe("syncPortfolio");
    expect(callOrder[1]).toBe("runAutoRefresh:quick");
  });

  it("skips runAutoRefresh when syncPortfolio fails (TWS unreachable)", async () => {
    mockedSyncPortfolio.mockRejectedValue(new Error("TWS not connected"));
    mockedRunAutoRefresh.mockResolvedValue({
      positionsSynced: 0,
      securitiesEnriched: 0,
      pricesUpdated: 0,
      valuationsRecomputed: false,
      benchmarksSynced: 0,
      alertsFired: 0,
      errors: [],
      durationMs: 0,
    });

    const result = await sendBriefingEmail(db, { weekOf: "2026-05-11" });

    expect(mockedSyncPortfolio).toHaveBeenCalledTimes(1);
    expect(mockedRunAutoRefresh).not.toHaveBeenCalled();
    expect(result.twsSynced).toBe(false);
  });

  it("does NOT throw when runAutoRefresh fails — briefing still ships", async () => {
    mockedSyncPortfolio.mockResolvedValue(undefined as never);
    mockedRunAutoRefresh.mockRejectedValue(
      new Error("TWS gateway timeout mid-fetch"),
    );

    const result = await sendBriefingEmail(db, { weekOf: "2026-05-11" });
    expect(result.success).toBe(true);
  });

  it("does NOT throw when runAutoRefresh returns null (concurrent sync skip)", async () => {
    mockedSyncPortfolio.mockResolvedValue(undefined as never);
    mockedRunAutoRefresh.mockResolvedValue(null);

    const result = await sendBriefingEmail(db, { weekOf: "2026-05-11" });
    expect(result.success).toBe(true);
  });

  it("calls runAutoRefresh with level='quick' (not 'full')", async () => {
    mockedSyncPortfolio.mockResolvedValue(undefined as never);
    mockedRunAutoRefresh.mockResolvedValue({
      positionsSynced: 0,
      securitiesEnriched: 0,
      pricesUpdated: 0,
      valuationsRecomputed: true,
      benchmarksSynced: 0,
      alertsFired: 0,
      errors: [],
      durationMs: 1000,
    });

    await sendBriefingEmail(db, { weekOf: "2026-05-11" });

    expect(mockedRunAutoRefresh).toHaveBeenCalledWith(
      expect.anything(),
      "quick",
    );
  });
});
