/**
 * Significant Moves (vs. expected) — Analysis · Diagnostics surface.
 *
 * Server component reusing the SAME engine that powers the evening email's
 * anomaly block (lib/digest/anomalies.ts::computeAnomalies). Flags holdings
 * whose daily move deviates from what their beta predicts given SPY's move.
 *
 * Scope (owner ruling 2026-10-08): the card follows the page's scope
 * selector. It evaluates the current long book of exactly the accounts the
 * page resolved, and its title, coverage line and quiet text name that scope.
 * It reads completed sessions only: a close dated today is ignored until
 * 16:00 ET (rule single-sourced in the engine module).
 *
 * Privacy: all numbers here are PUBLIC market data (% moves, beta, SPY move) —
 * they appear identically on any terminal — so they are NOT masked. No $
 * amounts, share counts, or position sizing is rendered (per the anomalies
 * module's privacy contract).
 */

import type Database from "better-sqlite3";
import { db } from "@/lib/db";
import {
  computeAnomalies,
  isMoverSecurityType,
  latestCompletedSession,
  resolveTradingDayPair,
} from "@/lib/digest/anomalies";
import { BETA_LOOKBACK_DAYS } from "@/lib/queries/security-betas";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { SymbolLink } from "@/app/dashboard/components/SymbolLink";
import { Chip } from "@/app/dashboard/components/Chip";
import { EmptySection } from "@/app/dashboard/components/EmptySection";
import { Count } from "@/lib/privacy/components";

/** How the card names the scope on screen, in its title and its sentences. */
export interface ScopeWording {
  title: string;
  /** Plural noun phrase, e.g. "IBKR holdings". */
  plural: string;
  /** Singular noun phrase, e.g. "IBKR holding". */
  singular: string;
}

/**
 * `scopeLabel` is the scope pill's own label ("Vanguard", "IBKR", "Roth").
 * `allAccounts` is true when the page resolved no account filter; the wording
 * then says "all accounts" whatever the label, so the card never names a scope
 * narrower than the one it evaluated.
 */
export function scopeWording(scopeLabel: string, allAccounts: boolean): ScopeWording {
  if (allAccounts) {
    return {
      title: "Significant Moves Across All Accounts",
      plural: "holdings across all accounts",
      singular: "holding across all accounts",
    };
  }
  return {
    title: `Significant Moves in ${scopeLabel} Holdings`,
    plural: `${scopeLabel} holdings`,
    singular: `${scopeLabel} holding`,
  };
}

/**
 * The accounts the card evaluates. The page hands over its resolved ids, or
 * nothing for "all accounts"; that case is expanded to every account id here
 * because the engine reads an omitted list as the evening email's
 * Vanguard-only universe.
 */
export function scopeAccountIds(
  db: Database.Database,
  accountIds: readonly number[] | undefined,
): number[] {
  if (accountIds !== undefined) return [...accountIds];
  return (db.prepare("SELECT id FROM accounts ORDER BY id").all() as { id: number }[]).map(
    (r) => r.id,
  );
}

