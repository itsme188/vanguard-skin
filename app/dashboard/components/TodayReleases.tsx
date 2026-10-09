"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { CalendarEvent } from "@/lib/types";
import { SymbolLink } from "./SymbolLink";
import { formatFinnhubFigureCompact } from "@/lib/format/finnhub-figure";
import { effectiveConsensus } from "@/lib/calendar/consensus";
import { nowET, todayET } from "@/lib/calendar/date-utils";
import { earningsTimeLabel, formatClockTime12 } from "@/lib/calendar/release-times";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
// Type only — the module reads the database, so no value may cross into this
// client bundle.
import type { EarningsDisplayTime } from "@/lib/calendar/display-earnings-time";
import { EnrichmentRowSummary } from "./calendar/EnrichmentChips";
import { Chip } from "./Chip";
import { preReleaseClearsAtMs } from "../today/pre-release-clear";
import {
  isPreReleaseActual,
  preReleaseActualChipText,
  PRE_RELEASE_ACTUAL_TITLE,
} from "@/lib/calendar/pre-release-actual";
// Import from the dependency-free core, never lib/calendar/reaction-snapshot.ts
// (that file imports real values from @stoqey/ib — a client bundle that
// pulls a value from it fails webpack with "Can't resolve 'net'").
import {
  parseReactionSnapshot,
  snapshotCoversEventDate,
  type ReactionSnapshot,
} from "@/lib/calendar/reaction-snapshot-core";

/** A calendar row plus the label a screen prints as its time (optional: a
 * caller that attaches none gets the stored-time label). */
type DisplayedEvent = CalendarEvent & { display_time?: EarningsDisplayTime };

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

/**
 * Pre-release "Est: …" pill text. `consensus` can be a Finnhub-shaped string
 * whose only recognizable token parses to nothing usable (the "Rev 0"
 * placeholder, or an unparseable "Rev abc") — formatFinnhubFigureCompact
 * returns "" for those (gap #2 of the PR #68 landing review), and blindly
 * concatenating would render "Est: " with nothing after it. Falls through to
 * "Pending release" whenever there is nothing usable to show, exactly as
 * when there was no consensus string at all.
 */
export function preReleaseEstimateText(consensus: string | null): string {
  const compact = consensus ? formatFinnhubFigureCompact(consensus) : "";
  return compact ? `Est: ${compact}` : "Pending release";
}

/**
 * The "nothing to show yet" sub-label. `preReleaseEstimateText` is time-blind:
 * a row whose own scheduled time has already passed would still read "Pending
 * release". When the estimate text is that placeholder and the row's displayed
 * ET clock time is behind us, say "Released H:MM AM · awaiting data" instead.
 * Rows whose time is only an estimate ("usual") or unknown never claim a
 * release: nothing trustworthy says the print has happened.
 */
export function pendingOrReleasedText(
  event: Pick<CalendarEvent, "event_date" | "release_time">,
  consensus: string | null,
  displayKind: EarningsDisplayTime["kind"] | undefined,
  now: Date = new Date(),
): string {
  const text = preReleaseEstimateText(consensus);
  if (text !== "Pending release") return text;
  if (displayKind === "usual" || displayKind === "unknown") return text;
  const clock = formatClockTime12(event.release_time);
  if (!clock || !event.release_time || !/^\d{1,2}:\d{2}/.test(event.release_time)) return text;
  const today = todayET(now);
  const past =
    event.event_date < today ||
    (event.event_date === today && event.release_time.slice(0, 5).padStart(5, "0") <= nowET(now));
  return past ? `Released ${clock} \u00b7 awaiting data` : text;
}

/**
 * Manual earnings rows are titled "<SYM> earnings (Manual entry)", which names
 * the source instead of the slot. When the row's own slot is known, print it the
 * way the vendor rows do. Display only; the stored title is never rewritten.
 */
export function slotAwareTitle(
  event: Pick<CalendarEvent, "title" | "event_time" | "raw_json" | "event_type">,
): string | null {
  const title = event.title;
  if (!title || event.event_type !== "earnings" || !/\(Manual entry\)\s*$/.test(title)) return title;
  const slot = deriveEarningsSlot({ event_time: event.event_time, raw_json: event.raw_json });
  if (!slot) return title;
  return title.replace(
    /\(Manual entry\)\s*$/,
    slot === "bmo" ? "(Before Market Open)" : "(After Market Close)",
  );
}

/**
 * Rows the block does not list. `total` is the caller's count of releases
 * matching the same query the list was cut from; absent or not a whole
 * number, nothing is claimed.
 */
