/**
 * Tests for lib/ibkr/refresh.ts's yield-aware handling of
 * IbkrSessionYieldError (compete:"false" polite session yield, 2026-07-21).
 *
 * The positions fetch (fetchIbkrPortfolio -> openSession) used to rethrow
 * every error from setSyncPhase("positions") onward, leaving the sync-state
 * mutex stuck in "syncing" if the caller didn't also call setSyncError. A
 * yield is not a failure worth surfacing as an error toast — it's an
 * expected "TWS owns the session this pass" outcome — so
 * refreshIbkrHoldingsFromWebApi must return null AND release the mutex via
 * setSyncError (verified: lib/tws/sync-state.ts sets status="error", which
 * flips isSyncing() back to false).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/ibkr/web-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ibkr/web-api")>();
  return {
    ...actual,
    openSession: vi.fn(async () => {
      throw new actual.IbkrSessionYieldError();
    }),
  };
});

import { refreshIbkrHoldingsFromWebApi } from "@/lib/ibkr/refresh";
import { isSyncing, getSyncState } from "@/lib/tws/sync-state";
import type { IbkrOAuthConfig } from "@/lib/ibkr/oauth-client";

/**
 * Reset the sync-state singleton between tests. The module stores state on
 * globalThis so it persists across test boundaries (mirrors the reset helper
 * in tests/tws/auto-refresh-integration.test.ts).
 */
function resetSyncState() {
  const g = globalThis as unknown as { __sync_state: Record<string, unknown> };
  g.__sync_state = {
    status: "idle",
    currentPhase: null,
    phaseProgress: null,
    lastSyncAt: null,
    lastSyncResult: null,
    lastSyncVia: null,
    error: null,
  };
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db); // seeds the default accounts incl. 'IBKR'
  resetSyncState();
  vi.clearAllMocks();
});

describe("refreshIbkrHoldingsFromWebApi — session yield", () => {
  it("returns null (not a throw) and releases the sync mutex when the positions fetch yields to TWS", async () => {
    const cfg = {} as IbkrOAuthConfig; // opaque — openSession is mocked, never network-hit

    const result = await refreshIbkrHoldingsFromWebApi(db, cfg);

    expect(result).toBeNull();
    expect(isSyncing()).toBe(false);

    const state = getSyncState();
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/yielded/i);
  });

  it("logs a yield-specific message, not the generic failure warning", async () => {
    const cfg = {} as IbkrOAuthConfig;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await refreshIbkrHoldingsFromWebApi(db, cfg);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("yielded to an active TWS session"));
    logSpy.mockRestore();
  });
});
