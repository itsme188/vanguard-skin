"use client";

import type {
  RankedExposure,
  RankedExposureLeg,
  HedgeScore,
  StandaloneBet,
  HedgeBadge,
  NotCreditedHedge,
  BetaHistoryOnFile,
} from "@/lib/compute/hedging";
import { Money, Pct } from "@/lib/privacy/components";
import { Chip, type ChipTone } from "./Chip";
import { ScrollFade } from "./ScrollFade";
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

/**
 * Plain wording for the Hedge book's "Protects" cell. A paired hedge carries
 * its underlying's name; a proxy hedge carries a route description from
 * lib/compute/hedging.ts (`sector: <name> <pct>% / …`, `geography: <region>`,
 * `book (β=…)`). Each route gets a phrase here, and a route this map does not
 * know reads as words, so the cell never prints a `key: value` pair.
 */
export function protectsLabel(protects: string): string {
  const book = /^book\s*\((.*)\)$/.exec(protects);
  if (book) return `Whole portfolio (${book[1]})`;
  const route = /^([a-z][a-z_]*):\s*(.*)$/.exec(protects);
  if (!route) return protects;
  const [, kind, detail] = route;
  if (kind === "geography") {
    return detail === "" || detail === "Unknown"
      ? "Equities with no region on file (regional exposure, no beta applied)"
      : `${detail} equities (regional exposure, no beta applied)`;
  }
  if (kind === "own_sector") {
    const own = /^(.*\S)\s+\((.*)\)$/.exec(detail);
    if (!own) return `${detail} sector, the fund's own`;
    const spill = /^(.*\S)\s+\+\s+book$/.exec(own[1]);
    return spill
      ? `${spill[1]} sector (the fund's own), then the whole portfolio (${own[2]})`
      : `${own[1]} sector, the fund's own (${own[2]})`;
  }
  if (kind === "sector") {
    return detail
      .split(" / ")
      .map((part) => {
        const share = /^(.*\S)\s+(-?\d+%)$/.exec(part.trim());
        return share ? `${share[1]} sector (${share[2]})` : `${part.trim()} sector`;
      })
      .join(", ");
  }
  const words = kind.replace(/_+/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}: ${detail}`;
}

/**
 * The "Protects" cell. A sector route's percentages are rendered through
 * <Pct>, so "Hide amounts" masks them; the sector names stay readable.
 */
export function ProtectsCell({ text }: { text: string }) {
  const parts = text.split(/(-?\d+(?:\.\d+)?%)/);
  return (
    <>
      {parts.map((part, i) => {
        const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(part);
        return pct ? <Pct key={i} value={Number(pct[1])} digits={0} /> : <span key={i}>{part}</span>;
      })}
    </>
  );
}

/**
 * The caveats and option legs under a "Most exposed" name. A row with no
 * shares behind it (a put and a call netted into one row) lists each leg with
 * its own exposure, so the net figure can be read back to its parts.
 */
function ExposureRowDetail({ notes, legs }: { notes?: string[]; legs?: RankedExposureLeg[] }) {
  const showLegs = legs !== undefined && legs.length > 1;
  if (!showLegs && (notes === undefined || notes.length === 0)) return null;
  return (
    <div className="mt-0.5 space-y-0.5 text-[11px] text-ink-dim">
      {showLegs && (
        <div>
          Net of {legs.length} option legs:{" "}
          {legs.map((leg, i) => (
            <span key={leg.securityId} className="whitespace-nowrap">
              {i > 0 ? " · " : ""}
              {leg.symbol} <Money value={leg.exposure} signed />
            </span>
          ))}
        </div>
      )}
      {notes?.map((note) => <div key={note}>{note}</div>)}
    </div>
  );
}

interface DefenseTablesProps {
  rankedExposures: RankedExposure[];
  hedgeScores: HedgeScore[];
  standaloneBets: StandaloneBet[];
  /** underlying → standalone-bet kind, so the most-exposed table can
      distinguish a genuinely-unhedged long from a naked short / single-name
      put bet — both share PairClassification "unhedged" upstream. */
  standaloneBetKinds: Record<string, StandaloneBet["kind"]>;
  /** Credited offset of calls held against shorts (not in the protection ratio). */
  shortSideHedgeNotional: number;
  /** Fund hedges given no equity protection credit, with the reason. */
  notCreditedHedges: NotCreditedHedge[];
}

export function DefenseTables({
  rankedExposures,
  hedgeScores,
  standaloneBets,
  standaloneBetKinds,
  shortSideHedgeNotional,
  notCreditedHedges,
}: DefenseTablesProps) {
  return (
    <div className="space-y-6">
      <MostExposedTable rankedExposures={rankedExposures} standaloneBetKinds={standaloneBetKinds} />
      <HedgeBookTable hedgeScores={hedgeScores.filter((h) => h.side !== "short")} />
      <ShortSideHedges
        hedgeScores={hedgeScores.filter((h) => h.side === "short")}
        total={shortSideHedgeNotional}
      />
      <NotCreditedList hedges={notCreditedHedges} />
      <StandaloneBetsList standaloneBets={standaloneBets} />
    </div>
  );
}

/**
 * Calls held against short positions (owner ruling 2026-11-15, K4a). They
 * protect against a rally, so they are reported here and never counted in
 * the protection ratio, which measures protection of the long book.
 */
function ShortSideHedges({ hedgeScores, total }: { hedgeScores: HedgeScore[]; total: number }) {
  if (hedgeScores.length === 0) return null;
  return (
    <section className="bg-panel border border-edge rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-sm font-medium text-ink">Short-side hedges</h3>
        <span className="font-mono tabular-nums text-sm text-ink">
          <Money value={total} />
        </span>
      </div>
      <p className="text-xs text-ink-faint mb-3">
        Calls held against short positions. These protect against a rally and are not counted in the
        protection ratio.
      </p>
      <ul className="divide-y divide-edge">
        {hedgeScores.map((row) => (
          <li key={`${row.securityId}:${row.protects}`} className="flex items-center justify-between py-2 text-xs">
            <span className="text-ink">
              <SymbolLink securityId={row.securityId} symbol={row.symbol} />{" "}
              <span className="text-ink-faint">against the short in {row.underlying}</span>
            </span>
            <span className="font-mono tabular-nums">
              <Money value={row.protectedNotional} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Hedges on funds that give no equity protection credit (owner ruling
 * 2026-11-15, K4b): a commodity or bond fund, or a fund whose type is not on
 * file; and, by ruling 19 = B (2026-11-16), a fund whose beta cannot be
 * measured. Named with the reason and the notional, never silently dropped.
 */
/** The Not-credited intro (review 2026-11-16: the gap is in what this app
 *  has collected, not in the fund's own history). */
export const NOT_CREDITED_INTRO =
  "Positions on a fund that is not a stock fund, whose fund type is not on file, or whose beta this app cannot measure yet because it has not collected enough of the fund's price history (or the history it has fits the market too loosely). They are left out of the protection ratio and the sector bars.";

/**
 * What was on file for an unmeasured beta, from resolveProxyBeta: daily
 * closes in the app's own price tables, the day-to-day moves usable against
 * the market, and the moves the house gate needs. Market data, not a
 * portfolio figure. Exported for unit testing.
 */
export function betaHistoryLine(h: BetaHistoryOnFile): string {
  const closes = `${h.closesOnFile} daily ${h.closesOnFile === 1 ? "close" : "closes"} on file`;
  const moves = `${h.usablePairs} usable day-to-day ${h.usablePairs === 1 ? "move" : "moves"} against the market`;
  return `${closes}; ${moves}, ${h.pairsNeeded} needed`;
}

function NotCreditedList({ hedges }: { hedges: NotCreditedHedge[] }) {
  if (hedges.length === 0) return null;
  return (
    <section className="bg-panel border border-edge rounded-lg p-4">
      <h3 className="text-sm font-medium text-ink mb-1">Not credited</h3>
      <p className="text-xs text-ink-faint mb-3">{NOT_CREDITED_INTRO}</p>
      <ul className="divide-y divide-edge">
        {hedges.map((h) => (
          <li key={h.underlying} className="flex items-center justify-between py-2 text-xs">
            <span className="text-ink">
              {h.underlying} <span className="text-ink-faint font-mono">{h.symbols.join(", ")}</span>
              <span className="block text-[11px] text-ink-dim">{h.reason}</span>
              {h.betaHistory && (
                <span className="block text-[11px] text-ink-dim">{betaHistoryLine(h.betaHistory)}</span>
              )}
            </span>
            <span className="font-mono tabular-nums text-ink-dim">
              <Money value={h.protectiveNotional} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MostExposedTable({
  rankedExposures,
  standaloneBetKinds,
}: {
  rankedExposures: RankedExposure[];
  standaloneBetKinds: Record<string, StandaloneBet["kind"]>;
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
        <ScrollFade>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-ink-faint border-b border-edge">
                <SortableHeader field="underlying" sort={sort} onSort={setSort}>Name</SortableHeader>
                <SortableHeader field="netExposure" sort={sort} onSort={setSort} align="right">Net exposure</SortableHeader>
                <SortableHeader field="pctOfBook" sort={sort} onSort={setSort} align="right">% of book</SortableHeader>
                <SortableHeader field="tier1CoveragePct" sort={sort} onSort={setSort} align="right">Tier-1 cover</SortableHeader>
                <SortableHeader field="sectorProxyCoveragePct" sort={sort} onSort={setSort} align="right">Sector cover</SortableHeader>
                <th className="text-right py-2 px-2 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                // A standalone bet always ranks as "unhedged"; only such a
                // row may take the bet chip for its underlying.
                const kind = row.classification === "unhedged" ? standaloneBetKinds[row.underlying] : undefined;
                return (
                  // One row per underlying per classification: an options-only
                  // name is netted into a single row upstream, so this key is unique.
                  <tr key={`${row.underlying}:${row.classification}`} className="border-b border-edge/50 hover:bg-muted/30">
                    <td className="py-2 pr-3 text-ink">
                      {row.securityId !== null ? (
                        <SymbolLink securityId={row.securityId} symbol={row.underlying} />
                      ) : (
                        row.underlying
                      )}
                      <ExposureRowDetail notes={row.notes} legs={row.legs} />
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
                        {kind !== undefined && SHORT_KINDS.has(kind) && <Chip tone="down" size="xs">short</Chip>}
                        {kind !== undefined && !SHORT_KINDS.has(kind) && <Chip tone="down" size="xs">bet</Chip>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollFade>
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
        <ScrollFade>
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
                  <td className="py-2 px-2 text-ink-dim"><ProtectsCell text={protectsLabel(row.protects)} /></td>
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
        </ScrollFade>
      )}
    </section>
  );
}

const BET_KIND_LABEL: Record<StandaloneBet["kind"], string> = {
  single_name_put: "bearish bet",
  single_name_short_call: "short call",
  single_name_bearish_options: "bearish options",
  etf_bearish_options: "bearish ETF options",
  naked_short: "naked short",
  short_with_bearish_options: "short with bearish options",
};

/** The bet kinds that hold short shares: they take the "short" chip. */
const SHORT_KINDS: ReadonlySet<StandaloneBet["kind"]> = new Set(["naked_short", "short_with_bearish_options"]);

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
              {bet.notes?.map((note) => (
                <span key={note} className="block text-[11px] text-ink-dim">{note}</span>
              ))}
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
