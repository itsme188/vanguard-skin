/**
 * Chat evaluation: the fixture manifest build-eval-db.ts writes into the
 * eval database's `settings` table. Symbols and dates only; every figure
 * the questions are checked against is derived from the database at run
 * time (expected.ts), so the manifest never goes stale against the data.
 */

import type Database from "better-sqlite3";

export const EVAL_MANIFEST_KEY = "chat_eval_manifest";

export interface EvalManifest {
  version: string;
  /** The Eastern day the fixture was built for (its relative dates hang off it). */
  builtFor: string;
  /** The weekday the fixture's closing prices are dated. */
  priceDay: string;
  accounts: { taxable: string; roth: string; ibkr: string };
  rothLoser: string;
  harvestCandidate: string;
  pendingLot: string;
  short: string;
  foreign: { symbol: string; currency: string };
  longTermWait: { symbol: string; acquired: string };
  bill: { symbol: string; maturity: string };
  liveOption: { symbol: string; underlying: string; expiry: string };
  expiredOption: { symbol: string; underlying: string; expiry: string };
  reinvestedDividend: { symbol: string; date: string };
  /** A name held in more than one account, with an option on it. */
  multiAccountName: string;
  /** A ticker that is not on file. */
  unknownTicker: string;
}

export function readManifest(db: Database.Database): EvalManifest | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(EVAL_MANIFEST_KEY) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as EvalManifest) : null;
  } catch {
    return null;
  }
}
