import { dataWindowNotice } from "@/lib/compute/data-window";
import { dataWindowCoveredCaption } from "@/lib/compute/data-window-caption";
import type { PeriodAttribution } from "@/lib/compute/period-attribution";
import { Pct } from "@/lib/privacy/components";
import { EmptySection } from "./EmptySection";
import { ALPHA_PRICE_RETURN_NOTE } from "@/lib/compute/benchmark-label";

function fmtDay(iso: string): string {
  const [y, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

/**
 * Why the contributors / detractors / sector lists are empty, in the owner's
 * words. Every sentence names whose positions it means: the accounts missing a
 * book, or the selected scope (scopeName, e.g. "all accounts" or "the IBKR
 * scope"), so no reason reads as if it were about an unnamed account.
 */
function positionsEmptyText(
  attribution: PeriodAttribution,
  requestedStart: string | undefined,
  scopeName: string,
): string {
  const at = requestedStart ? `on ${fmtDay(requestedStart)}` : "at the start of this period";
  const { emptyReason, missingAccounts } = attribution.positionsBasis;
  if (emptyReason === "accounts_missing_at_start") {
    return `No position snapshot is on file for ${missingAccounts.join(", ")} ${at}, so each holding's share of the scope at the start cannot be measured.`;
  }
  if (emptyReason === "no_eligible_positions_at_start") {
    return `The positions held in ${scopeName} ${at} include no long stocks, ETFs or funds. This card weights long positions only; shorts, options and bonds are not included.`;
  }
  if (emptyReason === "no_start_price") {
    return `No closing price within a week before the start is on file for the stocks, ETFs and funds held in ${scopeName} ${at}, so their price change over the period cannot be measured.`;
  }
  if (emptyReason === "no_end_price") {
    return `No closing price within a week before the end of the period is on file for the stocks, ETFs and funds held in ${scopeName} ${at}, so their price change over the period cannot be measured.`;
  }
  return `No position snapshot is on file for ${scopeName} ${at}, so each holding's share at the start cannot be measured.`;
}

export function PeriodAttributionSection({
  attribution,
  benchmarkSymbol,
  benchmarkLabel,
  scopeName,
  requestedStart,
}: {
  attribution: PeriodAttribution;
  /** The ticker, for sentences about its closes ("a SPY close"). */
  benchmarkSymbol: string;
  /** What the benchmark series is ("SPY price return", lib/compute/benchmark-label.ts). */
  benchmarkLabel: string;
  /** The selected scope in words, named by every empty-state reason. */
  scopeName: string;
  /** The selected period's start (undefined for All), as the sibling captions use. */
  requestedStart: string | undefined;
}) {
  const hasContribDetract =
    attribution.topContributors.length > 0 || attribution.topDetractors.length > 0;
  const hasSector = attribution.sectorContribution.length > 0;
  const hasBetaAlpha =
    attribution.betaVsAlpha.betaContribution !== 0 ||
    attribution.betaVsAlpha.alphaContribution !== 0;
  // Same honesty caption as the Max drawdown & Sharpe tiles and the equity
  // curve: the regression runs on daily_valuations, and at a multi-account
  // scope only the dates every account co-exists survive, so the window can
  // be shorter than the selected period (YTD/3Y/5Y then share one window).
  const betaWindowNotice = dataWindowNotice(
    requestedStart,
    attribution.betaWindow?.start ?? null,
    attribution.betaWindow?.end ?? null,
  );
  // Always name the window: the notice above speaks only when history is
  // shorter than the period, so a covered period would otherwise be silent.
  const betaWindowCaption =
    betaWindowNotice ??
    dataWindowCoveredCaption(attribution.betaWindow?.start ?? null, attribution.betaWindow?.end ?? null);

  return (
    <>
      {!hasContribDetract && (
        <EmptySection
          title="Period attribution"
          reason={positionsEmptyText(attribution, requestedStart, scopeName)}
          hint="Contributors, detractors and sectors are weighted from the long stocks, ETFs and funds in force at the period start: the latest position snapshot on or before it, at most a month old."
        />
      )}

      {hasContribDetract && (
        <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
          <h3 className="text-sm font-medium text-ink mb-3">Period attribution</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-2">
                Top contributors
              </p>
              {attribution.topContributors.length === 0 ? (
                <p className="text-sm text-ink-faint italic">None this period</p>
              ) : (
                <ul className="space-y-1.5">
                  {attribution.topContributors.map((c) => (
                    <li
                      key={c.symbol}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="font-mono text-ink">{c.symbol}</span>
                      <span className="font-mono tabular-nums text-up">
                        <Pct value={c.contribution * 100} digits={2} signed />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-2">
                Top detractors
              </p>
              {attribution.topDetractors.length === 0 ? (
                <p className="text-sm text-ink-faint italic">None this period</p>
              ) : (
                <ul className="space-y-1.5">
                  {attribution.topDetractors.map((c) => (
                    <li
                      key={c.symbol}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="font-mono text-ink">{c.symbol}</span>
                      <span className="font-mono tabular-nums text-down">
                        <Pct value={c.contribution * 100} digits={2} signed />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {attribution.positionsBasis.asOf && (
            <p className="text-xs text-ink-faint mt-3">
              Each holding is weighted by its share of the stocks, ETFs and funds held on{" "}
              {fmtDay(attribution.positionsBasis.asOf)}, times its price change over the period.
              Long positions only; shorts, options and bonds are not included.
              Trades during the period are not included.
            </p>
          )}
        </section>
      )}

      {hasSector && (
        <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
          <h3 className="text-sm font-medium text-ink mb-3">Sector contribution</h3>
          <ul className="space-y-2">
            {attribution.sectorContribution.map((s) => (
              <li key={s.sector} className="flex items-center gap-3 text-sm">
                <span className="text-ink-dim w-40 shrink-0">{s.sector}</span>
                <div className="flex-1 h-2 bg-raised rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${s.contribution >= 0 ? "bg-up/60" : "bg-down/60"}`}
                    style={{
                      width: `${Math.min(
                        100,
                        (Math.abs(s.contribution) /
                          Math.max(
                            ...attribution.sectorContribution.map((x) =>
                              Math.abs(x.contribution),
                            ),
                          )) *
                          100,
                      )}%`,
                    }}
                  />
                </div>
                <span
                  className={`font-mono tabular-nums text-xs w-16 text-right ${s.contribution >= 0 ? "text-up" : "text-down"}`}
                >
                  <Pct value={s.contribution * 100} digits={2} signed />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {hasBetaAlpha && (
        <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
          <h3 className="text-sm font-medium text-ink mb-4">
            Beta vs alpha decomposition{" "}
            <span className="text-ink-faint font-normal text-xs">vs {benchmarkLabel}</span>
          </h3>
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-1">
                Beta contribution
              </p>
              <p
                className={`font-mono tabular-nums text-xl ${attribution.betaVsAlpha.betaContribution >= 0 ? "text-up" : "text-down"}`}
              >
                <Pct
                  value={attribution.betaVsAlpha.betaContribution * 100}
                  digits={2}
                  signed
                />
              </p>
              <p className="text-[11px] text-ink-faint mt-0.5">Market exposure return</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-1">
                Alpha
              </p>
              <p
                className={`font-mono tabular-nums text-xl ${attribution.betaVsAlpha.alphaContribution >= 0 ? "text-up" : "text-down"}`}
              >
                <Pct
                  value={attribution.betaVsAlpha.alphaContribution * 100}
                  digits={2}
                  signed
                />
              </p>
              <p className="text-[11px] text-ink-faint mt-0.5">
                Return above the {benchmarkLabel}
              </p>
            </div>
          </div>
          {/* The stored benchmark is a price return while the portfolio's
              return includes dividends, so alpha is overstated (owner ruling
              2026-11-15: say so until a total-return series is stored). */}
          <p className="text-xs text-ink-faint mt-3">{ALPHA_PRICE_RETURN_NOTE}</p>
          {betaWindowCaption && (
            <p className="text-xs text-ink-faint mt-3">{betaWindowCaption}</p>
          )}
          {/* Says what the two parts add up to. They sum exactly to the
              daily-series return below (computePeriodAttribution), never to
              the TWR tile, which is a different measure over its own window:
              without this line the card read as a decomposition of the TWR
              that did not add up. Disclosure only; nothing is rescaled. */}
          {attribution.decomposedReturn && (
            <p className="text-xs text-ink-faint mt-1">
              The two parts add up to{" "}
              <Pct value={attribution.decomposedReturn.portfolioReturn * 100} digits={2} signed />:
              the return compounded over this window from{" "}
              {attribution.decomposedReturn.observations} daily observations (days with both a
              portfolio valuation and a {benchmarkSymbol} close), net of deposits and withdrawals.
              That is a different measure from the TWR tile above, which chains month-by-month
              returns over its own period window, so the two need not match.
            </p>
          )}
          {/* Same words as the risk tiles' "N seam days bridged": a day the
              daily values hand off between measurement sources is left out
              of the regression and of both returns (a day count, plain). */}
          {attribution.decomposedReturn && attribution.decomposedReturn.seamDaysBridged > 0 && (
            <p className="text-xs text-ink-faint mt-1">
              {attribution.decomposedReturn.seamDaysBridged} seam day
              {attribution.decomposedReturn.seamDaysBridged === 1 ? "" : "s"} bridged: on a day where
              the daily values switch measurement source, the step is not a return, so that day is
              left out of the regression and of both returns.
            </p>
          )}
        </section>
      )}
    </>
  );
}
