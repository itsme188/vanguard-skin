import Link from "next/link";
import type { CalendarEvent } from "@/lib/types";
import { addDays, formatWeekRange, todayET, getCurrentMonday, mondayOf } from "@/lib/calendar/date-utils";
import { formatFinnhubFigure, parseFinnhubFigure, formatFinnhubFigureCompact } from "@/lib/format/finnhub-figure";
import { formatCompactUSD } from "@/lib/format";
import { effectiveConsensus } from "@/lib/calendar/consensus";
import {
  earningsTimeLabel,
  FRED_SOURCE_KEY_PREFIX,
  isFredScheduleRow,
} from "@/lib/calendar/release-times";
import type { EarningsDisplayTime } from "@/lib/calendar/display-earnings-time";
import { actualsAreImplausible } from "@/lib/earnings/actuals-display";
import { epsDelta } from "@/lib/earnings/eps-delta";
import {
  EnrichmentDisclosure,
  EnrichmentRowSummary,
  PreReleaseActualChips,
} from "../components/calendar/EnrichmentChips";
import {
  EarningsConflictActions,
  EarningsConflictMarker,
} from "../components/calendar/EarningsConflictMarker";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
import { EarningsDeleteButton } from "./EarningsDeleteButton";
import { preReleaseClearsAtMs } from "./pre-release-clear";
import {
  isPreReleaseActual,
  preReleaseActualChipText,
  PRE_RELEASE_ACTUAL_TITLE,
} from "@/lib/calendar/pre-release-actual";
// This is a Server Component (no "use client"): parseReactionSnapshot /
// snapshotCoversEventDate must come from the dependency-free
// reaction-snapshot-core module — never call a value export of
// EnrichmentChips.tsx ('use client') directly from server code (RSC
// forbids it), and never import a value from reaction-snapshot.ts (pulls
// in @stoqey/ib) into anything that could end up in a client bundle.
import {
  isUsableReactionLeg,
  parseReactionSnapshot,
  snapshotCoversEventDate,
} from "@/lib/calendar/reaction-snapshot-core";

/** A calendar row plus the label a screen prints as its time (optional: a
 * caller that attaches none gets the stored-time label). */
type DisplayedEvent = CalendarEvent & { display_time?: EarningsDisplayTime };

