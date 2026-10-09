export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { getSectorEtfGaps } from "@/lib/queries/level-performance";
import {
  getSectorCheckMissingSector,
  getSectorDisagreements,
} from "@/lib/queries/data-health";
import { DataHealthView, dataConfidenceLevelLabel } from "../components/DataHealthView";
import { ScrollFade } from "../components/ScrollFade";
import { SymbolLink } from "../components/SymbolLink";
import { Count, PrivateText } from "@/lib/privacy/components";
import { getDataConfidence, type DataConfidence } from "@/lib/queries/data-confidence";
import { groupIntegrityHits, type IntegrityHit } from "@/lib/queries/integrity-checks";

/** One check's hits under the check's plain name. */
function IntegrityGroups({ hits }: { hits: IntegrityHit[] }) {
  return (
    <div className="space-y-3">
      {groupIntegrityHits(hits).map((group) => (
        <div key={group.check}>
          <h4 className="text-[12px] font-medium text-ink">
            {group.label} (<Count value={group.hits.length} />)
          </h4>
          {/* A check can return dozens of rows: cap the height, never the list. */}
          <ul className="mt-1 max-h-64 overflow-y-auto space-y-1 text-[12px] text-ink-dim">
            {group.hits.map((hit) => (
              <li key={hit.key}>
                {/* The reason names a symbol and can carry a figure: mask it whole. */}
                <PrivateText>{hit.reason}</PrivateText>
                {hit.kind === "statement-lag" && (
                  <span className="ml-2 text-ink-dim">(expected — clears with the next statement)</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * The cap line: whether a critical integrity check is holding the score down,
 * and which one. Shared by the summary at the top of the page and the
 * Integrity section below, so the wording and the masking live once. The cap
 * rule itself is getDataConfidence's, not restated here.
 */
function CapStatus({ confidence }: { confidence: DataConfidence }) {
  return confidence.capReason ? (
    <p className="text-[13px] text-down" role="status">
      The score is capped by a critical check:{" "}
      <PrivateText>{confidence.capReason}</PrivateText>
    </p>
  ) : (
    <p className="text-[13px] text-ink-dim" role="status">
      No critical check is failing, so the score is not capped.
    </p>
  );
}

/**
 * Score, level, cap state and cap reason at the top of the page. The header
 * badge is hidden below md, so a phone user reads the score here (QA finding
 * mobile-header--data-confidence-badge-hidden-below-md-no-mobile-surface).
 * The score is a data-quality figure, printed plain exactly as the header
 * badge and the drawer row print it; the cap reason can name a position, so
 * it stays masked.
 */
function ConfidenceSummary({ confidence }: { confidence: DataConfidence | null }) {
  return (
    <section
      aria-label="Data freshness score"
      className="rounded-xl border border-edge bg-panel px-5 py-4 space-y-2"
    >
      {confidence === null ? (
        <p className="text-[13px] text-warn" role="alert">
          The Data Freshness score could not be read just now. This is not a clean result.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-medium text-ink">Data Freshness</h2>
            <span className="font-mono text-2xl text-ink tabular-nums">{confidence.overallScore}%</span>
            <span className="text-[13px] text-ink-dim">{dataConfidenceLevelLabel(confidence.overallLevel)}</span>
          </div>
          <CapStatus confidence={confidence} />
        </>
      )}
    </section>
  );
}

/**
 * The integrity checks behind the header's Data Freshness badge: the reason
 * the score is capped, every critical hit, and every informational note. The
 * popover's "Full audit" link promises this list, and until now nothing on
 * this page mentioned it (QA findings
 * data-health--full-audit-destination-never-mentions-the-integrity-cap-behind-the-badge
 * and header-dataconfidence--full-audit-link-lands-on-page-without-integrity-notes).
 *
 * Read from getDataConfidence — the same read the badge makes — so the cap
 * reason here is the badge's, not a second copy of the cap rule.
 */
function IntegritySection({ confidence }: { confidence: DataConfidence | null }) {
  return (
    <section id="integrity" className="rounded-xl border border-edge bg-panel overflow-hidden scroll-mt-20">
      <div className="px-5 py-4 border-b border-edge">
        <h2 className="text-sm font-medium text-ink">Integrity checks</h2>
        <p className="text-[12px] text-ink-dim mt-0.5 max-w-3xl">
          Cross-checks of the stored book against itself. A critical result
          caps the Data Freshness score in the header, however healthy the
          coverage figures on this page read. Notes are informational and
          never cap it.
        </p>
      </div>
      {confidence === null ? (
        <div className="px-5 py-6 text-[13px] text-warn" role="alert">
          The integrity checks could not be read just now, so nothing is
          shown here. This is not a clean result.
        </div>
      ) : (
        <div className="px-5 py-4 space-y-4">
          <CapStatus confidence={confidence} />
          {!confidence.integrity.lotDriftChecked && (
            // Unchecked is not clean: say the comparison did not run.
            <p className="text-[13px] text-warn">
              Positions have not been checked against current tax lots.
              Tax inputs changed or the lots have not been recomputed; a
              skipped check does not mean they agree.
            </p>
          )}
          {confidence.integrity.critical.length > 0 && (
            <div>
              <h3 className="text-[12px] uppercase tracking-wider text-down mb-2">
                Critical (<Count value={confidence.integrity.critical.length} />)
              </h3>
              <IntegrityGroups hits={confidence.integrity.critical} />
            </div>
          )}
          {confidence.integrity.warnings.length > 0 && (
            <div>
              <h3 className="text-[12px] uppercase tracking-wider text-ink-dim mb-2">
                Notes (<Count value={confidence.integrity.warnings.length} />)
              </h3>
              <IntegrityGroups hits={confidence.integrity.warnings} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function readConfidence(): DataConfidence | null {
  try {
    return getDataConfidence(db);
  } catch (err) {
    console.error("[data-health] integrity read failed:", err);
    return null;
  }
}

// Browser-tab title (qa:page-head--same-tab-title-every-route-...).
export const metadata = { title: "Data Health" };

export default function DataHealthPage() {
  const confidence = readConfidence();
  const sectorGaps = getSectorEtfGaps(db);
  const sectorDisagreements = getSectorDisagreements(db);
  const sectorMissingCount = getSectorCheckMissingSector(db).length;

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-6">
      <ConfidenceSummary confidence={confidence} />
      <DataHealthView integritySection={<IntegritySection confidence={confidence} />} />

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
          <ScrollFade>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-[11px] uppercase tracking-wider text-ink-faint">
                  <th className="text-left px-5 py-2 font-medium">Symbol</th>
                  <th className="text-left px-5 py-2 font-medium">Sector</th>
                  <th className="text-right px-5 py-2 font-medium">Count</th>
                  <th className="text-right px-5 py-2 font-medium">
                    First seen
                  </th>
                  <th className="text-right px-5 py-2 font-medium">
                    Last seen
                  </th>
                </tr>
              </thead>
              <tbody>
                {sectorGaps.map((g) => (
                  <tr
                    key={`${g.symbol}:${g.sector ?? "null"}`}
                    className="border-b border-edge/50 last:border-0"
                  >
                    <td className="px-5 py-2 text-ink font-mono">
                      {g.securityId != null ? (
                        <SymbolLink
                          securityId={g.securityId}
                          symbol={g.symbol}
                          className="text-blue font-mono"
                        />
                      ) : (
                        g.symbol
                      )}
                    </td>
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
          </ScrollFade>
        )}
      </section>

      <section className="rounded-xl border border-edge bg-panel overflow-hidden">
        <div className="px-5 py-4 border-b border-edge">
          <h2 className="text-sm font-medium text-ink">
            Sector disagreements
          </h2>
          <p className="text-[12px] text-ink-faint mt-0.5 max-w-3xl">
            Stocks you hold or watch whose GICS sector tag disagrees with
            their fund category and have not been verified. Resolve with{" "}
            <code>npx tsx scripts/verify-sector-tags.ts --apply SYMBOL…</code>{" "}
            — verification stamps the row and suppresses legitimate
            divergences (e.g. GOOG: GICS Communication Services vs a
            Technology fund category).
          </p>
        </div>

        {sectorDisagreements.length === 0 ? (
          <div className="px-5 py-8 text-center text-[13px] text-ink-faint">
            No unverified sector disagreements among the stocks you hold
            or watch.
          </div>
        ) : (
          <ScrollFade>
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
                    <td className="px-5 py-2 text-ink font-mono">
                      <SymbolLink
                        securityId={d.securityId}
                        symbol={d.symbol}
                        className="text-blue font-mono"
                      />
                    </td>
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
          </ScrollFade>
        )}

        {/* Rows with no sector tag cannot disagree, so they are not in the
            table above. Count them here so they do not vanish. */}
        {sectorMissingCount > 0 && (
          <p className="px-5 py-3 border-t border-edge text-[12px] text-ink-dim">
            <Count value={sectorMissingCount} />{" "}
            {sectorMissingCount === 1 ? "stock" : "stocks"} in this check{" "}
            {sectorMissingCount === 1 ? "has" : "have"} no sector tag, so
            there is nothing to compare against the fund category.
          </p>
        )}
      </section>
    </div>
  );
}
