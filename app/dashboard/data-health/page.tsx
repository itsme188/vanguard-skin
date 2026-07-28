export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { getSectorEtfGaps } from "@/lib/queries/level-performance";
import { getSectorDisagreements } from "@/lib/queries/data-health";
import { DataHealthView } from "../components/DataHealthView";

export default function DataHealthPage() {
  const sectorGaps = getSectorEtfGaps(db);
  const sectorDisagreements = getSectorDisagreements(db);

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-6">
      <DataHealthView />

      <section className="rounded-xl border border-edge bg-panel overflow-hidden">
        <div className="px-5 py-4 border-b border-edge">
          <h2 className="text-sm font-medium text-ink">
            Unmapped sector ETFs
          </h2>
          <p className="text-[12px] text-ink-faint mt-0.5 max-w-3xl">
            Earnings events whose company sector could not be mapped to a
            sector ETF when the enrichment runner captured the reaction.
            These symbols&rsquo; reactions only recorded SPY/QQQ/TLT. Extend{" "}
            <code>SECTOR_TO_ETF</code> / <code>EVENT_SECTOR_MAP</code> in{" "}
            <code>lib/calendar/reaction-snapshot.ts</code> once a pattern
            is visible.
          </p>
        </div>

        {sectorGaps.length === 0 ? (
          <div className="px-5 py-8 text-center text-[13px] text-ink-faint">
            No unmapped sectors yet. The enrichment runner populates this
            list as it encounters earnings symbols it can&rsquo;t map.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-[11px] uppercase tracking-wider text-ink-faint">
                <th className="text-left px-5 py-2 font-medium">Symbol</th>
                <th className="text-left px-5 py-2 font-medium">Sector</th>
                <th className="text-right px-5 py-2 font-medium">Count</th>
                <th className="text-right px-5 py-2 font-medium">
                  First seen
                </th>
                <th className="text-right px-5 py-2 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {sectorGaps.map((g) => (
                <tr
                  key={`${g.symbol}:${g.sector ?? "null"}`}
                  className="border-b border-edge/50 last:border-0"
                >
                  <td className="px-5 py-2 text-ink font-mono">{g.symbol}</td>
                  <td className="px-5 py-2 text-ink-dim">
                    {g.sector ?? "—"}
                  </td>
                  <td className="px-5 py-2 text-right text-ink font-mono">
                    {g.count}
                  </td>
                  <td className="px-5 py-2 text-right text-[11px] text-ink-faint font-mono">
                    {g.first_seen_at.slice(0, 10)}
                  </td>
                  <td className="px-5 py-2 text-right text-[11px] text-ink-faint font-mono">
                    {g.last_seen_at.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-xl border border-edge bg-panel overflow-hidden">
        <div className="px-5 py-4 border-b border-edge">
          <h2 className="text-sm font-medium text-ink">
            Sector disagreements
          </h2>
          <p className="text-[12px] text-ink-faint mt-0.5 max-w-3xl">
            Stocks whose GICS sector tag disagrees with their fund category
            and have not been verified. Resolve with{" "}
            <code>npx tsx scripts/verify-sector-tags.ts --apply SYMBOL…</code>{" "}
            — verification stamps the row and suppresses legitimate
            divergences (e.g. GOOG: GICS Communication Services vs a
            Technology fund category).
          </p>
        </div>

        {sectorDisagreements.length === 0 ? (
          <div className="px-5 py-8 text-center text-[13px] text-ink-faint">
            No unverified sector disagreements.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-[11px] uppercase tracking-wider text-ink-faint">
                <th className="text-left px-5 py-2 font-medium">Symbol</th>
                <th className="text-left px-5 py-2 font-medium">Sector</th>
                <th className="text-left px-5 py-2 font-medium">
                  Implied (fund category)
                </th>
                <th className="text-left px-5 py-2 font-medium">Industry</th>
              </tr>
            </thead>
            <tbody>
              {sectorDisagreements.map((d) => (
                <tr
                  key={d.symbol}
                  className="border-b border-edge/50 last:border-0"
                >
                  <td className="px-5 py-2 text-ink font-mono">{d.symbol}</td>
                  <td className="px-5 py-2 text-ink-dim">
                    {d.sector ?? "—"}
                  </td>
                  <td className="px-5 py-2 text-ink-dim">
                    {d.impliedSector}
                  </td>
                  <td className="px-5 py-2 text-ink-dim">
                    {d.industry ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
