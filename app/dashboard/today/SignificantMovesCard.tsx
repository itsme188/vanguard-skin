/**
 * Significant Moves in Vanguard Holdings (vs. expected) — Today-tab surface.
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

import { db } from "@/lib/db";
import { computeAnomalies } from "@/lib/digest/anomalies";
import { SymbolLink } from "@/app/dashboard/components/SymbolLink";
import { Chip } from "@/app/dashboard/components/Chip";
import { EmptySection } from "@/app/dashboard/components/EmptySection";

const TITLE = "Significant Moves in Vanguard Holdings";

function signedPct(value: number, decimals = 1): string {
  const rounded = parseFloat(value.toFixed(decimals));
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${rounded.toFixed(decimals)}%`;
}

export function SignificantMovesCard() {
  const flags = computeAnomalies(db);

  if (flags.length === 0) {
    return (
      <EmptySection
        title={TITLE}
        reason="No Vanguard holdings moved significantly more than their beta predicted today."
        hint="A name is flagged when its daily move is at least 3% AND at least 2 standard deviations beyond that stock's own normal day-to-day noise (after adjusting for SPY). Needs cached betas, a residual volatility, and two consecutive closes."
      />
    );
  }

  return (
    <section className="rounded-xl bg-panel p-4 card-elev">
      <div className="mb-2 flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-medium text-ink">{TITLE}</h2>
        <span className="text-[11px] text-ink-faint font-mono">
          vs. expected · {flags.length} flagged
        </span>
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
                      <span className="text-[11px] text-ink-faint truncate">
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
