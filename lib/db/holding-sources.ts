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
 *
 * Two prefixes deliberately live OUTSIDE this taxonomy (neither statement
 * authority nor live sync): 'recon:closed-equity:' (engine-owned
 * reconciliation rows — always quantity=0, so inert for the bond
 * carry-forward and every value predicate) and 'demo-hold-'
 * (scripts/seed-demo.ts dev-only seed data). Do not add them to either
 * list above.
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

/**
 * Classifies a holdings row's provenance from its `source_key` prefix, built
 * on the same STATEMENT_HOLDING_SOURCE_PREFIXES / LIVE_HOLDING_SOURCE_PREFIXES
 * lists as statementSourcedHoldingSql / isPlaidSourcedHolding — single source
 * of truth for "is this row statement authority or a live sync."
 *
 * Returns "statement" only for a recognized statement-authority prefix.
 * Everything else — a recognized live prefix (tws-, plaid:), null, or an
 * unrecognized prefix (including the two prefixes deliberately outside this
 * taxonomy: 'recon:closed-equity:' and 'demo-hold-') — classifies "live".
 * This is a deliberately defensive default: an unrecognized source_key must
 * never silently read as statement authority.
 */
export function classifyHoldingSourceKey(sourceKey: string | null): "statement" | "live" {
  if (sourceKey && STATEMENT_HOLDING_SOURCE_PREFIXES.some((p) => sourceKey.startsWith(p))) {
    return "statement";
  }
  return "live";
}
