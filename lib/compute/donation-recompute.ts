import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";

export interface DonationRecomputeResult {
  recomputed: boolean;
  recomputeError?: string;
  donationsConsumed?: number;
  replayWarnings?: string[];
}

/**
 * Runs computeTaxLots(db) after a donation-mutation route's write succeeds
 * (Task 12, spec §10 recompute-failure feedback). A recompute failure never
 * turns a saved write into a 500 — the route still returns 200 with
 * `saved:true`; this only reports `recomputed:false` + `recomputeError`
 * alongside it. Every donation-mutation route (links POST/DELETE, lots
 * POST, reverse POST, resolve-security POST) calls this in its own
 * try/catch, AFTER the mutation's own try/catch has already succeeded.
 */
export function recomputeAfterDonationMutation(db: Database.Database): DonationRecomputeResult {
  try {
    const result = computeTaxLots(db);
    return {
      recomputed: true,
      donationsConsumed: result.donationsConsumed,
      replayWarnings: result.replayWarnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { recomputed: false, recomputeError: message };
  }
}
