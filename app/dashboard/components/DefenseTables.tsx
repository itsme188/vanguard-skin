"use client";

import type { RankedExposure, HedgeScore, StandaloneBet, HedgeBadge } from "@/lib/compute/hedging";
import { Money, Pct } from "@/lib/privacy/components";
import { Chip, type ChipTone } from "./Chip";
import { SortableHeader } from "./SortableHeader";
import { useSortParam, compareValues } from "@/lib/hooks/useSortParam";
import { SymbolLink } from "./SymbolLink";

/**
 * Sortable tables for the Defense/Hedging tab: most-exposed underlyings,
 * the hedge book itself (ranked by efficiency), and standalone directional
 * bets. All three tables read plain serializable props from DefenseView
 * (server component) — sort state lives in the URL via useSortParam, same
 * idiom as every other sortable table in the app.
 */

type ExposureField = "underlying" | "netExposure" | "pctOfBook" | "tier1CoveragePct" | "sectorProxyCoveragePct";
type HedgeField = "symbol" | "protects" | "protectedNotional" | "monthlyBleedPct" | "runwayDays" | "efficiency";

const BADGE_TONE: Record<HedgeBadge, ChipTone> = {
  expiring: "warn",
  decayed: "down",
  expensive: "warn",
  deep_itm: "info",
};

const BADGE_LABEL: Record<HedgeBadge, string> = {
  expiring: "expiring",
  decayed: "decayed",
  expensive: "expensive",
  deep_itm: "deep ITM",
};

interface DefenseTablesProps {
  rankedExposures: RankedExposure[];
  hedgeScores: HedgeScore[];
  standaloneBets: StandaloneBet[];
  /** underlying → standalone-bet kind, so the most-exposed table can
      distinguish a genuinely-unhedged long from a naked short / single-name
      put bet — both share PairClassification "unhedged" upstream. */
  standaloneBetKinds: Record<string, "naked_short" | "single_name_put">;
}

export function DefenseTables({
  rankedExposures,
  hedgeScores,
  standaloneBets,
  standaloneBetKinds,
}: DefenseTablesProps) {
  return (
    <div className="space-y-6">
      <MostExposedTable rankedExposures={rankedExposures} standaloneBetKinds={standaloneBetKinds} />
      <HedgeBookTable hedgeScores={hedgeScores} />
      <StandaloneBetsList standaloneBets={standaloneBets} />
    </div>
  );
}

