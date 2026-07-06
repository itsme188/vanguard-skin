import { db } from "@/lib/db";
import { resolveScope } from "@/lib/queries/accounts";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
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

interface DefenseViewProps {
  scope?: string;
}

export async function DefenseView({ scope = "all" }: DefenseViewProps) {
  const analysis = computeDefenseAnalysis(db, resolveScope(db, scope));
  const { summary } = analysis;

  if (summary.hedgeCount === 0 && summary.shortExposure === 0 && analysis.standaloneBets.length === 0) {
    return (
      <EmptySection
        title="Defense"
        reason="No options or short positions in this scope — there is nothing to analyze."
        hint="Hedges (long puts, protective calls on shorts) and index-put protection will appear here once opened."
      />
    );
  }

  const protectionInterp = interpretProtectionRatio(summary.protectionRatio);

  // underlying → standalone-bet kind, so the most-exposed table can tell a
  // genuinely-unhedged long apart from a naked short / single-name bearish
  // bet — both collapse to PairClassification "unhedged" upstream.
  const standaloneBetKinds: Record<string, "naked_short" | "single_name_put"> = {};
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
          </div>
        </div>
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
      />

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
