import { db } from "@/lib/db";
import { resolveScope } from "@/lib/queries/accounts";
import {
  computeDefenseAnalysis,
  NOT_CREDITED_UNKNOWN,
  NOT_CREDITED_BETA_NO_HISTORY,
  NOT_CREDITED_BETA_LOW_FIT,
  type DefenseCashLine,
  type StandaloneBetKind,
} from "@/lib/compute/hedging";
import { interpretProtectionRatio, toneClass } from "@/lib/analysis/interpret";
import { Money, Pct, Count, PrivateText } from "@/lib/privacy/components";
import { CoverageBar } from "./CoverageBar";
import { EmptySection } from "./EmptySection";
import { NarrativeBlock } from "./analysis/NarrativeBlock";
import { DefenseTables } from "./DefenseTables";

/**
 * Defense/Hedging tab — headline protection-ratio strip, sector-coverage
 * bars, sortable most-exposed / hedge-book tables, standalone-bet callouts,
 * a diagnostics collapsible, and the cached narrative. Server component:
 * calls computeDefenseAnalysis directly (PerformanceView pattern — no
 * client-side fetch for the initial render).
 */

/**
 * Leveraged / inverse funds held out of the hedge book (owner ruling
 * 2026-11-01, stopgap; lib/compute/leveraged-fund.ts): a fund with a stored
 * signed leverage factor now enters the book at its factored exposure, so
 * only one with NO factor is listed here — nothing can say which way it
 * moves. Named, not hidden. Symbols are public data. Renders nothing when
 * count is 0.
 */
function LeveragedFundsNotModelled({ info }: { info: { count: number; symbols: string[] } }) {
  if (info.count <= 0) return null;
  return (
    <p className="text-xs text-ink-dim">
      <Count value={info.count} /> leveraged or inverse {info.count === 1 ? "position" : "positions"} not
      modelled: <span className="font-mono">{info.symbols.join(", ")}</span> — no leverage factor is stored
      for {info.count === 1 ? "it" : "them"}, so there is no sign or multiple to apply and
      {info.count === 1 ? " it is" : " they are"} held out of the hedge book.
    </p>
  );
}

/** One sentence under the cash line (owner ruling 2026-11-16). */
export const DEFENSE_CASH_CAPTION =
  "Cash lowers what can be lost, but it is not a hedge against the long book, so it is not in the protection ratio.";

/**
 * What the line counts (review 2026-11-16): only cash-equivalent funds held
 * as positions. A cash balance at the broker is not in the holdings universe.
 * The same words as the concentration cards' CASH_FUNDS_SCOPE_CAPTION
 * (ClassificationCard.tsx, a client file this server component must not
 * import from); a test pins the two equal.
 */
export const DEFENSE_CASH_SCOPE_CAPTION =
  "Money-market and sweep funds held as positions. Cash balances at the broker are not included.";

/** Shown when the scope holds no cash-equivalent fund at all. */
export const DEFENSE_NO_CASH_FUNDS_NOTE =
  "No cash-equivalent funds in this scope (broker cash balances are not counted here).";

/**
 * "Cash-equivalent funds: X% of this scope", the concentration card's own
 * figure (splitConcentrationUniverse). When the scope holds none, one note
 * says so (broker cash is not counted); borrowing (a cash fund below zero)
 * is said instead of a share.
 */
