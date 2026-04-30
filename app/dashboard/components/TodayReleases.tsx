"use client";

import Link from "next/link";
import type { CalendarEvent } from "@/lib/types";
import { SymbolLink } from "./SymbolLink";
import { formatFinnhubFigureCompact } from "@/lib/format/finnhub-figure";
import {
  EnrichmentRowSummary,
  parseReactionSnapshot,
} from "./calendar/EnrichmentChips";

/**
 * Mobile Today view — "Today's releases" block.
 *
 * Rendered when at least one calendar event lands on today's date with a
 * known release_time. Mixes macro (CPI, FOMC) and earnings together,
 * sorted by release_time ascending. Post-release rows carry the actual +
 * reaction summary; pre-release rows show consensus.
 */

function fmtTime(release_time: string): string {
  const [hh, mm] = release_time.split(":");
  const h = parseInt(hh, 10);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${mm} ${suffix}`;
}

export function TodayReleases({ releases }: { releases: CalendarEvent[] }) {
  return (
    <section className="rounded-xl border border-edge bg-panel-warm p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-ink">Today&rsquo;s releases</h2>
        <Link
          href="/dashboard/calendar"
          className="text-[11px] text-ink-faint hover:text-ink font-mono"
        >
          calendar &rarr;
        </Link>
      </div>
      <ul className="divide-y divide-edge -mx-5">
        {releases.map((event) => {
          const snapshot = parseReactionSnapshot(event.reaction_snapshot);
          const enriched = !!event.enriched_at;
          return (
            <li key={event.id} className="px-5 py-2.5 space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[14px] text-ink font-medium min-w-0 truncate">
                  {event.symbol && event.security_id != null && (
                    <SymbolLink
                      securityId={event.security_id}
                      symbol={event.symbol}
                      className="font-mono mr-1.5"
                    />
                  )}
                  {event.title}
                </span>
                <span className="text-[11px] font-mono text-ink-faint shrink-0">
                  {event.release_time ? fmtTime(event.release_time) : ""}
                </span>
              </div>
              <div className="text-[12px] font-mono">
                {enriched ? (
                  <EnrichmentRowSummary
                    actual={event.actual_value}
                    snapshot={snapshot}
                  />
                ) : (
                  <span className="text-ink-faint">
                    {event.consensus_estimate
                      ? `Est: ${formatFinnhubFigureCompact(event.consensus_estimate)}`
                      : "Pending release"}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
