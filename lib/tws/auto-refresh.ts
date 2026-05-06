/**
 * Auto-refresh pipeline — orchestrates the full data sync sequence
 * after a TWS connection is established.
 *
 * Pipeline:
 *   1. syncPortfolio()         — positions + account values + live prices (15s)
 *   2. enrichSecurities()      — TWS contract details for new securities (rate-limited)
 *   3. fetchSnapshotPrices()   — current prices for ALL held securities (~2 min)
 *   4. computeDailyValuations()— recompute with fresh prices (instant)
 *   5. fetchBenchmarkPrices()  — benchmark ETFs, incremental (parallel with 3-4)
 *
 * Each step catches its own errors and continues — partial success is fine.
 * Uses sync-state.ts for mutex and progress tracking.
 */

import type Database from "better-sqlite3";
import {
  isSyncing,
  setSyncPhase,
  setSyncProgress,
  setSyncComplete,
  setSyncError,
  type AutoRefreshResult,
} from "./sync-state";
import { syncPortfolio } from "./positions";
import { enrichSecurities } from "./contracts";
import { purgeExpiredOptionHoldings } from "../mutations/expired-options";
import { purgeClosedOptionHoldings } from "../mutations/closed-positions";
import { fetchSnapshotPrices } from "./snapshot";
import { fetchBenchmarkPrices } from "./benchmark";
import { computeDailyValuations } from "../compute/daily-valuation";
import { detectAndFireAlerts } from "../alerts/detect";
import { generateSuggestionsForPendingAlerts } from "../alerts/generate-suggestion";

export type RefreshLevel = "full" | "quick";

/**
 * Run the auto-refresh pipeline.
 *
 * - `full`: all 5 steps (on initial connect)
 * - `quick`: snapshot prices + valuations only (for periodic refresh)
 *
 * Returns immediately if a sync is already in progress (mutex).
 */
