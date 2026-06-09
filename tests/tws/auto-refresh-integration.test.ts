import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

// vi.hoisted() runs before vi.mock() factories, letting us share mock
// handles between the mock definitions (hoisted to top) and the test body.
const mocks = vi.hoisted(() => ({
  syncPortfolio: vi.fn(async () => ({ positionsSynced: 3, pricesSaved: 2 })),
  enrichSecurities: vi.fn(async () => [
    { enriched: true },
    { enriched: false, error: "not found" },
  ]),
  fetchSnapshotPrices: vi.fn(async () => [
    { symbol: "SPY", price: 700, error: null },
  ]),
  fetchBenchmarkPrices: vi.fn(async () => [
    { symbol: "SPY", barsInserted: 5 },
  ]),
  computeDailyValuations: vi.fn(() => {}),
  detectAndFireAlerts: vi.fn(() => ({ fired: 0, deduped: 0, scanned: 4 })),
  generateSuggestionsForPendingAlerts: vi.fn(async () => ({
    generated: 0,
    failed: 0,
  })),
  classifyOptionSectors: vi.fn(async () => ({ classified: 1, errors: [] })),
  getUnsectoredOptionUnderlyings: vi.fn(() => [] as string[]),
  classifyFactors: vi.fn(async () => ({
    classified: 0,
    skipped: 0,
    errors: [] as string[],
    candidates: 0,
    underlyingsCreated: 0,
  })),
}));

vi.mock("@/lib/tws/positions", () => ({ syncPortfolio: mocks.syncPortfolio }));
vi.mock("@/lib/tws/contracts", () => ({ enrichSecurities: mocks.enrichSecurities }));
vi.mock("@/lib/tws/snapshot", () => ({
  fetchSnapshotPrices: mocks.fetchSnapshotPrices,
}));
vi.mock("@/lib/tws/benchmark", () => ({
  fetchBenchmarkPrices: mocks.fetchBenchmarkPrices,
}));
vi.mock("@/lib/compute/daily-valuation", () => ({
  computeDailyValuations: mocks.computeDailyValuations,
}));
vi.mock("@/lib/alerts/detect", () => ({
  detectAndFireAlerts: mocks.detectAndFireAlerts,
}));
vi.mock("@/lib/alerts/generate-suggestion", () => ({
  generateSuggestionsForPendingAlerts: mocks.generateSuggestionsForPendingAlerts,
}));
vi.mock("@/lib/securities/classify-option-sectors", () => ({
  classifyOptionSectors: mocks.classifyOptionSectors,
  getUnsectoredOptionUnderlyings: mocks.getUnsectoredOptionUnderlyings,
}));
vi.mock("@/lib/compute/classify-factors", () => ({
  classifyFactors: mocks.classifyFactors,
}));

import { runAutoRefresh } from "@/lib/tws/auto-refresh";
import { getSyncState, isSyncing } from "@/lib/tws/sync-state";

/**
 * Reset the sync-state singleton between tests. The module stores state on
 * globalThis so it persists across test boundaries; resetting to the idle
 * shape matches the module's own init block.
 */
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

/**
 * Seed an account + one security so step 2's enrichment COUNT check has
 * something to grab. `ib_con_id` is NULL to simulate a fresh import.
 */
function seedSecurityWithHolding(db: Database.Database) {
  db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run();
  const sec = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, ib_con_id)
       VALUES ('AAPL', 'Apple', 'Stock', NULL)`,
    )
    .run();
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (1, ?, 10, '2026-04-23', 'seed')`,
  ).run(sec.lastInsertRowid);
}

