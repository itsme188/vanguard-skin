"use client";

import Link from "next/link";
import type { CalendarEvent } from "@/lib/types";
import { SymbolLink } from "./SymbolLink";
import { formatFinnhubFigureCompact } from "@/lib/format/finnhub-figure";
import { effectiveConsensus } from "@/lib/calendar/consensus";
import {
  EnrichmentRowSummary,
  parseReactionSnapshot,
} from "./calendar/EnrichmentChips";

/**
 * Today view — "Today's releases" block (left half of the Today header row).
 *
 * `mode="today"` lists events landing on today's date; `mode="upcoming"` is the
 * fallback shown when today has none — it lists the next few scheduled releases
 * (with their date) so the column is never empty. Mixes macro (CPI, FOMC) and
 * earnings together, sorted by date then release_time. Post-release rows carry
 * the actual + reaction summary; pre-release rows show consensus.
 */

function fmtTime(release_time: string): string {
  const [hh, mm] = release_time.split(":");
  const h = parseInt(hh, 10);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${mm} ${suffix}`;
}

/** event_date is an ET market date (YYYY-MM-DD) → "Wed Jun 10". */
function fmtDate(event_date: string): string {
  const [y, m, d] = event_date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function TodayReleases({
  releases,
  mode = "today",
}: {
  releases: CalendarEvent[];
  mode?: "today" | "upcoming";
}) {
  const upcoming = mode === "upcoming";
  return (
    <section className="rounded-xl bg-panel p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-ink">
          {upcoming ? "Next releases" : "Today’s releases"}
        </h2>
        <Link
          href="/dashboard/calendar"
          className="text-[11px] text-ink-faint hover:text-ink font-mono"
        >
          calendar &rarr;
        </Link>
      </div>
      <ul className="divide-y divide-edge -mx-4">
        {releases.map((event) => {
          const snapshot = parseReactionSnapshot(event.reaction_snapshot);
          const enriched = !!event.enriched_at;
          const showPill = !!event.symbol && event.security_id != null;
          // Earnings titles already begin with the ticker ("NKE earnings (AMC)").
          // When the symbol pill is shown, drop that leading prefix so we don't
          // render "NKE NKE earnings (AMC)".
          const displayTitle =
            showPill && event.symbol && event.title?.startsWith(`${event.symbol} `)
              ? event.title.slice(event.symbol.length + 1)
              : event.title;
          return (
            <li key={event.id} className="px-4 py-2 space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[14px] text-ink font-medium min-w-0 truncate">
                  {showPill && (
                    <SymbolLink
                      securityId={event.security_id!}
                      symbol={event.symbol!}
                      className="font-mono mr-1.5"
                    />
                  )}
                  {displayTitle}
                </span>
                <span className="text-[11px] font-mono text-ink-faint shrink-0">
                  {upcoming && event.event_date && (
                    <span className="text-ink-dim">{fmtDate(event.event_date)} · </span>
                  )}
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
                    {effectiveConsensus(event)
                      ? `Est: ${formatFinnhubFigureCompact(effectiveConsensus(event))}`
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
