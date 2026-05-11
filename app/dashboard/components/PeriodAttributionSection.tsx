import type { PeriodAttribution } from "@/lib/compute/period-attribution";
import { Pct } from "@/lib/privacy/components";

export function PeriodAttributionSection({
  attribution,
  benchmarkSymbol,
}: {
  attribution: PeriodAttribution;
  benchmarkSymbol: string;
}) {
  const hasContribDetract =
    attribution.topContributors.length > 0 || attribution.topDetractors.length > 0;
  const hasSector = attribution.sectorContribution.length > 0;
  const hasBetaAlpha =
    attribution.betaVsAlpha.betaContribution !== 0 ||
    attribution.betaVsAlpha.alphaContribution !== 0;

  return (
    <>
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
            <span className="text-ink-faint font-normal text-xs">vs {benchmarkSymbol}</span>
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
                Idiosyncratic return above benchmark
              </p>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
