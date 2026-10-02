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
 * list above. Supersession of recon rows is directional — see
 * statementOverwritableHoldingSql / liveOverwritableHoldingSql.
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
 * Statement PREFIXES ONLY — never matches a recon tombstone. Distinct from
 * `statementGradeHoldingSql` below, which additionally admits `:stmt` and
 * legacy unsuffixed tombstones (closure evidence DERIVED from a statement).
 * Use this one for "what did the statement itself say" (bond carry-forward,
 * the reconciler's own statement-date/shrink math, tombstone-orphan checks);
 * use the statement-grade one for "what is the newest statement evidence
 * for this pair" (the synthetic-close anchor).
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

/**
 * Engine-owned tombstone prefix (reconcileClosedEquityHoldings; always
 * quantity = 0). A tombstone is a DERIVED row, never authority: any real
 * row may supersede it, subject to the directional rules below. New
 * tombstones append an origin suffix recording the minting pass; legacy
 * rows have none and are treated as statement-grade (conservative).
 */
export const RECON_HOLDING_SOURCE_PREFIX = "recon:closed-equity:";
export const RECON_STMT_SUFFIX = ":stmt"; // minted by the statement pass
export const RECON_LIVE_SUFFIX = ":live"; // minted by the equity/option live passes

/**
 * SQL fragment: rows a STATEMENT-authority writer (import commit, recovery
 * restore) may overwrite in a same-slot upsert — live rows plus ANY
 * tombstone. Statement evidence outranks every tombstone origin.
 * Parenthesized; constants carry no wildcards/quotes (pinned by tests), so
 * direct interpolation stays safe in reused prepared statements.
 */
export function statementOverwritableHoldingSql(col = "holdings.source_key"): string {
  const live = LIVE_HOLDING_SOURCE_PREFIXES.map((p) => `${col} LIKE '${p}%'`);
  return `(${[...live, `${col} LIKE '${RECON_HOLDING_SOURCE_PREFIX}%'`].join(" OR ")})`;
}

/**
 * SQL fragment: rows a LIVE writer (Plaid) may overwrite — live rows plus
 * only live-origin tombstones. A live row must never erase statement-derived
 * closure evidence: the statement pass's `latest < stmtDate` phantom test
 * cannot re-derive a tombstone masked by a same-date live row.
 */
export function liveOverwritableHoldingSql(col = "holdings.source_key"): string {
  const live = LIVE_HOLDING_SOURCE_PREFIXES.map((p) => `${col} LIKE '${p}%'`);
  return `(${[...live, `${col} LIKE '${RECON_HOLDING_SOURCE_PREFIX}%${RECON_LIVE_SUFFIX}'`].join(" OR ")})`;
}

/**
 * SQL fragment for a recon tombstone with NO origin suffix (minted before the
 * suffixes existed — by EITHER the statement pass or the old live pass).
 * NULL-safe: `key` is expected to be COALESCE'd by the caller.
 */
function legacyReconSql(key: string): string {
  return `(${key} LIKE '${RECON_HOLDING_SOURCE_PREFIX}%' AND ${key} NOT LIKE '%${RECON_STMT_SUFFIX}' AND ${key} NOT LIKE '%${RECON_LIVE_SUFFIX}')`;
}

/**
 * EXISTS: the row's account carries a statement-prefix holdings row on the
 * row's own date — the evidence that a legacy unsuffixed tombstone there was
 * minted by the statement pass (a statement pass only ever tombstones AT the
 * statement date). Subquery alias is derived from the row alias so the
 * fragment nests safely.
 */
function sameDateStatementRowSql(alias: string): string {
  const j = `_sgj_${alias}`;
  return `EXISTS (SELECT 1 FROM holdings ${j}
      WHERE ${j}.account_id = ${alias}.account_id AND ${j}.as_of_date = ${alias}.as_of_date
        AND ${statementSourcedHoldingSql(`${j}.source_key`)})`;
}

/**
 * SQL fragment: STATEMENT-GRADE evidence for the holdings row aliased
 * `alias` — a statement-prefix row (`statementSourcedHoldingSql`), a
 * statement-pass tombstone (`:stmt`), or a LEGACY unsuffixed tombstone that is
 * JUSTIFIED by a statement-prefix row of the same account on the same date.
 * A legacy tombstone on a date with no statement row was minted by the old
 * live pass and is live-origin (`liveOriginHoldingSql`) — user ruling
 * 2026-10-02 "only statement evidence" (landing review I2). No data is
 * relabelled; the classification is derived on read.
 *
 * Takes a ROW ALIAS (not a column) because the legacy rule reads
 * `account_id` / `as_of_date` too. Deliberately DISTINCT from
 * `statementSourcedHoldingSql`, which stays statement-prefix-only: recon
 * tombstones remain outside the statement/live taxonomy for every existing
 * caller of that helper. Used IDENTICALLY by the synthetic-close anchor
 * (computeTaxLots), the generation-bump triggers (tax-convention,
 * closed-equity), the reconciler's statement pass and the pending read
 * model. NULL-safe (a NULL key is neither class, and `NOT (…)` is TRUE).
 * Parenthesized; constants carry no wildcards/quotes (pinned by tests).
 */
export function statementGradeHoldingSql(alias = "h"): string {
  const key = `COALESCE(${alias}.source_key, '')`;
  return `(${statementSourcedHoldingSql(key)}
    OR ${key} LIKE '${RECON_HOLDING_SOURCE_PREFIX}%${RECON_STMT_SUFFIX}'
    OR (${legacyReconSql(key)} AND ${sameDateStatementRowSql(alias)}))`;
}

/**
 * SQL fragment: LIVE-ORIGIN evidence for the holdings row aliased `alias` —
 * a live-sync row (tws-, plaid:), a live-pass tombstone (`:live`), or a
 * legacy unsuffixed tombstone with NO same-date statement row (old live
 * pass; see `statementGradeHoldingSql`). Disjoint from
 * `statementGradeHoldingSql`. NULL-safe. Parenthesized.
 */
export function liveOriginHoldingSql(alias = "h"): string {
  const key = `COALESCE(${alias}.source_key, '')`;
  const live = LIVE_HOLDING_SOURCE_PREFIXES.map((p) => `${key} LIKE '${p}%'`);
  return `(${[
    ...live,
    `${key} LIKE '${RECON_HOLDING_SOURCE_PREFIX}%${RECON_LIVE_SUFFIX}'`,
    `(${legacyReconSql(key)} AND NOT ${sameDateStatementRowSql(alias)})`,
  ].join(" OR ")})`;
}