function MostExposedTable({
  rankedExposures,
  standaloneBetKinds,
}: {
  rankedExposures: RankedExposure[];
  standaloneBetKinds: Record<string, "naked_short" | "single_name_put">;
}) {
  const { sort, setSort } = useSortParam<ExposureField>("defense", null, "desc");

  const rows = [...rankedExposures].sort((a, b) => {
    if (!sort.field) return 0;
    const av = a[sort.field];
    const bv = b[sort.field];
    return compareValues(av, bv, sort.dir);
  });

  return (
    <section className="bg-panel border border-edge rounded-lg p-4">
      <h3 className="text-sm font-medium text-ink mb-3">Most exposed</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-faint">No individual exposures to rank in this scope.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-ink-faint border-b border-edge">
                <SortableHeader field="underlying" sort={sort} onSort={setSort}>Name</SortableHeader>
                <SortableHeader field="netExposure" sort={sort} onSort={setSort} align="right">Net exposure</SortableHeader>
                <SortableHeader field="pctOfBook" sort={sort} onSort={setSort} align="right">% of book</SortableHeader>
                <SortableHeader field="tier1CoveragePct" sort={sort} onSort={setSort} align="right">Tier-1 cover</SortableHeader>
                <SortableHeader field="sectorProxyCoveragePct" sort={sort} onSort={setSort} align="right">Sector proxy cover</SortableHeader>
                <th className="text-right py-2 px-2 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const kind = standaloneBetKinds[row.underlying];
                return (
                  <tr key={`${row.underlying}:${row.classification}`} className="border-b border-edge/50 hover:bg-muted/30">
                    <td className="py-2 pr-3 text-ink">
                      {row.securityId !== null ? (
                        <SymbolLink securityId={row.securityId} symbol={row.underlying} />
                      ) : (
                        row.underlying
                      )}
                    </td>
                    <td className="text-right py-2 px-2 font-mono tabular-nums">
                      <Money value={row.netExposure} signed />
                    </td>
                    <td className="text-right py-2 px-2 font-mono tabular-nums text-ink-dim">
                      <Pct value={row.pctOfBook !== null ? row.pctOfBook * 100 : null} digits={1} />
                    </td>
                    <td className="text-right py-2 px-2 font-mono tabular-nums text-ink-dim">
                      <Pct value={row.tier1CoveragePct !== null ? row.tier1CoveragePct * 100 : null} digits={0} />
                    </td>
                    <td className="text-right py-2 px-2 font-mono tabular-nums text-ink-dim">
                      <Pct value={row.sectorProxyCoveragePct !== null ? row.sectorProxyCoveragePct * 100 : null} digits={0} />
                    </td>
                    <td className="text-right py-2 px-2">
                      <div className="flex justify-end gap-1 flex-wrap">
                        {row.hasAmplifiers && <Chip tone="warn" size="xs">levered</Chip>}
                        {row.classification === "speculative" && <Chip tone="info" size="xs">spec</Chip>}
                        {kind === "naked_short" && <Chip tone="down" size="xs">short</Chip>}
                        {kind === "single_name_put" && <Chip tone="down" size="xs">bet</Chip>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HedgeBookTable({ hedgeScores }: { hedgeScores: HedgeScore[] }) {
  const { sort, setSort } = useSortParam<HedgeField>("hedgeBook", "efficiency", "asc");

  const rows = [...hedgeScores].sort((a, b) => {
    if (!sort.field) return 0;
    const av = a[sort.field];
    const bv = b[sort.field];
    return compareValues(av, bv, sort.dir);
  });

  return (
    <section className="bg-panel border border-edge rounded-lg p-4">
      <h3 className="text-sm font-medium text-ink mb-3">Hedge book</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-faint">No scored hedges in this scope.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-ink-faint border-b border-edge">
                <SortableHeader field="symbol" sort={sort} onSort={setSort}>Instrument</SortableHeader>
                <SortableHeader field="protects" sort={sort} onSort={setSort}>Protects</SortableHeader>
                <SortableHeader field="protectedNotional" sort={sort} onSort={setSort} align="right">Protected $</SortableHeader>
                <SortableHeader field="monthlyBleedPct" sort={sort} onSort={setSort} align="right">Bleed/mo</SortableHeader>
                <SortableHeader field="runwayDays" sort={sort} onSort={setSort} align="right">Runway</SortableHeader>
                <SortableHeader field="efficiency" sort={sort} onSort={setSort} align="right">Efficiency</SortableHeader>
                <th className="text-right py-2 px-2 font-medium">Badges</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                // A single instrument can appear twice (its pair-side credit +
                // its tier1_spill proxy-side credit — see the spill
                // double-attribution guard in computeDefenseAnalysis), each
                // with a different `protects` label, so securityId alone
                // isn't a unique key.
                <tr key={`${row.securityId}:${row.protects}`} className="border-b border-edge/50 hover:bg-muted/30">
                  <td className="py-2 pr-3 text-ink">
                    <SymbolLink securityId={row.securityId} symbol={row.symbol} />
                  </td>
                  <td className="py-2 px-2 text-ink-dim">{row.protects}</td>
                  <td className="text-right py-2 px-2 font-mono tabular-nums">
                    <Money value={row.protectedNotional} />
                  </td>
                  <td className="text-right py-2 px-2 font-mono tabular-nums text-ink-dim">
                    <Pct value={row.monthlyBleedPct !== null ? row.monthlyBleedPct * 100 : null} digits={1} />
                  </td>
                  <td className="text-right py-2 px-2 font-mono tabular-nums text-ink-dim">
                    {row.runwayDays !== null ? `${row.runwayDays}d` : "—"}
                  </td>
                  <td className="text-right py-2 px-2 font-mono tabular-nums text-ink-dim">
                    {row.efficiency !== null ? row.efficiency.toFixed(1) : "—"}
                  </td>
                  <td className="text-right py-2 px-2">
                    <div className="flex justify-end gap-1 flex-wrap">
                      {row.badges.map((b) => (
                        <Chip key={b} tone={BADGE_TONE[b]} size="xs">{BADGE_LABEL[b]}</Chip>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const BET_KIND_LABEL: Record<StandaloneBet["kind"], string> = {
  single_name_put: "bearish bet",
  naked_short: "naked short",
};

function StandaloneBetsList({ standaloneBets }: { standaloneBets: StandaloneBet[] }) {
  if (standaloneBets.length === 0) return null;

  return (
    <section className="bg-panel border border-edge rounded-lg p-4">
      <h3 className="text-sm font-medium text-ink mb-3">Standalone bets</h3>
      <p className="text-xs text-ink-faint mb-3">
        Directional positions with no offsetting core holding — these are bets, not hedges.
      </p>
      <ul className="divide-y divide-edge">
        {standaloneBets.map((bet) => (
          <li key={bet.underlying} className="flex items-center justify-between py-2 text-sm">
            <span className="text-ink">
              {bet.underlying}{" "}
              <span className="text-xs text-ink-faint">({BET_KIND_LABEL[bet.kind]})</span>
            </span>
            <span className="font-mono tabular-nums text-down">
              <Money value={bet.exposure} signed />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