export async function runAutoRefresh(
  db: Database.Database,
  level: RefreshLevel = "full",
): Promise<AutoRefreshResult | null> {
  if (isSyncing()) {
    console.log("[auto-refresh] Sync already in progress, skipping");
    return null;
  }

  const startTime = Date.now();
  const errors: string[] = [];
  let positionsSynced = 0;
  let securitiesEnriched = 0;
  let pricesUpdated = 0;
  let valuationsRecomputed = false;
  let benchmarksSynced = 0;
  let alertsFired = 0;

  try {
    // ── Step 1: Sync Portfolio (full only) ──────────────────────
    if (level === "full") {
      setSyncPhase("positions");
      try {
        const result = await syncPortfolio(db, {
          onProgress: (p) => {
            setSyncProgress({
              current: p.current ?? 0,
              total: p.total ?? 0,
              label: p.message,
            });
          },
        });
        positionsSynced = result.positionsSynced;
        console.log(
          `[auto-refresh] Positions synced: ${result.positionsSynced}, prices: ${result.pricesSaved}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Position sync failed";
        errors.push(msg);
        console.error("[auto-refresh] Position sync error:", msg);
      }
    }

    // ── Step 1.5: Purge expired option holdings ─────────────────
    // Statement-sourced rows linger after expiry because new snapshots don't
    // delete-and-replace; sweeping here keeps briefings + rollups accurate.
    try {
      const purged = purgeExpiredOptionHoldings(db);
      if (purged > 0) {
        console.log(`[auto-refresh] Purged ${purged} expired option holdings`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Expired-option purge failed";
      errors.push(msg);
      console.error("[auto-refresh] Expired-option purge error:", msg);
    }

    // ── Step 1.6: Purge closed-but-not-expired option holdings ──
    // Sister to 1.5: handles long calls/puts that were sold via
    // SELL_TO_CLOSE (or short positions bought back) before expiry. TWS
    // auto-refresh writes only ACTIVE positions, so without this sweep a
    // closed option lingers at its last statement quantity until expiry
    // (months later) and shows up in earnings recap "Your position" blocks
    // for a position you no longer hold.
    try {
      const purged = purgeClosedOptionHoldings(db);
      if (purged > 0) {
        console.log(`[auto-refresh] Purged ${purged} closed option holdings`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Closed-option purge failed";
      errors.push(msg);
      console.error("[auto-refresh] Closed-option purge error:", msg);
    }

    // ── Step 2: Enrich Securities (full only) ───────────────────
    if (level === "full") {
      // Check if any securities need enrichment before burning time
      const unenriched = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM securities s
           JOIN holdings h ON h.security_id = s.id AND h.quantity > 0
           WHERE s.ib_con_id IS NULL
             AND LOWER(COALESCE(s.security_type, '')) NOT IN ('bond', 'money_market')`,
        )
        .get() as { cnt: number };

      if (unenriched.cnt > 0) {
        setSyncPhase("enriching", {
          current: 0,
          total: unenriched.cnt,
          label: `Enriching ${unenriched.cnt} securities...`,
        });
        try {
          const results = await enrichSecurities(db);
          securitiesEnriched = results.filter((r) => r.enriched).length;
          const enrichErrors = results.filter((r) => r.error);
          if (enrichErrors.length > 0) {
            errors.push(
              `${enrichErrors.length} enrichment errors`,
            );
          }
          console.log(
            `[auto-refresh] Enriched: ${securitiesEnriched}/${results.length}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Enrichment failed";
          errors.push(msg);
          console.error("[auto-refresh] Enrichment error:", msg);
        }
      } else {
        console.log("[auto-refresh] All securities already enriched, skipping");
      }
    }

    // ── Steps 3-5: Prices + Valuations + Benchmarks (parallel where possible) ──

    // Start benchmark fetch in parallel (independent of price fetch)
    const benchmarkPromise =
      level === "full"
        ? (async () => {
            try {
              const results = await fetchBenchmarkPrices(db, {
                incremental: true,
              });
              benchmarksSynced = results.reduce(
                (sum, r) => sum + r.barsInserted,
                0,
              );
              console.log(
                `[auto-refresh] Benchmarks: ${benchmarksSynced} bars inserted`,
              );
            } catch (err) {
              const msg =
                err instanceof Error ? err.message : "Benchmark sync failed";
              errors.push(msg);
              console.error("[auto-refresh] Benchmark error:", msg);
            }
          })()
        : Promise.resolve();

    // Step 3: Snapshot prices
    setSyncPhase("prices");
    try {
      const results = await fetchSnapshotPrices(db, {
        onProgress: (p) => {
          setSyncProgress({
            current: p.current,
            total: p.total,
            label: p.symbol,
          });
        },
      });
      pricesUpdated = results.filter((r) => r.price !== null).length;
      const priceErrors = results.filter((r) => r.error);
      if (priceErrors.length > 0) {
        errors.push(`${priceErrors.length} price fetch errors`);
      }
      console.log(
        `[auto-refresh] Prices updated: ${pricesUpdated}/${results.length}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Price fetch failed";
      errors.push(msg);
      console.error("[auto-refresh] Price fetch error:", msg);
    }

    // Step 4: Recompute valuations
    setSyncPhase("valuations");
    try {
      computeDailyValuations(db);
      valuationsRecomputed = true;
      console.log("[auto-refresh] Valuations recomputed");
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Valuation recompute failed";
      errors.push(msg);
      console.error("[auto-refresh] Valuation error:", msg);
    }

    // Wait for benchmark fetch to finish
    if (level === "full") {
      setSyncPhase("benchmarks");
    }
    await benchmarkPromise;

    // Step 6: Detect crossed levels + fire alerts (after prices + valuations are fresh)
    setSyncPhase("alerts");
    try {
      const detect = detectAndFireAlerts(db);
      alertsFired = detect.fired;
      console.log(
        `[auto-refresh] Alerts: ${detect.fired} fired, ${detect.deduped} deduped, ${detect.scanned} scanned`,
      );

      // Generate suggestions in parallel — awaited but tolerant of Claude errors.
      // A handful of Sonnet calls resolve in ~3-5s total (Promise.all).
      if (detect.fired > 0) {
        try {
          const s = await generateSuggestionsForPendingAlerts(db);
          console.log(
            `[auto-refresh] Suggestions: ${s.generated} generated, ${s.failed} failed`,
          );
        } catch (err) {
          console.warn("[auto-refresh] Suggestion generation wrapper failed:", err);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Alert detection failed";
      errors.push(msg);
      console.error("[auto-refresh] Alert detection error:", msg);
    }

    // ── Done ───────────────────────────────────────────────────
    const result: AutoRefreshResult = {
      positionsSynced,
      securitiesEnriched,
      pricesUpdated,
      valuationsRecomputed,
      benchmarksSynced,
      alertsFired,
      errors,
      durationMs: Date.now() - startTime,
    };

    setSyncComplete(result);
    console.log(
      `[auto-refresh] Complete in ${(result.durationMs / 1000).toFixed(1)}s — ` +
        `${positionsSynced} positions, ${pricesUpdated} prices, ${errors.length} errors`,
    );

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Auto-refresh failed";
    setSyncError(msg);
    console.error("[auto-refresh] Fatal error:", msg);

    return {
      positionsSynced,
      securitiesEnriched,
      pricesUpdated,
      valuationsRecomputed,
      benchmarksSynced,
      alertsFired,
      errors: [...errors, msg],
      durationMs: Date.now() - startTime,
    };
  }
}
