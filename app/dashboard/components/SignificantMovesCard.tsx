/**
 * Significant Moves in Vanguard Holdings (vs. expected) — Analysis · Diagnostics surface.
 *
 * Server component reusing the SAME engine that powers the evening email's
 * anomaly block (lib/digest/anomalies.ts::computeAnomalies). Flags Vanguard
 * (non-Roth) holdings whose daily move deviates from what their beta predicts
 * given SPY's move.
 *
 * Privacy: all numbers here are PUBLIC market data (% moves, beta, SPY move) —
 * they appear identically on any terminal — so they are NOT masked. No $
 * amounts, share counts, or position sizing is rendered (per the anomalies
 * module's privacy contract).
 */

import type Database from "better-sqlite3";
import { db } from "@/lib/db";
import { computeAnomalies, resolveTradingDayPair } from "@/lib/digest/anomalies";
import { addDays, nowET, todayET } from "@/lib/calendar/date-utils";
import { isMarketClosed } from "@/lib/calendar/market-holidays";
import { BETA_LOOKBACK_DAYS } from "@/lib/queries/security-betas";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { SymbolLink } from "@/app/dashboard/components/SymbolLink";
import { Chip } from "@/app/dashboard/components/Chip";
import { EmptySection } from "@/app/dashboard/components/EmptySection";
import { Count } from "@/lib/privacy/components";

const TITLE = "Significant Moves in Vanguard Holdings";

function signedPct(value: number, decimals = 1): string {
  const rounded = parseFloat(value.toFixed(decimals));
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${rounded.toFixed(decimals)}%`;
}

/** What is flagged, in words. Shown in the open on every empty state. */
const THRESHOLD_HINT =
  "A name is flagged when its daily move is at least 3% AND at least 2 standard deviations beyond that stock's own normal day-to-day noise (after adjusting for SPY). Needs cached betas, a residual volatility, and two consecutive closes.";

export interface MovesCoverage {
  /** Long Vanguard (non-Roth) holdings in scope. */
  total: number;
  /** Of those, how many have a cached beta AND a close on both pair dates. */
  evaluated: number;
  /** Of those, how many have no cached beta. */
  missingBeta: number;
  /** Of those, how many lack a close on one of the two pair dates. */
  missingCloses: number;
}

function loadCoverage(db: Database.Database, pair: { latest: string; prior: string }): MovesCoverage {
  const closesOk = `p_latest.close_price IS NOT NULL
            AND p_prior.close_price IS NOT NULL
            AND p_prior.close_price != 0`;
  return db
    .prepare(
      `SELECT
         COUNT(DISTINCT s.id) AS total,
         COUNT(DISTINCT CASE
           WHEN sb.beta IS NOT NULL
            AND ${closesOk}
           THEN s.id END) AS evaluated,
         COUNT(DISTINCT CASE WHEN sb.beta IS NULL THEN s.id END) AS missingBeta,
         COUNT(DISTINCT CASE WHEN NOT (${closesOk}) THEN s.id END) AS missingCloses
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN security_betas sb
              ON sb.security_id = s.id AND sb.lookback_days = ${BETA_LOOKBACK_DAYS}
       LEFT JOIN prices p_latest ON p_latest.security_id = s.id AND p_latest.date = ?
       LEFT JOIN prices p_prior ON p_prior.security_id = s.id AND p_prior.date = ?
       WHERE LOWER(a.name) LIKE '%vanguard%'
         AND LOWER(a.name) NOT LIKE '%roth%'
         AND UPPER(s.symbol) != 'SPY'
         AND ${latestHoldingsPredicate({ includeShorts: false })}`,
    )
    .get(pair.latest, pair.prior) as MovesCoverage;
}

/**
 * The most recent trading session that has CLOSED as of `now` (ET): today
 * once the 16:00 ET close has passed on a trading day, otherwise the trading
 * day before. A session still in progress is not one the card can be behind.
 */
export function latestCompletedSession(now = new Date()): string {
  let day = todayET(now);
  if (isMarketClosed(day) || nowET(now) < "16:00") day = addDays(day, -1);
  while (isMarketClosed(day)) day = addDays(day, -1);
  return day;
}

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

export function SignificantMovesCard() {
  const pair = resolveTradingDayPair(db);
  if (!pair) {
    return (
      <EmptySection
        title={TITLE}
        reason="Could not evaluate significant moves because the latest SPY trading-day pair is unavailable."
        hint="The card needs two consecutive SPY closes before it can compare held names against beta-adjusted expectations."
      />
    );
  }

  const coverage = loadCoverage(db, pair);
  const flags = computeAnomalies(db);
  const olderSession = isOlderSession(pair.latest);

  if (flags.length === 0) {
    const quiet = quietState(coverage, pair, olderSession);
    return (
      <div>
        <EmptySection title={TITLE} reason={quiet.reason} hint={quiet.hint} />
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
        <h2 className="text-sm font-medium text-ink">{TITLE}</h2>
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
): { reason: string; hint: string; showCoverage: boolean } {
  const dated = olderSession ? `${pair.latest} (${OLDER_SESSION_LABEL})` : pair.latest;

  if (coverage.total === 0) {
    return {
      reason: "No Vanguard holdings are in scope for this card.",
      hint: "It covers long positions held in Vanguard taxable (non-Roth) accounts.",
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
      reason: `No Vanguard holding could be evaluated for ${pair.prior} to ${dated}: ${why}. This is not a finding that nothing moved.`,
      hint: THRESHOLD_HINT,
      showCoverage: false,
    };
  }

  if (coverage.evaluated < coverage.total) {
    return {
      reason: `Among the Vanguard holdings that could be evaluated, none moved significantly more than its beta predicted on ${dated}. The rest were not checked.`,
      hint: THRESHOLD_HINT,
      showCoverage: true,
    };
  }

  return {
    reason: `No Vanguard holdings moved significantly more than their beta predicted on ${dated}.`,
    hint: THRESHOLD_HINT,
    showCoverage: true,
  };
}
