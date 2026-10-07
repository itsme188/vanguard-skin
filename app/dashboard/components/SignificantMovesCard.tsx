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

function loadCoverage(db: Database.Database, pair: { latest: string; prior: string }): {
  evaluated: number;
  total: number;
} {
  return db
    .prepare(
      `SELECT
         COUNT(DISTINCT s.id) AS total,
         COUNT(DISTINCT CASE
           WHEN sb.beta IS NOT NULL
            AND p_latest.close_price IS NOT NULL
            AND p_prior.close_price IS NOT NULL
            AND p_prior.close_price != 0
           THEN s.id END) AS evaluated
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
    .get(pair.latest, pair.prior) as { evaluated: number; total: number };
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

  if (flags.length === 0) {
    return (
      <section className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-medium text-ink">{TITLE}</h3>
          <span
            className="text-[11px] uppercase tracking-widest text-ink-faint cursor-help"
            title="A name is flagged when its daily move is at least 3% AND at least 2 standard deviations beyond that stock's own normal day-to-day noise (after adjusting for SPY). Needs cached betas, a residual volatility, and two consecutive closes."
          >
            empty ⓘ
          </span>
        </div>
        <p className="text-sm text-ink-faint">
          No Vanguard holdings moved significantly more than their beta predicted on {pair.latest}.
        </p>
        <div className="mt-2">
          <CoverageLine evaluated={coverage.evaluated} total={coverage.total} />
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl bg-panel p-4 card-elev">
      <div className="mb-2 flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-medium text-ink">{TITLE}</h2>
        <span className="text-[11px] text-ink-faint font-mono">
          vs. expected · {flags.length} flagged · {pair.prior} to {pair.latest}
        </span>
      </div>
      <div className="mb-2">
        <CoverageLine evaluated={coverage.evaluated} total={coverage.total} />
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