interface WeekAheadViewProps {
  events: DisplayedEvent[];
  weekOf: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
// The grid stays Mon-Fri (owner ruling 2026-08-18). A Saturday or Sunday row
// is still part of the week the header names: it is counted there and listed
// in one line under the grid, so this view and the Earnings Hub agree.
const WEEKEND_DAYS = [
  { label: "Sat", offset: 5 },
  { label: "Sun", offset: 6 },
] as const;
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

// QA finding today-week-ahead--weekend-current-week-labelled-past-week-this-week-jumps-forward-regression-1:
// getCurrentMonday() deliberately returns NEXT Monday on Sat/Sun (the
// business week is over — that's the intended default landing for this
// view). But comparing weekOf straight against getCurrentMonday() meant
// that on a weekend, the week that actually CONTAINS today got mislabeled
// "Past week" and "This week" pointed at next week. This helper checks
// mondayOf(todayIso) — the week containing today — before falling back to
// past/upcoming, so a weekend user still sees their current week as
// current.
export function weekAheadHeaderState(
  weekOf: string,
  todayIso: string,
  currentMonday: string,
): {
  microLabel: "Week ahead" | "This week" | "Past week" | "Upcoming week";
  thisWeekMonday: string;
  showThisWeekLink: boolean;
} {
  const thisWeekMonday = mondayOf(todayIso);
  const microLabel =
    weekOf === currentMonday
      ? "Week ahead"
      : weekOf === thisWeekMonday
        ? "This week"
        : addDays(weekOf, 6) < todayIso
          ? "Past week"
          : "Upcoming week";
  return {
    microLabel,
    thisWeekMonday,
    showThisWeekLink: weekOf !== thisWeekMonday,
  };
}

// Empty-state copy for the week-ahead grid. Must agree with the header's own
// present/past framing — this used to be driven by an independently
// computed `isCurrentWeek = weekOf === currentMonday` (the DEFAULT landing
// week), so on a weekend, navigating to the week containing today (which
// the header labels "This week", since currentMonday has rolled forward to
// next Monday) fell through to the "no events recorded... history since
// spring 2026" copy: a past-tense sentence under a present-tense header (QA
// follow-up, landing review 256833e5). Deriving from the SAME
// weekAheadHeaderState the header itself renders — rather than a second,
// independent comparison — makes the two impossible to disagree.
export function weekAheadEmptyStateCopy(
  weekOf: string,
  todayIso: string,
  currentMonday: string,
): string {
  const { microLabel } = weekAheadHeaderState(weekOf, todayIso, currentMonday);
  const isPresentWeek = microLabel === "This week" || microLabel === "Week ahead";
  return isPresentWeek
    ? "No events scheduled this week. Calendar sync may not have run yet — check Charts › Calendar (or trigger via the Sunday briefing)."
    : `No events recorded for the week of ${weekOf}. Calendar sync covers roughly four weeks ahead and history since spring 2026.`;
}

/** The grid's note for a week whose FRED macro schedule is not in yet. */
export const MACRO_NOT_LOADED_NOTE = "Macro schedule not loaded yet for this week";

/**
 * Whether the grid should say the week's macro schedule is not loaded (user
 * ruling 2026-10-05). The far weeks of the four-week horizon used to show
 * earnings — and now the hardcoded FOMC/ISM/UMich/Conference Board dates —
 * with a silently empty macro area, which reads as "nothing scheduled".
 *
 * "Loaded" = the week holds at least one FRED-sourced row (`fred:` source_key,
 * isFredScheduleRow). Hardcoded rows do not count: they are synced without
 * FRED and say nothing about whether CPI/jobs/GDP dates have been fetched.
 * Only a week that is not over yet can be "not loaded YET" — a past week with
 * no FRED rows is simply a thin record, and gets no note.
 */
export function macroScheduleNotLoaded(
  events: Pick<CalendarEvent, "source_key">[],
  weekOf: string,
  todayIso: string,
): boolean {
  if (addDays(weekOf, 6) < todayIso) return false;
  return !events.some(isFredScheduleRow);
}

export function WeekAheadView({ events, weekOf }: WeekAheadViewProps) {
  const todayIso = todayET();
  const currentMonday = getCurrentMonday();
  const { microLabel, thisWeekMonday, showThisWeekLink } = weekAheadHeaderState(
    weekOf,
    todayIso,
    currentMonday,
  );
  const eventsOn = (date: string) =>
    events
      .filter((e) => e.event_date === date)
      .sort((a, b) => {
        const aTime = a.release_time ?? a.event_time ?? "99:99";
        const bTime = b.release_time ?? b.event_time ?? "99:99";
        return aTime.localeCompare(bTime);
      });
  const days = WEEKDAYS.map((label, idx) => {
    const date = addDays(weekOf, idx);
    return { label, date, isToday: date === todayIso, events: eventsOn(date) };
  });
  const weekendDays = WEEKEND_DAYS.map(({ label, offset }) => {
    const date = addDays(weekOf, offset);
    return { label, date, events: eventsOn(date) };
  }).filter((d) => d.events.length > 0);

  const totalEvents =
    days.reduce((sum, d) => sum + d.events.length, 0) +
    weekendDays.reduce((sum, d) => sum + d.events.length, 0);
  const macroNotLoaded = macroScheduleNotLoaded(events, weekOf, todayIso);

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
          {showThisWeekLink && (
            <Link
              href={weekHref(thisWeekMonday)}
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
            {weekAheadEmptyStateCopy(weekOf, todayIso, currentMonday)}
          </p>
        </section>
      ) : (
        <div className="space-y-3">
          {/* Same muted style as a day card's "No events" line. Only on a
              week that HAS rows: the empty state above already explains an
              unsynced week in full. */}
          {macroNotLoaded && (
            <p className="text-[13px] text-ink-faint italic">{MACRO_NOT_LOADED_NOTE}</p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {days.map((day) => (
              <DayCard key={day.date} day={day} todayIso={todayIso} />
            ))}
          </div>
          {weekendDays.length > 0 && <WeekendNote days={weekendDays} todayIso={todayIso} />}
        </div>
      )}
    </div>
  );
}

/**
 * The title a week card prints. A hand-entered earnings row is stored as
 * "<SYM> earnings (Manual entry)", which names the source where every vendor
 * row names the market slot; when the row's own slot is known (event_time or
 * raw_json only, via deriveEarningsSlot) the slot is printed instead. Display
 * only — the stored title is never rewritten.
 *
 * Same rule as slotAwareTitle in components/TodayReleases.tsx. That file is a
 * client module and this view is a Server Component, which may not call a
 * client module's function, so the rule is repeated here and
 * tests/dashboard/week-ahead-cards-c07.test.ts pins the two to the same answers.
 */
export function weekAheadTitle(
  event: Pick<CalendarEvent, "title" | "event_time" | "raw_json" | "event_type">,
): string {
  const title = event.title;
  if (!title || event.event_type !== "earnings" || !/\(Manual entry\)\s*$/.test(title)) return title;
  const slot = deriveEarningsSlot({ event_time: event.event_time, raw_json: event.raw_json });
  if (!slot) return title;
  return title.replace(
    /\(Manual entry\)\s*$/,
    slot === "bmo" ? "(Before Market Open)" : "(After Market Close)",
  );
}

/** The label a card prints as its time — display only (see EventRow). */
function eventTimeLabel(event: DisplayedEvent): string | null {
  return event.display_time?.label ?? earningsTimeLabel(event);
}

/**
 * Whether the week view offers a remove control on a row. Only a hand-entered
 * earnings row: "+ Add ticker" can land one in another week, where the Hub
 * (current week only) never shows it, so this view was the one place it could
 * be seen and it could not be removed there. Vendor rows keep their remove
 * flow on the Hub.
 */
export function weekAheadRemovable(event: Pick<CalendarEvent, "source" | "event_type">): boolean {
  return event.source === "manual" && event.event_type === "earnings";
}

/**
 * Whether this view offers the Confirm / Use other date buttons on a row: a
 * date-conflicted earnings row with a ticker. The Hub shows only the current
 * week, so a conflict in any other week could be seen here and not resolved.
 */
export function conflictResolvableHere(
  event: Pick<
    CalendarEvent,
    "event_type" | "symbol" | "date_status" | "event_date" | "date_conflict_with"
  >,
  todayIso: string,
): boolean {
  if (event.event_type !== "earnings" || !event.symbol || event.date_status !== "conflict") {
    return false;
  }
  // A date already behind us cannot be confirmed (the server refuses it), so
  // a row with no date left to pick gets no buttons — same rule as
  // conflictResolveOptions, which decides the buttons themselves.
  const otherDate = (event.date_conflict_with ?? "").split(":")[1] ?? "";
  return (
    event.event_date >= todayIso || (/^\d{4}-\d{2}-\d{2}$/.test(otherDate) && otherDate >= todayIso)
  );
}

/** The date-conflict buttons for a resolvable row; nothing for any other row. */
function ConflictActions({ event, todayIso }: { event: DisplayedEvent; todayIso: string }) {
  if (!conflictResolvableHere(event, todayIso)) return null;
  return (
    <EarningsConflictActions
      dateStatus={event.date_status}
      dateConflictWith={event.date_conflict_with}
      symbol={event.symbol}
      eventDate={event.event_date}
      eventTime={event.event_time}
      rawJson={event.raw_json}
      releaseTime={event.release_time}
    />
  );
}

/** The remove control for a hand-entered row; nothing for any other row. */
function RemoveRow({ event }: { event: DisplayedEvent }) {
  if (!weekAheadRemovable(event)) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-faint">
      Entered by you
      <EarningsDeleteButton eventId={event.id} symbol={event.symbol ?? null} source={event.source} />
    </span>
  );
}

/**
 * Weekend events, one line under the Mon-Fri grid. Same rule as a card for
 * what is clickable: the symbol links only when the security resolves.
 */
function WeekendNote({
  days,
  todayIso,
}: {
  days: { label: string; date: string; events: DisplayedEvent[] }[];
  todayIso: string;
}) {
  return (
    <p className="text-[13px] text-ink-dim flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-ink-faint">Outside the Mon–Fri grid:</span>
      {days.flatMap((day) =>
        day.events.map((e) => {
          const time = eventTimeLabel(e);
          const name = e.symbol ?? e.title;
          return (
            <span key={e.id} className="inline-flex flex-wrap items-baseline gap-x-1.5 min-w-0">
              <span className="font-mono text-[11px] text-ink-faint">
                {day.label} {fmtDayLabel(day.date)}
                {time ? ` · ${time}` : ""}
              </span>
              {e.security_id ? (
                <Link
                  href={`/dashboard/security/${e.security_id}`}
                  className="font-mono font-medium text-ink hover:text-gold"
                  title={weekAheadTitle(e) ?? undefined}
                >
                  {name}
                </Link>
              ) : (
                <span
                  className={e.symbol ? "font-mono font-medium text-ink" : "text-ink"}
                  title={e.symbol ? (weekAheadTitle(e) ?? undefined) : undefined}
                >
                  {name}
                </span>
              )}
              <EarningsConflictMarker
                dateStatus={e.date_status}
                dateConflictWith={e.date_conflict_with}
                wrap
                resolveHere={conflictResolvableHere(e, todayIso)}
              />
              <ConflictActions event={e} todayIso={todayIso} />
              <RemoveRow event={e} />
            </span>
          );
        }),
      )}
    </p>
  );
}

interface DayCardProps {
  day: {
    label: string;
    date: string;
    isToday: boolean;
    events: DisplayedEvent[];
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

// QA finding today-earnings--zero-revenue-consensus-renders-dollar-zero: this
// card sits next to sibling cards on the same row that show revenue as
// "$259.2M" / "$13.37B" (formatLargeUSD, via the shared
// formatFinnhubFigureCompact), but formatLargeUSD only abbreviates from $1M
// up — a small-cap print like $190,000 rendered as "$190,000", visually
// inconsistent on this narrow card. formatCompactUSD renders >=$1M values
// IDENTICALLY to formatLargeUSD, EXCEPT in the $999.95M-$1B band, where
// formatCompactUSD promotes to B ("$1.00B") while formatLargeUSD keeps
// "$1000.0M" (see tests/lib/format.test.ts), and below $1M, where
// formatCompactUSD abbreviates to K instead of comma-grouping — use it here
// (this card only; other surfaces keep formatLargeUSD's comma band by
// design, see lib/format.ts formatCompactUSD doc comment). Reuses
// formatFinnhubFigure for the "is revenue present" and
// EPS-string logic (including its zero-revenue-is-absent rule) and only
// re-bands the revenue number itself.

// A formatted figure string can come back empty even when its raw input
// wasn't — an all-placeholder Finnhub consensus (the literal "Rev 0" used
// as "no revenue estimate published") parses to no usable EPS or revenue,
// so formatWeekCardFigure's eps/revStr pieces are both null and the joined
// string is "". Left unguarded, a caller that only checks "was there a raw
// consensus string" (rather than "did formatting produce anything") would
// hand back that empty string as `consensusDisplay`/`actualDisplay` instead
// of null — the same failure class TodayReleases.tsx guards against in
// preReleaseEstimateText (a "Cons: "/"actual " label rendering with nothing
// after it). Pure and standalone so it never depends on how
// lib/format/finnhub-figure.ts happens to represent "nothing usable" today.
export function figureOrAbsent(s: string): string | null {
  const trimmed = s.trim();
  return trimmed ? trimmed : null;
}

function formatWeekCardFigure(s: string | null | undefined): string {
  const f = formatFinnhubFigure(s);
  if (f.fallback) return f.fallback;
  const parsed = parseFinnhubFigure(s);
  const revStr =
    f.revenue != null && parsed.revenue != null ? formatCompactUSD(parsed.revenue) : null;
  return [f.eps, revStr].filter((v): v is string => !!v).join(" · ");
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
      ? figureOrAbsent(formatWeekCardFigure(consensus))
      : consensus
    : null;
  const implausible =
    isEarnings &&
    actualsAreImplausible(consensus, event.actual_value, event.manual_actuals_at);
  const actualDisplay =
    event.actual_value && !implausible
      ? isEarnings
        ? figureOrAbsent(formatWeekCardFigure(event.actual_value))
        : event.actual_value
      : null;
  return { consensusDisplay, actualDisplay };
}

const CHIP_TONE_UP = "text-up bg-up/10";
const CHIP_TONE_DOWN = "text-down bg-down/10";
const CHIP_TONE_NEUTRAL = "text-ink-dim bg-raised border border-edge";
/** A pre-release actual (isPreReleaseActual): faint italic, never beat/miss colored. */
const PRE_RELEASE_ACTUAL_CHIP_CLASS = "text-ink-faint italic bg-raised border border-edge";

// QA finding today-week-ahead--actual-chip-always-green-miss-reads-as-beat-regression-3:
// the "actual …" chip used to be hard-coded to the up/green tone, so an
// earnings MISS painted the same as a beat. Color it by print-vs-consensus
// instead, reusing EarningsHub's epsDelta so the two surfaces never disagree
// on sign. Macro events (CPI, jobs, FOMC, …) have no "higher is better"
// direction — a hot CPI print is not a beat — so they always render neutral.
export function actualChipClass(
  event: Pick<CalendarEvent, "event_type" | "consensus_estimate" | "actual_value"> &
    Partial<
      Pick<
        CalendarEvent,
        "consensus_value" | "manual_actuals_at" | "event_date" | "event_time" | "release_time" | "raw_json"
      >
    > &
    Pick<DisplayedEvent, "display_time">,
  now: Date = new Date(),
): string {
  // Owner ruling 2026-10-06 (display-only): an actual saved before the
  // print's own window opened is never colored as a beat/miss — faint italic
  // until the window opens (the card adds the "pre-release" chip beside it).
  if (
    event.event_type === "earnings" &&
    event.event_date &&
    isPreReleaseActual(
      {
        event_type: event.event_type,
        event_date: event.event_date,
        event_time: event.event_time ?? null,
        release_time: event.release_time ?? null,
        raw_json: event.raw_json ?? null,
        actual_value: event.actual_value,
        // The usual side of a slot-less row (display only), so the colour
        // and the "pre-release" chip beside it clear at the same moment.
        display_time: event.display_time,
      },
      now,
    )
  ) {
    return PRE_RELEASE_ACTUAL_CHIP_CLASS;
  }
  return settledActualChipClass(event);
}

/**
 * The actual chip's tone once the print window is open: beat / miss / neutral,
 * with no pre-release check. actualChipClass falls through to this; the
 * pre-release chip's timer switches to it when the window opens.
 */
export function settledActualChipClass(
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

/** What a past card says when its release came and went with nothing captured. */
export const NO_ACTUAL_RECORDED_LABEL = "no actual recorded";

/**
 * Whether a card carries the muted "no actual recorded" tag (owner-approved
 * 2026-10-07): the event's date is behind us, nothing is stored as its
 * actual, and the row comes from a source that normally records one — a
 * FRED-scheduled or hardcoded macro release (`fred:` / `nonfred:` source
 * keys) or a vendor earnings row (Finnhub, Nasdaq). Without it a release that
 * was never captured looks exactly like one that has not happened yet.
 *
 * Never a hand-entered row: nothing promises an actual for one. Today's own
 * rows are not past. Reads the STORED actual, so a figure that is on file but
 * withheld as implausible is not called "not recorded".
 */
export function showsNoActualRecorded(
  event: Pick<CalendarEvent, "source" | "source_key" | "event_type" | "event_date" | "actual_value">,
  todayIso: string,
): boolean {
  if (!event.event_date || event.event_date >= todayIso) return false;
  if (event.actual_value != null && event.actual_value.trim() !== "") return false;
  if (event.source === "manual") return false;
  if (event.event_type === "earnings") return event.source === "finnhub" || event.source === "nasdaq";
  const key = typeof event.source_key === "string" ? event.source_key : "";
  return key.startsWith(FRED_SOURCE_KEY_PREFIX) || key.startsWith("nonfred:");
}

/** Layout classes of the "actual …" chip — the JSX literal in EventRow must match. */
const ACTUAL_CHIP_LAYOUT = "text-[11px] font-mono rounded px-1.5 py-0.5 ml-auto max-w-full break-words";

/**
 * The card's own classes. The hover cue is added only for a card that does
 * something when clicked (a link to the security hub, or the reaction-detail
 * disclosure), so a static card never looks clickable. The link/disclosure
 * wrappers in EventRow read the same flags.
 */
export function eventCardClass(interactive: boolean): string {
  const base = "rounded-lg bg-raised border border-edge p-3";
  return interactive ? `${base} hover:border-edge-strong transition-colors` : base;
}

/**
 * Whether a card opens the full reaction detail (owner ruling 2026-08-30):
 * an enriched macro row — released, enriched, with a snapshot measured on its
 * own date (releasedFigureGates) that holds at least one usable leg. Earnings
 * rows and linked rows are not disclosures: a linked card already goes to the
 * security hub.
 */
export function macroCardExpandable(
  event: Pick<
    CalendarEvent,
    "event_type" | "security_id" | "event_date" | "enriched_at" | "reaction_snapshot"
  >,
  todayIso: string,
): boolean {
  if (event.event_type === "earnings" || event.security_id) return false;
  if (!releasedFigureGates(event, todayIso).showReaction) return false;
  const snap = parseReactionSnapshot(event.reaction_snapshot ?? null);
  if (!snap) return false;
  return [snap.symbol, snap.spy, snap.qqq, snap.tlt, snap.sector].some((leg) =>
    isUsableReactionLeg(leg),
  );
}

function EventRow({ event: storedEvent, todayIso }: { event: DisplayedEvent; todayIso: string }) {
  // A hand-entered earnings row prints its market slot, not "(Manual entry)".
  // Display only: every other read below is untouched by the title.
  const event: DisplayedEvent = { ...storedEvent, title: weekAheadTitle(storedEvent) };
  // "time unknown" for an earnings row with no clock time — never a blank and
  // never a default (user ruling 2026-10-05). Single-sourced with Today's
  // releases in lib/calendar/release-times.ts.
  // display_time (attached by the page) replaces a slot-less vendor row's
  // stored default with the company's usual time, or "time unknown" (user
  // ruling 2026-10-06). Display only — sorting above still uses the stored time.
  const time = eventTimeLabel(event);
  const symbol = event.symbol ?? null;
  const { consensusDisplay, actualDisplay: rawActualDisplay } = eventFigureDisplays(event);
  const { released, showReaction } = releasedFigureGates(event, todayIso);
  const actualDisplay = released ? rawActualDisplay : null;
  // Owner ruling 2026-10-06 (display-only): an actual saved before the
  // print's own BMO/AMC window opened is shown muted under a "pre-release"
  // chip, never colored as a beat/miss. Reverts once the window opens.
  const preRelease = !!actualDisplay && isPreReleaseActual(event);
  // One decision each for "is a link" and "is a disclosure"; the card's hover
  // cue and the wrappers below both read them.
  const linked = !!event.security_id;
  const expandable = macroCardExpandable(event, todayIso);
  const cardClass = eventCardClass(linked || expandable);
  const body = (
    <>
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        {time && (
          <span className="text-[11px] font-mono text-ink-faint tabular-nums min-w-0 break-words">{time}</span>
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
        {/* Date-conflicted earnings row (calendar_events date_status ===
            'conflict', migration 057): without this the row is
            indistinguishable from a settled one, and the competing vendor
            date can be EARLIER than the one shown here — a real risk of
            missing a print. The chip is read-only; the Confirm / Use other
            date buttons sit under the card (never inside the link). */}
        <EarningsConflictMarker
          dateStatus={event.date_status}
          dateConflictWith={event.date_conflict_with}
          wrap
          resolveHere={conflictResolvableHere(event, todayIso)}
        />
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
        {/* A pre-release row goes through a small client component: one
            timer, set for the moment the print window opens, clears the chip
            and gives the figure its beat/miss tone without a reload. */}
        {preRelease && actualDisplay ? (
          <PreReleaseActualChips
            actualDisplay={actualDisplay}
            preReleaseClass={`${ACTUAL_CHIP_LAYOUT} ${actualChipClass(event)}`}
            settledClass={`${ACTUAL_CHIP_LAYOUT} ${settledActualChipClass(event)}`}
            chipText={preReleaseActualChipText(event.manual_actuals_at)}
            chipTitle={PRE_RELEASE_ACTUAL_TITLE}
            initiallyPreRelease
            clearsAtMs={preReleaseClearsAtMs(event)}
          />
        ) : (
          actualDisplay && (
            <span
              className={`text-[11px] font-mono rounded px-1.5 py-0.5 ml-auto max-w-full break-words ${actualChipClass(event)}`}
            >
              actual {actualDisplay}
            </span>
          )
        )}
      </div>
      <p
        className="text-[13px] text-ink-dim leading-snug line-clamp-2"
        title={event.title ?? undefined}
      >
        {event.title}
      </p>
      {/* Consensus stays visible even after the actual lands — an enriched
          past week is only useful if the print can be judged against the
          street (a bare "actual $6.18" hides a 16% miss). */}
      {consensusDisplay && (
        <p className="text-[12px] font-mono text-ink-faint mt-1.5 truncate">
          Cons: {consensusDisplay}
        </p>
      )}
      {showsNoActualRecorded(event, todayIso) && (
        <p className="text-[11px] text-ink-faint italic mt-1.5">{NO_ACTUAL_RECORDED_LABEL}</p>
      )}
      {/* Captured market reaction (public data, unmasked) — the week view is
          the Calendar Living Record's only week-level browse path, so enriched
          past weeks surface their reactions here. Earnings rows lead with the
          reporter's own move; macro rows show SPY/QQQ. */}
      {showReaction && event.reaction_snapshot && (
        <div className="mt-1.5 min-w-0 max-w-full">
          <EnrichmentRowSummary
            actual={null}
            snapshotRaw={event.reaction_snapshot}
            preferEventSymbol
            eventSymbol={event.event_type === "earnings" ? symbol : null}
            enrichedAt={event.enriched_at}
          />
        </div>
      )}
    </>
  );
  // The remove control and the date-conflict buttons sit under the card,
  // never inside the link.
  const resolvable = conflictResolvableHere(event, todayIso);
  const removeRow =
    weekAheadRemovable(event) || resolvable ? (
      <div className="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
        <ConflictActions event={event} todayIso={todayIso} />
        <RemoveRow event={event} />
      </div>
    ) : null;

  if (linked) {
    return (
      <li>
        <Link
          href={`/dashboard/security/${event.security_id}`}
          className="block group"
        >
          <div className={cardClass}>{body}</div>
        </Link>
        {removeRow}
      </li>
    );
  }
  if (expandable) {
    return (
      <li>
        <EnrichmentDisclosure
          className={cardClass}
          actual={actualDisplay}
          snapshotRaw={event.reaction_snapshot}
          enrichedAt={event.enriched_at}
        >
          {body}
        </EnrichmentDisclosure>
      </li>
    );
  }
  return (
    <li>
      <div className={cardClass}>{body}</div>
      {removeRow}
    </li>
  );
}
