import Link from "next/link";
import type { CalendarEvent } from "@/lib/types";
import { addDays, formatWeekRange, todayET, getCurrentMonday } from "@/lib/calendar/date-utils";
import { formatFinnhubFigureCompact } from "@/lib/format/finnhub-figure";
import { effectiveConsensus } from "@/lib/calendar/consensus";
import { actualsAreImplausible } from "@/lib/earnings/actuals-display";
import { epsDelta } from "@/lib/earnings/eps-delta";
import { EnrichmentRowSummary } from "../components/calendar/EnrichmentChips";
// This is a Server Component (no "use client"): parseReactionSnapshot /
// snapshotCoversEventDate must come from the dependency-free
// reaction-snapshot-core module — never call a value export of
// EnrichmentChips.tsx ('use client') directly from server code (RSC
// forbids it), and never import a value from reaction-snapshot.ts (pulls
// in @stoqey/ib) into anything that could end up in a client bundle.
import {
  parseReactionSnapshot,
  snapshotCoversEventDate,
} from "@/lib/calendar/reaction-snapshot-core";

interface WeekAheadViewProps {
  events: CalendarEvent[];
  weekOf: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDayLabel(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${MONTHS[parseInt(month, 10) - 1]} ${parseInt(day, 10)}`;
}

function impactClass(impact: string | null): string {
  if (impact === "high") return "bg-down/10 text-down";
  if (impact === "medium") return "bg-blue/15 text-blue";
  return "bg-raised text-ink-faint";
}

function fmtTime(t: string | null): string | null {
  if (!t) return null;
  // event_time is HH:MM (24h) — render as h:mm a
  const [h, m] = t.split(":").map((n) => parseInt(n, 10));
  if (isNaN(h) || isNaN(m)) return null;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
}

export function WeekAheadView({ events, weekOf }: WeekAheadViewProps) {
  const todayIso = todayET();
  const currentMonday = getCurrentMonday();
  const isCurrentWeek = weekOf === currentMonday;
  const microLabel = isCurrentWeek
    ? "Week ahead"
    : weekOf < currentMonday
      ? "Past week"
      : "Upcoming week";
  const days = WEEKDAYS.map((label, idx) => {
    const date = addDays(weekOf, idx);
    return {
      label,
      date,
      isToday: date === todayIso,
      events: events
        .filter((e) => e.event_date === date)
        .sort((a, b) => {
          const aTime = a.release_time ?? a.event_time ?? "99:99";
          const bTime = b.release_time ?? b.event_time ?? "99:99";
          return aTime.localeCompare(bTime);
        }),
    };
  });

  const totalEvents = days.reduce((sum, d) => sum + d.events.length, 0);

  // Prev/next chevrons — plain links (server component), each week is a URL
  // so past enriched weeks are shareable/bookmarkable. Touch targets get the
  // pointer-coarse hit extension with the narrow horizontal inset (adjacent
  // controls sit within ~12px).
  const weekHref = (monday: string) =>
    `/dashboard/today?view=week-ahead&weekOf=${monday}`;
  const chevronClass =
    "relative text-[11px] text-ink-faint hover:text-gold border border-edge rounded-full px-2.5 py-1 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5";

  return (
    <div className="space-y-8">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-1">{microLabel}</p>
          <h1 className="text-2xl text-gold tracking-tight font-medium">{formatWeekRange(weekOf)}</h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-faint font-mono">
            {totalEvents} {totalEvents === 1 ? "event" : "events"}
          </span>
          <Link href={weekHref(addDays(weekOf, -7))} className={chevronClass} title="Previous week">
            ‹
          </Link>
          {!isCurrentWeek && (
            <Link
              href={weekHref(currentMonday)}
              className="relative text-[11px] uppercase tracking-widest text-ink-faint hover:text-gold border border-edge rounded-full px-3 py-1 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
            >
              This week
            </Link>
          )}
          <Link href={weekHref(addDays(weekOf, 7))} className={chevronClass} title="Next week">
            ›
          </Link>
          <Link
            href="/dashboard/today"
            className="relative text-[11px] uppercase tracking-widest text-ink-faint hover:text-gold border border-edge rounded-full px-3 py-1 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
          >
            ← Today
          </Link>
        </div>
      </header>

      {totalEvents === 0 ? (
        <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev">
          <p className="text-[14px] text-ink-faint">
            {isCurrentWeek
              ? "No events scheduled this week. Calendar sync may not have run yet — check Charts › Calendar (or trigger via the Sunday briefing)."
              : `No events recorded for the week of ${weekOf}. Calendar sync covers roughly four weeks ahead and history since spring 2026.`}
          </p>
        </section>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {days.map((day) => (
            <DayCard key={day.date} day={day} todayIso={todayIso} />
          ))}
        </div>
      )}
    </div>
  );
}

interface DayCardProps {
  day: {
    label: string;
    date: string;
    isToday: boolean;
    events: CalendarEvent[];
  };
  todayIso: string;
}

function DayCard({ day, todayIso }: DayCardProps) {
  return (
    <section
      className={`rounded-xl p-4 sm:p-5 min-w-0 card-elev ${
        day.isToday ? "bg-blue/8" : "bg-panel"
      }`}
    >
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-1">
        <div className="min-w-0">
          <p
            className={`text-[11px] uppercase tracking-widest mb-1 ${
              day.isToday ? "text-blue" : "text-ink-faint"
            }`}
          >
            {day.label}
          </p>
          <p className="text-2xl text-ink leading-tight font-medium">{fmtDayLabel(day.date)}</p>
        </div>
        {day.isToday && (
          <span className="text-[11px] uppercase tracking-widest text-blue border border-blue rounded-full px-2.5 py-0.5">
            Today
          </span>
        )}
      </div>

      {day.events.length === 0 ? (
        <p className="text-[13px] text-ink-faint italic">No events</p>
      ) : (
        <ul className="space-y-2">
          {day.events.map((e) => (
            <EventRow key={e.id} event={e} todayIso={todayIso} />
          ))}
        </ul>
      )}
    </section>
  );
}

// Earnings events store consensus + actual as Finnhub-shaped strings
// ("EPS X.XX · Rev N"). Macro events (FRED/FOMC) store raw values
// ("3.2%", "250K"). Only earnings need the compact formatter — and only
// earnings get the plausibility gate: an implausible actual (bad Finnhub
// scrape, fat-fingered manual override) renders null, matching the
// EarningsHub row on the same screen instead of contradicting it. The
// consensus line always renders when available so beat/miss is judgeable.
export function eventFigureDisplays(
  event: Pick<CalendarEvent, "event_type" | "consensus_estimate" | "actual_value"> &
    Partial<Pick<CalendarEvent, "consensus_value" | "manual_actuals_at">>,
): { consensusDisplay: string | null; actualDisplay: string | null } {
  const isEarnings = event.event_type === "earnings";
  const consensus = effectiveConsensus(event);
  const consensusDisplay = consensus
    ? isEarnings
      ? formatFinnhubFigureCompact(consensus)
      : consensus
    : null;
  const implausible =
    isEarnings &&
    actualsAreImplausible(consensus, event.actual_value, event.manual_actuals_at);
  const actualDisplay =
    event.actual_value && !implausible
      ? isEarnings
        ? formatFinnhubFigureCompact(event.actual_value)
        : event.actual_value
      : null;
  return { consensusDisplay, actualDisplay };
}

const CHIP_TONE_UP = "text-up bg-up/10";
const CHIP_TONE_DOWN = "text-down bg-down/10";
const CHIP_TONE_NEUTRAL = "text-ink-dim bg-raised border border-edge";

// QA finding today-week-ahead--actual-chip-always-green-miss-reads-as-beat-regression-3:
// the "actual …" chip used to be hard-coded to the up/green tone, so an
// earnings MISS painted the same as a beat. Color it by print-vs-consensus
// instead, reusing EarningsHub's epsDelta so the two surfaces never disagree
// on sign. Macro events (CPI, jobs, FOMC, …) have no "higher is better"
// direction — a hot CPI print is not a beat — so they always render neutral.
export function actualChipClass(
  event: Pick<CalendarEvent, "event_type" | "consensus_estimate" | "actual_value"> &
    Partial<Pick<CalendarEvent, "consensus_value" | "manual_actuals_at">>,
): string {
  if (event.event_type !== "earnings") return CHIP_TONE_NEUTRAL;
  const consensus = effectiveConsensus(event);
  // Same plausibility gate as eventFigureDisplays: today the chip only
  // renders when actualDisplay is non-null (already gated), but the helper
  // must be safe standalone — an implausible actual (bad Finnhub scrape)
  // must never color a beat/miss (2026-08-30 landing-review nit).
  if (actualsAreImplausible(consensus, event.actual_value, event.manual_actuals_at)) {
    return CHIP_TONE_NEUTRAL;
  }
  const delta = epsDelta(consensus, event.actual_value);
  if (delta == null || delta.sign === 0) return CHIP_TONE_NEUTRAL;
  return delta.sign === 1 ? CHIP_TONE_UP : CHIP_TONE_DOWN;
}

// A date correction can carry a prior print's actual_value / reaction_snapshot
// onto a FUTURE row. This is a forward-looking planning surface: post-release
// data must never render for an event whose date hasn't arrived, and the
// reaction line mirrors TodayReleases' enriched_at gate. The snapshot must
// also have been measured on this event's own date (snapshotCoversEventDate)
// — a stale snapshot stranded by a date correction is not this print's
// reaction, released or not.
export function releasedFigureGates(
  event: Pick<CalendarEvent, "event_date" | "enriched_at" | "reaction_snapshot">,
  todayIso: string,
): { released: boolean; showReaction: boolean } {
  const released = !!event.event_date && event.event_date <= todayIso;
  const snap = parseReactionSnapshot(event.reaction_snapshot ?? null);
  return {
    released,
    showReaction:
      released && !!event.enriched_at && snapshotCoversEventDate(event.event_date, snap),
  };
}

function EventRow({ event, todayIso }: { event: CalendarEvent; todayIso: string }) {
  const time = fmtTime(event.release_time ?? event.event_time);
  const symbol = event.symbol ?? null;
  const { consensusDisplay, actualDisplay: rawActualDisplay } = eventFigureDisplays(event);
  const { released, showReaction } = releasedFigureGates(event, todayIso);
  const actualDisplay = released ? rawActualDisplay : null;
  const inner = (
    <div className="rounded-lg bg-raised border border-edge p-3 hover:border-edge-strong transition-colors">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        {time && (
          <span className="text-[11px] font-mono text-ink-faint tabular-nums shrink-0">{time}</span>
        )}
        {symbol ? (
          <span className="font-mono text-[14px] font-medium text-ink truncate">{symbol}</span>
        ) : (
          <span
            className={`text-[11px] uppercase tracking-widest rounded-full px-2 py-0.5 ${impactClass(
              event.expected_impact
            )}`}
          >
            Macro
          </span>
        )}
        {/* The row flex-wraps, so a long actual value drops to its own
            line — never clipped to "actual…". Day columns can be as
            narrow as ~130px (5-up grid with the chat rail open), so the
            chip is also capped to max-w-full and allowed to wrap its own
            text (no whitespace-nowrap/shrink-0) instead of overflowing
            the card border into the neighboring column; break-words is a
            last-resort guard for the rare single figure wider than the
            column. */}
        {/* Consensus / actual values are PUBLIC market data (macro
            prints, street EPS/Rev) — they reveal nothing about the
            user's holdings, so they render unmasked per the
            privacy-masks-portfolio-only rule (B16 sibling). */}
        {actualDisplay && (
          <span
            className={`text-[11px] font-mono rounded px-1.5 py-0.5 ml-auto max-w-full break-words ${actualChipClass(event)}`}
          >
            actual {actualDisplay}
          </span>
        )}
      </div>
      <p className="text-[13px] text-ink-dim leading-snug line-clamp-2">{event.title}</p>
      {/* Consensus stays visible even after the actual lands — an enriched
          past week is only useful if the print can be judged against the
          street (a bare "actual $6.18" hides a 16% miss). */}
      {consensusDisplay && (
        <p className="text-[12px] font-mono text-ink-faint mt-1.5 truncate">
          Cons: {consensusDisplay}
        </p>
      )}
      {/* Captured market reaction (public data, unmasked) — the week view is
          the Calendar Living Record's only week-level browse path, so enriched
          past weeks surface their reactions here. Earnings rows lead with the
          reporter's own move; macro rows show SPY/QQQ. */}
      {showReaction && event.reaction_snapshot && (
        <div className="mt-1.5">
          <EnrichmentRowSummary
            actual={null}
            snapshotRaw={event.reaction_snapshot}
            preferEventSymbol
          />
        </div>
      )}
    </div>
  );

  if (event.security_id) {
    return (
      <li>
        <Link
          href={`/dashboard/security/${event.security_id}`}
          className="block group"
        >
          {inner}
        </Link>
      </li>
    );
  }
  return <li>{inner}</li>;
}
