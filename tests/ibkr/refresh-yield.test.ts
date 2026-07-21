/**
 * Tests for lib/ibkr/refresh.ts post-pivot (2026-07-21, sessionless
 * /portfolio reads + local-TWS-gated compete:"true").
 *
 * fetchIbkrPortfolio no longer calls openSession at all — it's sessionless
 * (probe-verified: /portfolio reads work with just a signed LST, no
 * ssodh/init). So an openSession yield can NO LONGER abort the positions
 * refresh; it can only ever affect the best-effort quote-enrichment step,
 * which is non-fatal by design. This file asserts that shape, plus keeps a
 * mutex-release assertion for a genuine (non-yield) positions failure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/ibkr/web-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ibkr/web-api")>();
  return {
    ...actual,
    // Quote enrichment is the only remaining openSession call site on this
    // path — always yields in this suite so we can assert it degrades
    // gracefully without touching the positions refresh.
    openSession: vi.fn(async () => {
      throw new actual.IbkrSessionYieldError();
    }),
    getPortfolioAccounts: vi.fn(async () => [{ id: "U1", accountId: "U1" }]),
    getPositions: vi.fn(async () => []),
    getLedger: vi.fn(async () => ({})),
  };
});

vi.mock("@/lib/ibkr/oauth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ibkr/oauth-client")>();
  return {
    ...actual,
    getLiveSessionToken: vi.fn(async () => ({ token: "LST-TOKEN", expirationMs: Date.now() + 60_000 })),
  };
});

import { refreshIbkrHoldingsFromWebApi, fetchIbkrPortfolio } from "@/lib/ibkr/refresh";
import { getLiveSessionToken } from "@/lib/ibkr/oauth-client";
import { openSession, getPortfolioAccounts } from "@/lib/ibkr/web-api";
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

describe("fetchIbkrPortfolio — sessionless", () => {
  it("never calls openSession — only getLiveSessionToken + /portfolio reads", async () => {
    const cfg = {} as IbkrOAuthConfig;

    const snapshot = await fetchIbkrPortfolio(cfg);

    expect(snapshot.accountCode).toBe("U1");
    expect(getLiveSessionToken).toHaveBeenCalledTimes(1);
    expect(getPortfolioAccounts).toHaveBeenCalledTimes(1);
    expect(openSession).not.toHaveBeenCalled();
  });
});

describe("refreshIbkrHoldingsFromWebApi — quote-enrichment-only yield", () => {
  it("completes the positions refresh even though openSession (quote enrichment) yields — only enrichment skips", async () => {
    const cfg = {} as IbkrOAuthConfig;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await refreshIbkrHoldingsFromWebApi(db, cfg);

    // Positions path succeeded — never null, never threw.
    expect(result).not.toBeNull();
    expect(result?.positionsWritten).toBe(0); // empty positions mock, still a real completed run
    expect(openSession).toHaveBeenCalledTimes(1); // quote enrichment's one call

    // The mutex released cleanly (success path, not the error path).
    expect(isSyncing()).toBe(false);
    const state = getSyncState();
    expect(state.status).toBe("idle");
    expect(state.error).toBeNull();
    expect(state.lastSyncVia).toBe("ibkr-webapi");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("quote enrichment skipped — session yielded to TWS"),
    );
    logSpy.mockRestore();
  });
});

describe("refreshIbkrHoldingsFromWebApi — genuine (non-yield) positions failure", () => {
  it("rethrows and releases the sync mutex on a real positions-fetch error", async () => {
    const cfg = {} as IbkrOAuthConfig;
    (getLiveSessionToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("LST mint failed: network boom"),
    );

    await expect(refreshIbkrHoldingsFromWebApi(db, cfg)).rejects.toThrow("network boom");

    expect(isSyncing()).toBe(false);
    const state = getSyncState();
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/network boom/);
  });
});