function DefenseCashLineView({ cash }: { cash: DefenseCashLine }) {
  if (cash.holdingCount === 0 && cash.borrowed.holdingCount === 0) {
    return (
      <div className="mt-4 border-t border-edge pt-3">
        <p className="text-xs text-ink-faint">{DEFENSE_NO_CASH_FUNDS_NOTE}</p>
      </div>
    );
  }
  return (
    <div className="mt-4 border-t border-edge pt-3">
      {cash.holdingCount > 0 && (
        <p className="text-xs text-ink">
          <span className="font-medium">Cash-equivalent funds:</span>{" "}
          <Pct value={cash.weight * 100} digits={1} className="font-mono" /> of this scope
        </p>
      )}
      {cash.borrowed.holdingCount > 0 && (
        <p className="text-xs text-ink">
          <span className="font-medium">Borrowed cash:</span> a cash balance below zero of{" "}
          <Money value={cash.borrowed.marketValue} className="font-mono" /> (borrowing, not cash on hand)
        </p>
      )}
      <p className="text-xs text-ink-faint mt-1">{DEFENSE_CASH_SCOPE_CAPTION}</p>
      <p className="text-xs text-ink-faint mt-1">{DEFENSE_CASH_CAPTION}</p>
    </div>
  );
}

interface DefenseViewProps {
  scope?: string;
}

