/**
 * Provenance vocabulary for `holdings.source_key` prefixes.
 *
 * Sibling of live-sources.ts, which owns the same concept for
 * `monthly_snapshots.source`. Holdings do not carry a `source` column — the
 * provenance is encoded in the `source_key` prefix each writer stamps — so
 * consumers have to pattern-match, and the prefix list must live in exactly
 * one place.
 *
 * STATEMENT rows are the end-of-day authority: an imported broker statement
 * or holdings file. Which prefix a given row carries depends only on WHICH
 * importer ran, not on what the row means — all six are one class, the same
 * class lib/import/engine.ts:431-436 describes in prose when it lets
 * statement rows overwrite intra-day live rows.
 *
 * LIVE rows are current-value syncs (TWS intra-day, Plaid daily). They are
 * never statement authority: a live sync legitimately drops positions the
 * broker no longer reports, so treating one as authority would resurrect
 * closed positions.
 *
 * Matching only ONE statement prefix is a silent-regression hazard, which is
 * why this list exists: the bond carry-forward in
 * lib/compute/daily-valuation.ts originally matched `canonical:%` alone.
 * Every bond row happens to be canonical: today, so it worked — but the first
 * month a Vanguard bond arrived through the PDF statement path (the primary
 * format of the monthly import workflow) the carry would have stopped and the
 * bond's value would have dropped back into the cash plug with no alarm.
 *
 * When a new importer is added, add its holdings prefix here.
 */

/** Every prefix an importer stamps on a statement-sourced holdings row. */
export const STATEMENT_HOLDING_SOURCE_PREFIXES = [
  "canonical:hold:",          // lib/import/parsers/canonical-csv.ts
  "vanguard-pdf:holding:",    // lib/import/parsers/vanguard-pdf.ts
  "vanguard:holding:",        // lib/import/parsers/vanguard-holdings.ts
  "vanguard-export:holding:", // lib/import/parsers/vanguard-export.ts
  "ibkr:pos:",                // lib/import/parsers/ibkr-activity.ts
  "ibkr:holding:",            // lib/import/parsers/ibkr-holdings.ts
] as const;

/** Prefixes stamped by live broker syncs — never statement authority. */
export const LIVE_HOLDING_SOURCE_PREFIXES = [
  "tws-",   // lib/tws/positions.ts, lib/ibkr/refresh.ts
  "plaid:", // lib/plaid/refresh.ts
] as const;

const PLAID_PREFIX = "plaid:";

/**
 * SQL fragment: the holdings row came from an imported statement.
 *
 * Returns a parenthesized OR-chain so it can be AND-ed into a larger WHERE
 * without the OR swallowing sibling conditions. The prefixes are compile-time
 * constants containing no LIKE wildcards (`%`/`_`) or quotes — pinned by
 * tests/db/holding-sources.test.ts — so direct interpolation is safe and
 * keeps the fragment usable inside a reused prepared statement.
 */
export function statementSourcedHoldingSql(col = "h.source_key"): string {
  return `(${STATEMENT_HOLDING_SOURCE_PREFIXES.map((p) => `${col} LIKE '${p}%'`).join(" OR ")})`;
}

/** True when the holdings row came from the Plaid daily sync. */
export function isPlaidSourcedHolding(sourceKey: string | null): boolean {
  return sourceKey?.startsWith(PLAID_PREFIX) ?? false;
}