describe("auto-refresh — integration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    resetSyncState();
    vi.clearAllMocks();
  });

  it("runs all 6 steps in order on a full refresh", async () => {
    seedSecurityWithHolding(db);

    const order: string[] = [];
    mocks.syncPortfolio.mockImplementationOnce(async () => {
      order.push("positions");
      return { positionsSynced: 1, pricesSaved: 0 };
    });
    mocks.enrichSecurities.mockImplementationOnce(async () => {
      order.push("enrich");
      return [{ enriched: true }];
    });
    mocks.fetchSnapshotPrices.mockImplementationOnce(async () => {
      order.push("snapshot");
      return [{ symbol: "AAPL", price: 200, error: null }];
    });
    mocks.computeDailyValuations.mockImplementationOnce(() => {
      order.push("valuations");
    });
    mocks.fetchBenchmarkPrices.mockImplementationOnce(async () => {
      order.push("benchmarks");
      return [];
    });
    mocks.detectAndFireAlerts.mockImplementationOnce(() => {
      order.push("alerts");
      return { fired: 0, deduped: 0, scanned: 0 };
    });

    const result = await runAutoRefresh(db, "full");

    expect(result).not.toBeNull();
    expect(result!.errors).toEqual([]);

    // The benchmarks call launches in parallel with snapshot+valuations, so
    // its exact relative position among {snapshot, valuations} is not
    // deterministic. But: positions and enrich must come first, and alerts
    // must come last.
    expect(order[0]).toBe("positions");
    expect(order[1]).toBe("enrich");
    expect(order[order.length - 1]).toBe("alerts");
    expect(order).toContain("snapshot");
    expect(order).toContain("valuations");
    expect(order).toContain("benchmarks");
  });

  it("quick refresh skips positions + enrichment + benchmarks", async () => {
    const result = await runAutoRefresh(db, "quick");

    expect(result).not.toBeNull();
    expect(mocks.syncPortfolio).not.toHaveBeenCalled();
    expect(mocks.enrichSecurities).not.toHaveBeenCalled();
    expect(mocks.fetchBenchmarkPrices).not.toHaveBeenCalled();
    // Snapshot + valuations + alerts DO run in quick mode.
    expect(mocks.fetchSnapshotPrices).toHaveBeenCalledTimes(1);
    expect(mocks.computeDailyValuations).toHaveBeenCalledTimes(1);
    expect(mocks.detectAndFireAlerts).toHaveBeenCalledTimes(1);
  });

  it("mutex: a second concurrent call returns null without invoking steps", async () => {
    seedSecurityWithHolding(db);

    // Delay positions long enough for the second call to land while the
    // first is still mid-pipeline.
    mocks.syncPortfolio.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ positionsSynced: 1, pricesSaved: 0 }), 50);
        }),
    );

    const first = runAutoRefresh(db, "full");
    // Let the first call tip into `syncing` before the second lands.
    await new Promise((r) => setTimeout(r, 5));

    expect(isSyncing()).toBe(true);
    const second = await runAutoRefresh(db, "full");
    expect(second).toBeNull();

    await first;
    expect(isSyncing()).toBe(false);
    // Second call must not have fired another enrichment / snapshot.
    expect(mocks.enrichSecurities).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSnapshotPrices).toHaveBeenCalledTimes(1);
  });

  it("skips enrichment when no holdings need it", async () => {
    // No seed => count = 0 => enrich skipped
    const result = await runAutoRefresh(db, "full");
    expect(result).not.toBeNull();
    expect(mocks.enrichSecurities).not.toHaveBeenCalled();
  });

  it("mid-pipeline failure is isolated — later steps still run", async () => {
    seedSecurityWithHolding(db);
    mocks.fetchSnapshotPrices.mockRejectedValueOnce(new Error("TWS dropped"));

    const result = await runAutoRefresh(db, "full");

    expect(result).not.toBeNull();
    expect(result!.errors).toEqual(expect.arrayContaining([expect.stringContaining("TWS dropped")]));
    // Valuations and alerts must still run after the snapshot failure.
    expect(mocks.computeDailyValuations).toHaveBeenCalledTimes(1);
    expect(mocks.detectAndFireAlerts).toHaveBeenCalledTimes(1);
  });

  it("sync-state transitions through the phases and resets to idle on success", async () => {
    seedSecurityWithHolding(db);
    const seen: Array<string | null> = [];
    mocks.syncPortfolio.mockImplementationOnce(async () => {
      seen.push(getSyncState().currentPhase);
      return { positionsSynced: 1, pricesSaved: 0 };
    });
    mocks.enrichSecurities.mockImplementationOnce(async () => {
      seen.push(getSyncState().currentPhase);
      return [];
    });
    mocks.fetchSnapshotPrices.mockImplementationOnce(async () => {
      seen.push(getSyncState().currentPhase);
      return [];
    });
    mocks.computeDailyValuations.mockImplementationOnce(() => {
      seen.push(getSyncState().currentPhase);
    });
    mocks.detectAndFireAlerts.mockImplementationOnce(() => {
      seen.push(getSyncState().currentPhase);
      return { fired: 0, deduped: 0, scanned: 0 };
    });

    const result = await runAutoRefresh(db, "full");
    expect(result).not.toBeNull();

    expect(seen).toContain("positions");
    expect(seen).toContain("enriching");
    expect(seen).toContain("prices");
    expect(seen).toContain("valuations");
    expect(seen).toContain("alerts");

    // After completion, state should be idle with lastSyncResult populated.
    const final = getSyncState();
    expect(final.status).toBe("idle");
    expect(final.currentPhase).toBeNull();
    expect(final.lastSyncResult).not.toBeNull();
    expect(final.lastSyncAt).not.toBeNull();
  });

  it("fires alert-suggestion generation only when alerts fired", async () => {
    mocks.detectAndFireAlerts.mockImplementationOnce(() => ({ fired: 2, deduped: 0, scanned: 4 }));

    await runAutoRefresh(db, "quick");
    expect(mocks.generateSuggestionsForPendingAlerts).toHaveBeenCalledTimes(1);

    // Reset + run a second pipeline where nothing fires.
    resetSyncState();
    vi.clearAllMocks();
    mocks.detectAndFireAlerts.mockImplementationOnce(() => ({ fired: 0, deduped: 0, scanned: 4 }));
    await runAutoRefresh(db, "quick");
    expect(mocks.generateSuggestionsForPendingAlerts).not.toHaveBeenCalled();
  });

  it("classifies blank-sector option underlyings on full refresh (Step 2.5)", async () => {
    mocks.getUnsectoredOptionUnderlyings.mockReturnValue(["XYZ"]);
    const result = await runAutoRefresh(db, "full");
    expect(result).not.toBeNull();
    expect(mocks.classifyOptionSectors).toHaveBeenCalledTimes(1);
  });

  it("skips option-sector classification when nothing is unsectored", async () => {
    mocks.getUnsectoredOptionUnderlyings.mockReturnValue([]);
    await runAutoRefresh(db, "full");
    expect(mocks.classifyOptionSectors).not.toHaveBeenCalled();
  });

  it("does not run option-sector classification on quick refresh", async () => {
    mocks.getUnsectoredOptionUnderlyings.mockReturnValue(["XYZ"]);
    await runAutoRefresh(db, "quick");
    expect(mocks.classifyOptionSectors).not.toHaveBeenCalled();
  });

  it("runs factor classification on full refresh (Step 2.6), not quick", async () => {
    await runAutoRefresh(db, "full");
    expect(mocks.classifyFactors).toHaveBeenCalledTimes(1);

    resetSyncState();
    vi.clearAllMocks();
    await runAutoRefresh(db, "quick");
    expect(mocks.classifyFactors).not.toHaveBeenCalled();
  });

  it("factor-classification failure is isolated — pipeline still succeeds", async () => {
    mocks.classifyFactors.mockRejectedValueOnce(new Error("Claude down"));
    const result = await runAutoRefresh(db, "full");
    expect(result).not.toBeNull();
    expect(mocks.detectAndFireAlerts).toHaveBeenCalled();
  });

  it("option-sector classification failure is isolated — pipeline still succeeds", async () => {
    mocks.getUnsectoredOptionUnderlyings.mockReturnValue(["XYZ"]);
    mocks.classifyOptionSectors.mockRejectedValueOnce(new Error("Claude down"));
    const result = await runAutoRefresh(db, "full");
    expect(result).not.toBeNull();
    // Best-effort: the failure must not abort later steps
    expect(mocks.detectAndFireAlerts).toHaveBeenCalled();
  });
});