export function hiddenReleaseCount(total: number | null | undefined, shown: number): number {
  if (total == null || !Number.isInteger(total)) return 0;
  return Math.max(0, total - shown);
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
  totalCount,
}: {
  releases: DisplayedEvent[];
  mode?: "today" | "upcoming";
  /** How many releases the list was cut from; more than shown adds "+N more". */
  totalCount?: number | null;
}) {
  const upcoming = mode === "upcoming";
  const hidden = hiddenReleaseCount(totalCount, releases.length);
  const todayIso = todayET();
  // A pre-release chip is decided from the clock at render. One timer, set for
  // the soonest print window to open, bumps `tick` so the rows re-evaluate and
  // the chip clears without a reload; the effect re-arms for the next one.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const now = new Date();
    let next: number | null = null;
    for (const r of releases) {
      const at = preReleaseClearsAtMs(r, now);
      if (at !== null && (next === null || at < next)) next = at;
      // A "Pending release" row flips to "Released" at its own clock time.
      if (r.event_date === todayET(now) && r.release_time && /^\d{2}:\d{2}/.test(r.release_time)) {
        const [rh, rm] = r.release_time.split(":").map(Number);
        const [nh, nm] = nowET(now).split(":").map(Number);
        const mins = rh * 60 + rm - (nh * 60 + nm);
        if (mins > 0) {
          const flipAt = now.getTime() + mins * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds() + 500;
          if (next === null || flipAt < next) next = flipAt;
        }
      }
    }
    if (next === null) return;
    const id = setTimeout(() => setTick((t) => t + 1), Math.max(0, next - Date.now()));
    return () => clearTimeout(id);
  }, [releases, tick]);
  return (
    <section className="rounded-xl bg-panel p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-ink">
          {upcoming ? "Next releases" : "Today’s releases"}
        </h2>
        <Link
          href="/dashboard/calendar"
          className="text-[11px] text-ink-faint hover:text-ink font-mono relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3.5 pointer-coarse:after:-inset-x-2"
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
          // An actual saved before its own print window opened (owner ruling
          // 2026-10-06, display-only): show it muted with a "pre-release"
          // chip instead of as reported fact, and without a reaction line
          // (no market move can belong to a print that has not happened).
          // Reverts to the normal summary once the slot instant passes.
          const preRelease = enriched && isPreReleaseActual(event);
          const preReleaseFigure =
            preRelease && event.actual_value
              ? formatFinnhubFigureCompact(event.actual_value)
              : "";
          const showPill = !!event.symbol && event.security_id != null;
          // Earnings titles already begin with the ticker ("NKE earnings (AMC)").
          // When the symbol pill is shown, drop that leading prefix so we don't
          // render "NKE NKE earnings (AMC)".
          const slotTitle = slotAwareTitle(event);
          const displayTitle =
            showPill && event.symbol && slotTitle?.startsWith(`${event.symbol} `)
              ? slotTitle.slice(event.symbol.length + 1)
              : slotTitle;
          return (
            <li key={event.id} className="px-4 py-2 space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="text-[14px] text-ink font-medium min-w-0 line-clamp-2 break-words md:truncate md:line-clamp-none"
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
                  {/* display_time: the usual time or "time unknown" for a
                      slot-less vendor row, never its stored default (user
                      ruling 2026-10-06). Absent → the stored-time label. */}
                  {event.display_time?.label ?? earningsTimeLabel(event) ?? ""}
                </span>
              </div>
              <div className="text-[12px] font-mono">
                {preRelease ? (
                  <span className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
                    {preReleaseFigure && (
                      <>
                        <span className="text-ink-faint">actual</span>
                        <span className="text-ink-faint italic">{preReleaseFigure}</span>
                      </>
                    )}
                    <Chip tone="warn" size="xs" title={PRE_RELEASE_ACTUAL_TITLE}>
                      {preReleaseActualChipText(event.manual_actuals_at)}
                    </Chip>
                  </span>
                ) : enriched ? (
                  <EnrichmentRowSummary
                    actual={event.actual_value}
                    snapshot={snapshot}
                    enrichedAt={event.enriched_at}
                  />
                ) : (
                  <span className="text-ink-faint">
                    {pendingOrReleasedText(
                      event,
                      effectiveConsensus(event),
                      event.display_time?.kind,
                    )}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <div className="pt-2">
          <Link
            href="/dashboard/calendar"
            className="text-[12px] font-mono text-ink-dim hover:text-ink underline underline-offset-2 relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3 pointer-coarse:after:-inset-x-2"
          >
            +{hidden} more on the calendar &rarr;
          </Link>
        </div>
      )}
    </section>
  );
}