export async function DefenseView({ scope = "all" }: DefenseViewProps) {
  const analysis = computeDefenseAnalysis(db, resolveScope(db, scope));
  const { summary } = analysis;

  if (
    summary.hedgeCount === 0 &&
    summary.shortExposure === 0 &&
    analysis.standaloneBets.length === 0 &&
    summary.optionPositionCount === 0 &&
    summary.shortPositionCount === 0
  ) {
    const empty = (
      <EmptySection
        title="Defense"
        reason="No options or short positions in this scope — there is nothing to analyze."
        hint="Hedges (long puts, protective calls on shorts) and index-put protection will appear here once opened."
      />
    );
    if (analysis.leveragedFundsUnmodelled.count === 0) return empty;
    return (
      <div className="space-y-3">
        {empty}
        <LeveragedFundsNotModelled info={analysis.leveragedFundsUnmodelled} />
      </div>
    );
  }

  const protectionInterp = interpretProtectionRatio(summary.protectionRatio);
  // Why each hedge is not credited, counted apart (K4b; ruling 19 = B).
  const countReason = (reason: string) => analysis.notCreditedHedges.filter((h) => h.reason === reason).length;
  const notCreditedParts = [
    { n: countReason(NOT_CREDITED_UNKNOWN), label: "fund type not on file" },
    { n: countReason(NOT_CREDITED_BETA_NO_HISTORY), label: "too little of its price history collected yet to measure its beta" },
    { n: countReason(NOT_CREDITED_BETA_LOW_FIT), label: "price history fits the market too loosely to measure its beta" },
  ];
  notCreditedParts.unshift({
    n: summary.notCreditedCount - notCreditedParts.reduce((a, p) => a + p.n, 0),
    label: "not a stock fund",
  });
  const notCreditedShown = notCreditedParts.filter((p) => p.n > 0);

  // underlying → standalone-bet kind, so the most-exposed table can tell a
  // genuinely-unhedged long apart from a naked short / single-name bearish
  // bet — both collapse to PairClassification "unhedged" upstream.
  const standaloneBetKinds: Record<string, StandaloneBetKind> = {};
  for (const bet of analysis.standaloneBets) standaloneBetKinds[bet.underlying] = bet.kind;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Defense</h2>
        <p className="text-sm text-ink-faint mt-0.5">
          What&apos;s hedged, what&apos;s exposed, and what the protection is costing.
        </p>
      </div>

      {/* Headline strip */}
      <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6">
          <div>
            <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-1">Protection ratio</p>
            <p className="font-mono tabular-nums text-xl text-ink">
              <Pct value={summary.protectionRatio !== null ? summary.protectionRatio * 100 : null} digits={0} />
            </p>
            <p className={`text-xs mt-1 ${toneClass(protectionInterp.tone)}`}>
              <PrivateText>{protectionInterp.text}</PrivateText>
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-1">Net exposure</p>
            <p className="font-mono tabular-nums text-xl text-ink">
              <Money value={summary.netExposure} signed />
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-1">Gross exposure</p>
            <p className="font-mono tabular-nums text-xl text-ink">
              <Money value={summary.grossExposure} />
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-1">Hedges scored</p>
            <p className="font-mono tabular-nums text-xl text-ink"><Count value={summary.hedgeCount} /></p>
            {summary.shortSideHedgeCount > 0 && (
              <p className="text-xs mt-1 text-ink-faint">
                <Count value={summary.longSideHedgeCount} /> long-side (Hedge book),{" "}
                <Count value={summary.shortSideHedgeCount} /> short-side
              </p>
            )}
            {summary.notCreditedCount > 0 && (
              <p className="text-xs mt-1 text-ink-faint">
                <Count value={summary.notCreditedCount} /> not credited (
                {notCreditedShown.length === 1
                  ? notCreditedShown[0].label
                  : notCreditedShown.map((p, i) => (
                      <span key={p.label}>
                        {i > 0 && ", "}
                        <Count value={p.n} /> {p.label}
                      </span>
                    ))}
                )
              </p>
            )}
          </div>
        </div>
        <DefenseCashLineView cash={analysis.cashLine} />
      </section>

      {/* Sector coverage bars */}
      <section className="bg-panel border border-edge rounded-lg p-4">
        <h3 className="text-sm font-medium text-ink mb-3">Sector coverage</h3>
        {analysis.sectorCoverage.length === 0 ? (
          <p className="text-sm text-ink-faint">
            No proxy-hedge or Tier-1 sector coverage to show in this scope.
          </p>
        ) : (
          <div className="space-y-3">
            {analysis.sectorCoverage.map((sc) => (
              <div key={sc.sector}>
                <div className="flex items-baseline justify-between text-xs mb-1">
                  <span className="text-ink">{sc.sector}</span>
                  <span className="text-ink-faint">
                    <Money value={sc.longExposure} className="mr-2" />
                    <Pct value={sc.coveragePct !== null ? sc.coveragePct * 100 : null} digits={0} />
                  </span>
                </div>
                <CoverageBar pct={sc.coveragePct} />
                {sc.protectedBeyondExposure > 0 && (
                  <p className="text-[11px] text-ink-dim mt-1">
                    <Money value={sc.protectedBeyondExposure} /> of fund-hedge credit lands beyond this
                    sector&apos;s holdings; the bar stops at 100% and the protection ratio keeps it.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <DefenseTables
        rankedExposures={analysis.rankedExposures}
        hedgeScores={analysis.hedgeScores}
        standaloneBets={analysis.standaloneBets}
        standaloneBetKinds={standaloneBetKinds}
        shortSideHedgeNotional={summary.shortSideHedgeNotional}
        notCreditedHedges={analysis.notCreditedHedges}
      />

      <LeveragedFundsNotModelled info={analysis.leveragedFundsUnmodelled} />

      {/* Sibling-priced Greeks: a caveat on the figures above, so it is
          stated in the open, not inside the collapsed diagnostics. */}
      {analysis.siblingPricedPositions > 0 && (
        <p className="text-xs text-ink-dim">
          <Count value={analysis.siblingPricedPositions} /> option position(s) here are priced off a
          sibling share class&apos;s closing price, because the contract&apos;s own underlying has no
          close on file. Their exposure and daily cost rest on that substitute price.
        </p>
      )}

      {/* Diagnostics */}
      {analysis.diagnostics.length > 0 && (
        <details className="bg-panel border border-edge rounded-lg p-4">
          <summary className="text-xs text-ink-faint cursor-pointer">
            {analysis.diagnostics.length} diagnostic{analysis.diagnostics.length === 1 ? "" : "s"} from this scope&apos;s classification
          </summary>
          <div className="mt-2 space-y-1 text-xs text-ink-dim font-mono">
            {analysis.diagnostics.map((d, i) => (
              <div key={`${d.kind}:${d.symbol}:${i}`}>
                {d.symbol} · <span className="text-ink-faint">{d.detail}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <NarrativeBlock scope={scope} surfaceKey="defense" />
    </div>
  );
}