function signedPct(value: number, decimals = 1): string {
  const rounded = parseFloat(value.toFixed(decimals));
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${rounded.toFixed(decimals)}%`;
}

/** What is flagged, in words. Shown in the open on every empty state. */
const THRESHOLD_HINT =
  "A name is flagged when its daily move is at least 3% AND at least 2 standard deviations beyond that stock's own normal day-to-day noise (after adjusting for SPY). Needs cached betas, a residual volatility, and two consecutive closes.";

export interface MovesCoverage {
  /** Equity-like long holdings in the scope's accounts: the names the engine checks. */
  total: number;
  /** Of those, how many have a cached beta AND a close on both pair dates. */
  evaluated: number;
  /** Of those, how many have no cached beta. */
  missingBeta: number;
  /** Of those, how many lack a close on one of the two pair dates. */
  missingCloses: number;
}

/**
 * Coverage of the universe the engine checks. The engine skips any holding
 * that is not an equity-like type (`isMoverSecurityType`: no option, bond,
 * untyped or unrecognized row) or has no symbol to print, so those are in
 * neither "evaluated" nor "of M" here, nor in the two missing-input counts.
 */
export function loadCoverage(
  db: Database.Database,
  pair: { latest: string; prior: string },
  accountIds: readonly number[],
): MovesCoverage {
  const coverage: MovesCoverage = { total: 0, evaluated: 0, missingBeta: 0, missingCloses: 0 };
  if (accountIds.length === 0) return coverage;
  const placeholders = accountIds.map(() => "?").join(",");
  // One row per security: beta and the two closes are per security, so a
  // name held in two accounts of the scope is still one holding.
  const rows = db
    .prepare(
      `SELECT DISTINCT
              s.id AS security_id,
              s.symbol,
              s.security_type,
              sb.beta IS NOT NULL AS has_beta,
              (p_latest.close_price IS NOT NULL
                AND p_prior.close_price IS NOT NULL
                AND p_prior.close_price != 0) AS has_closes
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN security_betas sb
              ON sb.security_id = s.id AND sb.lookback_days = ${BETA_LOOKBACK_DAYS}
       LEFT JOIN prices p_latest ON p_latest.security_id = s.id AND p_latest.date = ?
       LEFT JOIN prices p_prior ON p_prior.security_id = s.id AND p_prior.date = ?
       WHERE h.account_id IN (${placeholders})
         AND UPPER(s.symbol) != 'SPY'
         AND ${latestHoldingsPredicate({ includeShorts: false })}`,
    )
    .all(pair.latest, pair.prior, ...accountIds) as {
    security_id: number;
    symbol: string | null;
    security_type: string | null;
    has_beta: number;
    has_closes: number;
  }[];

  for (const row of rows) {
    // The engine's own two universe skips, in its order.
    if (!isMoverSecurityType(row.security_type)) continue;
    if (!row.symbol) continue;
    coverage.total += 1;
    if (row.has_beta && row.has_closes) coverage.evaluated += 1;
    if (!row.has_beta) coverage.missingBeta += 1;
    if (!row.has_closes) coverage.missingCloses += 1;
  }
  return coverage;
}

// The completed-session rule lives in the engine module; re-exported here for
// the callers and tests that reach it through the card.
export { latestCompletedSession };

/** The resolved pair ends before the latest completed session: stale closes. */
export function isOlderSession(pairLatest: string, now = new Date()): boolean {
  return pairLatest < latestCompletedSession(now);
}

const OLDER_SESSION_LABEL = "older session — no newer close on file";

/**
 * The coverage counts may be printed beside `flagCount` visible flags only if
 * they can account for them. The engine also evaluates positions this card's
 * coverage query does not count, so the line could read "0 of 0" above a
 * flagged row; then the card says coverage is unavailable instead.
 */
export function coverageAccountsForFlags(coverage: MovesCoverage, flagCount: number): boolean {
  return coverage.evaluated >= flagCount;
}

function CoverageLine({ evaluated, total }: { evaluated: number; total: number }) {
  return (
    <p className="text-[11px] text-ink-faint font-mono">
      Evaluated <Count value={evaluated} /> of <Count value={total} /> holdings with cached beta and pair-date closes.
    </p>
  );
}

export function SignificantMovesCard({
  accountIds,
  scopeLabel,
}: {
  /** The page's resolved account ids; omitted means all accounts. */
  accountIds?: readonly number[];
  /** The active scope pill's label. */
  scopeLabel: string;
}) {
  const scope = scopeWording(scopeLabel, accountIds === undefined);
  // One clock reading for the pair, the engine and the staleness label.
  const now = new Date();
  const pair = resolveTradingDayPair(db, { completedOnly: true, now });
  if (!pair) {
    return (
      <EmptySection
        title={scope.title}
        reason="Could not evaluate significant moves because the latest SPY trading-day pair is unavailable."
        hint="The card needs two consecutive SPY closes before it can compare held names against beta-adjusted expectations."
      />
    );
  }

  const ids = scopeAccountIds(db, accountIds);
  const coverage = loadCoverage(db, pair, ids);
  const flags = computeAnomalies(db, { accountIds: ids, now });
  const olderSession = isOlderSession(pair.latest, now);

  if (flags.length === 0) {
    const quiet = quietState(coverage, pair, olderSession, scope);
    return (
      <div>
        <EmptySection title={scope.title} reason={quiet.reason} hint={quiet.hint} />
        {quiet.showCoverage && (
          <div className="mt-1 px-4 sm:px-5">
            <CoverageLine evaluated={coverage.evaluated} total={coverage.total} />
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="rounded-xl bg-panel p-4 card-elev">
      <div className="mb-2 flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-medium text-ink">{scope.title}</h2>
        <span className="text-[11px] text-ink-faint font-mono">
          vs. expected · <Count value={flags.length} /> flagged · {pair.prior} to {pair.latest}
          {olderSession ? ` · ${OLDER_SESSION_LABEL}` : ""}
        </span>
      </div>
      <div className="mb-2">
        {coverageAccountsForFlags(coverage, flags.length) ? (
          <CoverageLine evaluated={coverage.evaluated} total={coverage.total} />
        ) : (
          <p className="text-[11px] text-ink-faint font-mono">Coverage unavailable.</p>
        )}
      </div>

      <ul className="divide-y divide-edge -mx-4">
        {flags.map((f) => {
          const up = f.actualPct >= 0;
          return (
            <li key={f.securityId} className="px-4 py-2">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[14px] font-medium">
                      <SymbolLink securityId={f.securityId} symbol={f.symbol} />
                    </span>
                    {f.companyName && f.companyName !== f.symbol ? (
                      <span className="text-[11px] text-ink-faint truncate" title={f.companyName}>
                        {f.companyName}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[12px] text-ink-faint font-mono mt-0.5">
                    expected {signedPct(f.expectedPct)} (β {f.beta.toFixed(1)} × SPY{" "}
                    {signedPct(f.spyPct)})
                  </div>
                </div>
                <div className="text-right shrink-0 flex items-center gap-2">
                  <Chip tone={f.directionFlipped ? "warn" : up ? "up" : "down"}>
                    {f.directionFlipped
                      ? "Direction flipped"
                      : f.zScore != null
                        ? `${f.zScore.toFixed(1)}σ`
                        : signedPct(f.actualPct)}
                  </Chip>
                  <span
                    className={`text-[14px] font-mono tabular-nums ${up ? "text-up" : "text-down"}`}
                  >
                    {signedPct(f.actualPct)}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The empty state when nothing is flagged. "Nothing moved" is only ever said
 * about holdings that were actually evaluated:
 *   - no holdings in scope      → say that;
 *   - none could be evaluated   → say that and why, never "nothing moved";
 *   - only some were evaluated  → the quiet-day sentence is limited to them
 *                                 (the masked counts sit in the coverage line);
 *   - all were evaluated        → the plain quiet-day sentence.
 * No count appears in these strings: holding counts are portfolio figures and
 * render only through <Count>.
 */
export function quietState(
  coverage: MovesCoverage,
  pair: { latest: string; prior: string },
  olderSession: boolean,
  scope: ScopeWording,
): { reason: string; hint: string; showCoverage: boolean } {
  const dated = olderSession ? `${pair.latest} (${OLDER_SESSION_LABEL})` : pair.latest;

  if (coverage.total === 0) {
    return {
      reason: `No ${scope.plural} are in scope for this card.`,
      hint: "It covers long positions held in the accounts of the scope selected above.",
      showCoverage: false,
    };
  }

  if (coverage.evaluated === 0) {
    const why =
      coverage.missingBeta >= coverage.total
        ? "none of them has a beta on file"
        : coverage.missingCloses >= coverage.total
          ? `none of them has a close on both ${pair.prior} and ${pair.latest}`
          : `each is missing a cached beta or a close on ${pair.prior} or ${pair.latest}`;
    return {
      reason: `No ${scope.singular} could be evaluated for ${pair.prior} to ${dated}: ${why}. This is not a finding that nothing moved.`,
      hint: THRESHOLD_HINT,
      showCoverage: false,
    };
  }

  if (coverage.evaluated < coverage.total) {
    return {
      reason: `Among the ${scope.plural} that could be evaluated, none moved significantly more than its beta predicted from ${pair.prior} to ${dated}. The rest were not checked.`,
      hint: THRESHOLD_HINT,
      showCoverage: true,
    };
  }

  return {
    reason: `No ${scope.plural} moved significantly more than their beta predicted from ${pair.prior} to ${dated}.`,
    hint: THRESHOLD_HINT,
    showCoverage: true,
  };
}
