"use client";

import Link from "next/link";
import type { CalendarEvent } from "@/lib/types";
import { SymbolLink } from "./SymbolLink";
import { formatFinnhubFigureCompact } from "@/lib/format/finnhub-figure";
import { effectiveConsensus } from "@/lib/calendar/consensus";
import { todayET } from "@/lib/calendar/date-utils";
import { EnrichmentRowSummary } from "./calendar/EnrichmentChips";
// Import from the dependency-free core, never lib/calendar/reaction-snapshot.ts
// (that file imports real values from @stoqey/ib — a client bundle that
// pulls a value from it fails webpack with "Can't resolve 'net'").
import {
  parseReactionSnapshot,
  snapshotCoversEventDate,
  type ReactionSnapshot,
} from "@/lib/calendar/reaction-snapshot-core";

/**
 * Today view — "Today's releases" block (left half of the Today header row).
 *
 * `mode="today"` lists events landing on today's date; `mode="upcoming"` is the
 * fallback shown when today has none — it lists the next few scheduled releases
 * (with their date) so the column is never empty. Mixes macro (CPI, FOMC) and
 * earnings together, sorted by date then release_time. Post-release rows carry
 * the actual + reaction summary; pre-release rows show consensus.
 */

/**
 * Whether an upcoming-mode row's own release date has arrived. A date
 * correction can carry a prior print's actual_value/enriched_at onto a
 * FUTURE row (same failure mode WeekAheadView's releasedFigureGates
 * guards); this is a forward-looking planning surface, so post-release
 * data must not show until the event's own date arrives. Same
 * released-date gate as WeekAheadView — do not fork this check. Today-mode
 * rows are exempt: page.tsx's todayReleases query only ever selects
 * event_date === today, so the gate is a no-op there, but upcoming-mode
 * rows are future dates by construction.
 */
export function upcomingRowReleased(
  event: Pick<CalendarEvent, "event_date">,
  mode: "today" | "upcoming",
  todayIso: string,
): boolean {
  if (mode !== "upcoming") return true;
  return !!event.event_date && event.event_date <= todayIso;
}

/**
 * Full enriched-row gate: released (above) AND there's actually something
 * post-release to show. `snapshot` is the caller's already-parsed,
 * already-date-matched ReactionSnapshot (or null) — computed once per row
 * and reused for rendering, not reparsed here.
 */
export function isReleaseEnriched(
  event: Pick<CalendarEvent, "event_date" | "enriched_at" | "actual_value">,
  snapshot: ReactionSnapshot | null,
  mode: "today" | "upcoming",
  todayIso: string,
): boolean {
  return (
    upcomingRowReleased(event, mode, todayIso) &&
    !!event.enriched_at &&
    (!!event.actual_value || snapshot != null)
  );
}

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
  const todayIso = todayET();
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
          // A snapshot measured on a different day than this event (date
          // corrections strand these) is not this print's reaction — drop it
          // rather than render another window's market move. Same check as
          // WeekAheadView's releasedFigureGates.
          const parsedSnapshot = parseReactionSnapshot(event.reaction_snapshot);
          const snapshot = snapshotCoversEventDate(event.event_date, parsedSnapshot)
            ? parsedSnapshot
            : null;
          // Without an actual OR a usable reaction, an enriched_at stamp has
          // nothing post-release to show — fall through to Est/Pending.
          // isReleaseEnriched also blocks a date-corrected future row (upcoming
          // mode) from showing a prior print's stranded actual/enrichment.
          const enriched = isReleaseEnriched(event, snapshot, mode, todayIso);
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
                <span
                  className="text-[14px] text-ink font-medium min-w-0 truncate"
                  title={event.title ?? undefined}
                >
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
