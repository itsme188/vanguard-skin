/**
 * Level-scan cycle — the shared post-price-refresh alert sequence:
 *   1. drain cloud-fired level markers (Worker fired Pushover while Mac slept)
 *   2. detect crossed levels + fire alerts
 *   3. post the mac-recent-scan marker so the Worker skips its next cloud scan
 *   4. Claude one-liner suggestions for anything that fired
 *
 * Extracted from auto-refresh Step 6 (R1b, 2026-07-07) so the IBKR Web API
 * disconnected refresh runs the identical cycle — MA-based levels only resolve
 * Mac-side (the cloud scan covers static levels only), so without this the
 * away-from-home path refreshed prices but never fired alerts on them.
 *
 * Reconcile / marker / suggestion failures are isolated (warn + continue);
 * a detect failure propagates — callers wrap the cycle best-effort.
 * DI-shaped for tests (see tests/alerts/scan-cycle.test.ts).
 */

import type Database from "better-sqlite3";
import { detectAndFireAlerts } from "./detect";
import {
  postMacRecentScanMarker,
  reconcileCloudFiredLevels,
} from "./reconcile-cloud-fired";
import { generateSuggestionsForPendingAlerts } from "./generate-suggestion";

export interface LevelScanCycleResult {
  reconciled: number;
  scanned: number;
  fired: number;
  deduped: number;
  suggestionsGenerated: number;
}

export interface LevelScanCycleDeps {
  reconcile: typeof reconcileCloudFiredLevels;
  detect: typeof detectAndFireAlerts;
  postMarker: typeof postMacRecentScanMarker;
  suggest: typeof generateSuggestionsForPendingAlerts;
}

export async function runLevelScanCycle(
  db: Database.Database,
  opts: { cronSecret?: string | null; logPrefix?: string } = {},
  deps: Partial<LevelScanCycleDeps> = {},
): Promise<LevelScanCycleResult> {
  const prefix = opts.logPrefix ?? "[level-scan]";
  const cronSecret = opts.cronSecret ?? null;
  const reconcile = deps.reconcile ?? reconcileCloudFiredLevels;
  const detect = deps.detect ?? detectAndFireAlerts;
  const postMarker = deps.postMarker ?? postMacRecentScanMarker;
  const suggest = deps.suggest ?? generateSuggestionsForPendingAlerts;

  // Drain cloud-fired markers FIRST so the inbox catches up before the local
  // scan runs — triggerLevel's hasAlertToday guard then dedups against them.
  let reconciled = 0;
  if (cronSecret) {
    try {
      const r = await reconcile(db, cronSecret);
      reconciled = r.reconciled;
      if (r.reconciled > 0) {
        console.log(
          `${prefix} Cloud-fired levels reconciled: ${r.reconciled}, ` +
            `${r.skipped_already_alerted} already-alerted, ` +
            `${r.skipped_level_missing} level-missing`,
        );
      }
    } catch (err) {
      console.warn(`${prefix} Cloud-fired level reconcile failed:`, err);
    }
  }

  const d = detect(db);
  console.log(
    `${prefix} Alerts: ${d.fired} fired, ${d.deduped} deduped, ${d.scanned} scanned`,
  );

  // Tell the Worker the Mac just scanned. Fire-and-forget; never blocks.
  if (cronSecret) {
    void postMarker(cronSecret);
  }

  let suggestionsGenerated = 0;
  if (d.fired > 0) {
    try {
      const s = await suggest(db);
      suggestionsGenerated = s.generated;
      console.log(`${prefix} Suggestions: ${s.generated} generated, ${s.failed} failed`);
    } catch (err) {
      console.warn(`${prefix} Suggestion generation wrapper failed:`, err);
    }
  }

  return {
    reconciled,
    scanned: d.scanned,
    fired: d.fired,
    deduped: d.deduped,
    suggestionsGenerated,
  };
}
