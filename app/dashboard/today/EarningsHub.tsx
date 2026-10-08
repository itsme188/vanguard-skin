/**
 * Earnings Hub — terminal-style data desk for the Today page.
 *
 * Color palette flows through CSS tokens — adapts to the active theme:
 *   light → cream surfaces, deep moss brand, sage green / burned sienna for gain/loss
 *   dark  → soft black surfaces, amber brand, semantic green / red
 *
 * Desktop (md+): wide grid with explicit columns —
 *   DATE / TIME · POS · TICKER · CONS EPS · ACT EPS · CONS REV · ACT REV · Δ · BOG · EMAIL
 *   No truncation. Day-of-week separators.
 *
 * Mobile: stacked card per event, two visual rows —
 *   Row 1: ticker · status · time · email chips
 *   Row 2: Cons $0.46 · $3.85B   →   Actual $0.91 · $4.34B (+5.0%)
 *
 * Numbers are run through formatFinnhubFigure → formatLargeUSD so the raw
 * Finnhub `"EPS X.XX · Rev N"` blob never reaches the user.
 */

import Link from "next/link";
import { db } from "@/lib/db";
import { getEarningsForWeekDeduped } from "@/lib/queries/calendar";
import {
  withDisplayTimes,
  type EarningsDisplayTime,
} from "@/lib/calendar/display-earnings-time";
import { getSymbolStatus, type SymbolStatus } from "@/lib/queries/briefing-symbols";
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";
import { decorateCockpitIntel } from "@/lib/queries/earnings-intel";
import { getCurrentMonday, addDays, mondayOf, todayET, formatWeekRange } from "@/lib/calendar/date-utils";
import { formatFinnhubFigure } from "@/lib/format/finnhub-figure";
import { effectiveConsensus } from "@/lib/calendar/consensus";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
import { actualsAreImplausible } from "@/lib/earnings/actuals-display";
import { epsDelta, deltaToneClass } from "@/lib/earnings/eps-delta";
import type { CalendarEvent } from "@/lib/types";
import { SymbolLink } from "../components/SymbolLink";
import { EarningsHubAddForm } from "./EarningsHubAddForm";
import { EarningsHubDateCorrectionNote } from "./EarningsHubDateCorrectionNote";
import { RecapFigureButton } from "./RecapFigureButton";
import { EarningsHubRefreshButton } from "./EarningsHubRefreshButton";
import { EarningsRowChips } from "./EarningsRowChips";
import EarningsHubLive, { LivePrintSlot } from "./EarningsHubLive";
import { EarningsDeleteButton } from "./EarningsDeleteButton";
import { fixDateOrigin } from "@/lib/calendar/fix-date-suppression";
import { getEmailIgnoredManualTwins } from "@/lib/queries/manual-twin-email";
import { emailFollowsEarlierCopy } from "./email-follows-earlier-copy";
import { EarningsDateChip } from "./EarningsDateChip";
import { BogeysUploadButton } from "./BogeysUploadButton";
import { BogeysEditButton } from "./BogeysEditButton";
import { getSkippedPhasesForEvents } from "@/lib/queries/earnings-skips";
import { getWorksheetFlagsForEvents } from "@/lib/queries/earnings-worksheet-flags";
import { getSentPhasesForEvents } from "@/lib/queries/earnings-emails";
import { bogeyHasContentSql } from "@/lib/mutations/earnings-bogeys";
import { statusChipClass, statusChipLabel } from "./status-chip";
import { Chip } from "../components/Chip";
import { preReleaseClearsAtMs } from "./pre-release-clear";
import {
  isPreReleaseActual,
  preReleaseActualChipText,
  PRE_RELEASE_ACTUAL_TITLE,
} from "@/lib/calendar/pre-release-actual";

type EnrichedRow = CalendarEvent & {
  display_time: EarningsDisplayTime;
  status: SymbolStatus;
  previewSent: boolean;
  recapSent: boolean;
  previewSkipped: boolean;
  worksheetArmed: boolean;
  worksheetPrinted: boolean;
  recapSkipped: boolean;
  hasBogeys: boolean;
  /**
   * Set on the LATER of two live hand-entered rows for one company: the date
   * of the earlier row, which email follows instead (owner ruling
   * 2026-10-07). Null on every other row.
   */
  emailFollowsDate: string | null;
};

function fmtDayLong(iso: string): { weekday: string; date: string } {
  const d = new Date(iso + "T12:00:00");
  return {
    weekday: d.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase(),
    date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  };
}

// A slot-less vendor row stores the 16:15 default; printing it would read as
// a confirmed time. For those rows the cell shows the company's usual time
// (an estimate) or "time unknown" instead — display only, the stored time and
// every gate that reads it are unchanged (user ruling 2026-10-06).
function fmtSlot(
  eventTime: string | null,
  releaseTime: string | null,
  display: EarningsDisplayTime,
): string {
  if (display.label && display.kind !== "stored") return display.label;
  const t = (eventTime ?? "").trim().toUpperCase();
  // A clock time with no slot shows alone: a dash in the slot position read
  // as "unknown" beside a time that already settles it.
  if (releaseTime) return t ? `${t} · ${releaseTime}` : releaseTime;
  return t || "TBD";
}

/**
 * The WHEN cell of one row. Vendor rows carry no event_time: their BMO/AMC
 * slot is the vendor hour in raw_json, which deriveEarningsSlot reads (the
 * same resolver the pre-print floor and the date popover use). Without it the
 * cell printed a dash where the rest of the page said AMC.
 */
export function whenCell(row: {
  event_time: string | null;
  release_time: string | null;
  raw_json: string | null;
  display_time: EarningsDisplayTime;
}): string {
  const event = row.event_time?.trim()
    ? row
    : { ...row, event_time: deriveEarningsSlot(row)?.toUpperCase() ?? null };
  return fmtSlot(event.event_time, event.release_time, event.display_time);
}

/** The estimate/unknown label for the chips, or null when the time is the stored one. */
function estimateLabel(display: EarningsDisplayTime): string | null {
  return display.kind === "stored" ? null : display.label;
}

// statusChipClass / statusChipLabel moved to ./status-chip.ts ([C-17],
// live print v2 slice A Task 5) — a pure module so they can be unit tested
// without pulling in this file's `db` singleton import.

// epsDelta / deltaToneClass moved to lib/earnings/eps-delta.ts (unchanged)
// so WeekAheadView's "actual …" chip can reuse the same beat/miss logic
// instead of forking it (QA finding
// today-week-ahead--actual-chip-always-green-miss-reads-as-beat-regression-3).

// Re-exported so existing importers (WeekAheadView, tests) keep working —
// the guard itself now lives in lib/earnings/actuals-display.ts alongside
// its manual-override bypass (QA finding
// today-earningshub-actuals--manual-override-silently-suppressed-by-plausibility-guard).
export { actualsAreImplausible } from "@/lib/earnings/actuals-display";

const IMPLAUSIBLE_TOOLTIP =
  "Reported actuals flagged as implausible vs. consensus — see email scoreboard for details.";

// QA follow-up (landing review, commit 256833e5): getCurrentMonday() rolls
// Sat/Sun FORWARD to next Monday by design (this hub looks ahead), so on a
// weekend `weekOf` names a week that is not the week containing today.
// "No earnings events this week." on a weekend describes NEXT week, not
// the week the reader is standing in. Mirrors WeekAheadView's
// weekAheadHeaderState (mondayOf(todayIso) = the week containing today) —
// same "This week" vs. "week of {range}" split, just phrased as an
// empty-state sentence instead of a header micro-label.
export function earningsHubEmptyStateCopy(weekOf: string, todayIso: string): string {
  if (weekOf === mondayOf(todayIso)) {
    return "No earnings events this week.";
  }
  return `No earnings events for the week of ${formatWeekRange(weekOf)}.`;
}

// On a weekend the hub already shows NEXT week (getCurrentMonday rolls
// forward), which the week-ahead navigator heads "Week ahead"; "this week"
// there means the week containing today. One definition for both surfaces.
export function earningsHubHeading(weekOf: string, todayIso: string): string {
  return weekOf === mondayOf(todayIso) ? "Earnings This Week" : "Earnings Week Ahead";
}

export function EarningsHub() {
  const weekOf = getCurrentMonday();
  const weekEnd = addDays(weekOf, 6);
  const events = withDisplayTimes(db, getEarningsForWeekDeduped(db, weekOf));

  const symbols = events.map((e) => e.symbol).filter((s): s is string => !!s);
  const statusMap = getSymbolStatus(db, symbols);

  // getSentPhasesForEvents already excludes live 'in_progress' claim rows
  // (see the tri-state note in lib/digest/send-earnings-email.ts) — a claim
  // held by a still-composing (or crashed) send hasn't delivered anything,
  // so it must not render a "sent" chip. 'sent-by-cloud' rows DO count.
  const sentPhases = getSentPhasesForEvents(db, events.map((e) => e.id));

  const bogeysSet = new Set<number>();
  if (events.length > 0) {
    const rows = db
      .prepare(
        `SELECT DISTINCT event_id FROM earnings_bogeys
          WHERE event_id IN (${events.map(() => "?").join(",")})
            AND ${bogeyHasContentSql()}`,
      )
      .all(...events.map((e) => e.id)) as { event_id: number }[];
    for (const r of rows) bogeysSet.add(r.event_id);
  }

  const skipMap = getSkippedPhasesForEvents(db, events.map((e) => e.id));
  const worksheetMap = getWorksheetFlagsForEvents(db, events.map((e) => e.id));

  // The first paint carries the stage chips with no client fetch (spec 4.6).
  // Both calls are read-only: decorateCockpitIntel reads already-computed intel
  // rows; the refresh that WRITES them stays on the route's POST, which the
  // client controller only issues on its 60-second timer.
  const initialCockpit = buildCockpitPayload(db, new Date(), { weekOf });
  decorateCockpitIntel(db, initialCockpit);

  // With two live hand-entered rows for one company, email follows the
  // earlier date; the later row is marked so the desk knows why it is quiet.
  // Same read every email finder uses, so the mark and the sends cannot
  // disagree.
  const ignoredManualTwins = getEmailIgnoredManualTwins(db);

  const enriched: EnrichedRow[] = events.map((e) => ({
    ...e,
    status: e.symbol ? (statusMap[e.symbol.toUpperCase()] ?? "neither") : "neither",
    previewSent: sentPhases[e.id]?.preview ?? false,
    recapSent: sentPhases[e.id]?.recap ?? false,
    previewSkipped: skipMap[e.id]?.preview ?? false,
    recapSkipped: skipMap[e.id]?.recap ?? false,
    worksheetArmed: worksheetMap.has(e.id),
    worksheetPrinted: worksheetMap.get(e.id)?.printedAt != null,
    hasBogeys: bogeysSet.has(e.id),
    emailFollowsDate: ignoredManualTwins.get(e.id)?.emailRowDate ?? null,
  }));

  // Group by event_date for day separators.
  const byDay = new Map<string, EnrichedRow[]>();
  for (const e of enriched) {
    const list = byDay.get(e.event_date) ?? [];
    list.push(e);
    byDay.set(e.event_date, list);
  }
  const days = Array.from(byDay.keys()).sort();

  const heldCount = enriched.filter((e) => e.status === "held").length;
  const watchCount = enriched.filter((e) => e.status === "watchlist").length;

  // No overflow-hidden on the section: EarningsDateChip popovers on the last
  // rows extend past the section's bottom edge, and clipping cut their error
  // text to a sliver. Corner rounding lives on the header/footer bands.
  return (
    <section className="rounded-xl border border-edge bg-panel card-elev">
      {/* Section header — uppercase mono micro-label, tracking, dim subtitle */}
      <div className="flex items-baseline justify-between flex-wrap gap-2 px-5 py-3 border-b border-edge bg-raised rounded-t-xl">
        <div className="flex items-baseline gap-3">
          <h2
            className="font-mono uppercase font-semibold text-ink"
            style={{ fontSize: "12px", letterSpacing: "0.2em" }}
          >
            {earningsHubHeading(weekOf, todayET())}
          </h2>
          <span
            className="font-mono text-ink-faint"
            style={{ fontSize: "11px", letterSpacing: "0.1em" }}
          >
            {/* Each date is its own no-wrap run, so a narrow header can only
                break at the arrow, never inside a date. */}
            <span className="whitespace-nowrap">{weekOf}</span> →{" "}
            <span className="whitespace-nowrap">{weekEnd}</span>
          </span>
        </div>
        <div className="flex items-baseline gap-2 font-mono" style={{ fontSize: "11px" }}>
          <span className="text-ink-faint">{events.length} {events.length === 1 ? "event" : "events"}</span>
          {heldCount > 0 && <span className="text-up">· {heldCount} held</span>}
          {watchCount > 0 && <span className="text-gold-ink">· {watchCount} watchlist</span>}
          <Link
            href="/dashboard/alerts?view=emails"
            className="relative text-ink-faint hover:text-ink pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
            title="Archive of every sent earnings preview and recap email"
          >
            · All sent →
          </Link>
        </div>
      </div>

      <EarningsHubLive
        weekOf={weekOf}
        eventIds={enriched.map((e) => e.id)}
        initialCockpit={initialCockpit}
      >
        {events.length === 0 ? (
          <p className="px-5 py-6 text-[14px] text-ink-faint">
            {earningsHubEmptyStateCopy(weekOf, todayET())} Click{" "}
            <span className="text-gold-ink">↻ Refresh from Finnhub</span> below
            or add one manually.
          </p>
        ) : (
          <>
            {/* Desktop: explicit-column grid table.
                earnings-hub-desktop is the responsive hook in globals.css —
                when the chat rail is open and viewport is below 2xl, the
                desktop grid is force-hidden and the mobile card layout takes
                over (avoids the 4×~20px column-collapse bug at 1280px). */}
            <div className="hidden md:block earnings-hub-desktop">
              {/* Column headers */}
              <div
                className="grid items-baseline px-5 py-2 border-b border-edge font-mono uppercase bg-raised text-ink-faint"
                style={{
                  gridTemplateColumns: DESKTOP_GRID_COLUMNS,
                  gap: "16px",
                  fontSize: "10px",
                  letterSpacing: "0.22em",
                }}
              >
                <span>When</span>
                <span>Pos</span>
                <span>Ticker</span>
                <span>Cons EPS</span>
                <span>Act EPS</span>
                <span>Cons Rev</span>
                <span>Act Rev</span>
                <span style={{ textAlign: "right" }}>Δ</span>
                <span style={{ textAlign: "center" }}>Bogeys</span>
                <span style={{ textAlign: "right" }}>Email</span>
              </div>
              {days.map((day) => {
                const dayLabel = fmtDayLong(day);
                return (
                  <div key={day}>
                    {/* Day separator — gold-tinted brand micro-label */}
                    <div
                      className="px-5 py-2 flex items-baseline gap-3 border-b border-edge bg-raised font-mono uppercase"
                      style={{ fontSize: "11px", letterSpacing: "0.18em" }}
                    >
                      <span className="text-gold-ink font-semibold">{dayLabel.weekday}</span>
                      <span className="text-ink-faint">· {dayLabel.date}</span>
                      <span className="text-ink-faint ml-auto" style={{ fontSize: "10px" }}>
                        {byDay.get(day)!.length} event{byDay.get(day)!.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {byDay.get(day)!.map((e) => (
                      <div key={e.id}>
                        <DesktopRow event={e} />
                        <LivePrintSlot eventId={e.id} symbol={e.symbol ?? ""} armed={e.worksheetArmed} />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>

            {/* Mobile: stacked card per event, day separators inline.
                earnings-hub-mobile is the responsive hook in globals.css —
                promoted to block at md+ when the chat rail squeezes content. */}
            <div className="block md:hidden divide-y divide-edge earnings-hub-mobile">
              {days.map((day) => {
                const dayLabel = fmtDayLong(day);
                return (
                  <div key={day}>
                    <div
                      className="px-5 py-2 bg-raised font-mono uppercase flex items-baseline gap-2"
                      style={{ fontSize: "11px", letterSpacing: "0.18em" }}
                    >
                      <span className="text-gold-ink font-semibold">{dayLabel.weekday}</span>
                      <span className="text-ink-faint">· {dayLabel.date}</span>
                    </div>
                    {byDay.get(day)!.map((e) => (
                      <div key={e.id}>
                        <MobileCard event={e} />
                        <LivePrintSlot eventId={e.id} symbol={e.symbol ?? ""} armed={e.worksheetArmed} />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </EarningsHubLive>

      {/* Footer toolbar — secondary action row */}
      <div className="flex flex-col gap-2 px-5 py-3 border-t border-edge bg-raised rounded-b-xl">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <EarningsHubAddForm weekOf={weekOf} />
          <EarningsHubRefreshButton weekOf={weekOf} />
        </div>
        <EarningsHubDateCorrectionNote weekOf={weekOf} />
        <div className="flex items-center justify-start gap-2 pt-1">
          <BogeysUploadButton weekOf={weekOf} />
        </div>
      </div>
    </section>
  );
}

// Single source for the desktop table's column template (header + rows must
// never drift). Email column is 160px (was 96px, 2026-08-04): it holds up to
// five controls — preview/recap chips, worksheet arm, gen recap, delete — and
// at 96px they mashed into an illegible pile. Width came from Δ (64→56) and
// Bogeys (80→64); the 1fr numeric columns absorb the rest.
const DESKTOP_GRID_COLUMNS = "84px 64px 92px 1fr 1fr 1fr 1fr 56px 64px 160px";

/**
 * The mark on the later of two hand-entered rows for one company. Plain
 * always-visible text (no hover), public calendar data only. Renders nothing
 * for an unmarked row.
 */
function EmailFollowsEarlierNote({
  symbol,
  emailFollowsDate,
  className,
  style,
}: {
  symbol: string | null;
  emailFollowsDate: string | null;
  className?: string;
  style?: React.CSSProperties;
}) {
  if (!emailFollowsDate || !symbol) return null;
  return (
    <span className={`text-ink-dim ${className ?? ""}`} style={{ fontSize: "11px", ...style }}>
      {emailFollowsEarlierCopy(symbol, emailFollowsDate)}
    </span>
  );
}

function DesktopRow({ event }: { event: EnrichedRow }) {
  const slot = whenCell(event);
  const consensus = effectiveConsensus(event);
  const cons = formatFinnhubFigure(consensus);
  const isPostRelease = !!event.enriched_at && !!event.actual_value;
  const implausible =
    isPostRelease && actualsAreImplausible(consensus, event.actual_value, event.manual_actuals_at);
  const actRaw = isPostRelease
    ? formatFinnhubFigure(event.actual_value)
    : { eps: null, revenue: null, fallback: null };
  const act = implausible ? { eps: null, revenue: null, fallback: null } : actRaw;
  const delta =
    isPostRelease && !implausible
      ? epsDelta(consensus, event.actual_value)
      : null;
  // Owner ruling 2026-10-06 (display-only): an actual saved before the
  // print's own BMO/AMC window opened renders muted under a "pre-release"
  // chip, never as reported fact. Reverts on its own once the window opens.
  const preRelease = isPostRelease && !implausible && isPreReleaseActual(event);
  // When a pre-release event has no consensus at all (Finnhub hasn't
  // published estimates), the four numeric cells used to render as a row of
  // em-dashes which read as broken. Show a single italic hint spanning the
  // four data columns instead.
  const consensusMissing = !cons.eps && !cons.revenue && !isPostRelease;

  return (
    <div
      className="grid items-baseline px-5 py-2.5 border-b border-edge transition-colors hover:bg-muted"
      style={{
        gridTemplateColumns: DESKTOP_GRID_COLUMNS,
        gap: "16px",
        fontSize: "13px",
      }}
    >
      <span className="font-mono text-ink-faint" style={{ fontSize: "11px" }}>
        {slot}
      </span>
      <span
        className={`font-mono uppercase rounded px-1.5 py-0.5 inline-block w-fit ${statusChipClass(event.status)}`}
        style={{ fontSize: "10px", letterSpacing: "0.08em" }}
      >
        {statusChipLabel(event.status)}
      </span>
      <span className="font-mono font-medium text-ink" style={{ fontSize: "14px" }}>
        {event.symbol && event.security_id != null ? (
          <SymbolLink securityId={event.security_id} symbol={event.symbol} />
        ) : (
          event.symbol ?? "—"
        )}
        {preRelease && (
          <span className="block mt-0.5">
            <PreReleaseChip manualActualsAt={event.manual_actuals_at ?? null} />
          </span>
        )}
        {event.date_status && (
          <span className="block mt-0.5">
            <EarningsDateChip
              symbol={event.symbol ?? ""}
              eventDate={event.event_date}
              releaseTime={event.release_time}
              dateStatus={event.date_status}
              dateConflictWith={event.date_conflict_with}
            />
          </span>
        )}
      </span>
      {consensusMissing ? (
        <span
          className="text-ink-faint italic"
          style={{ gridColumn: "span 4 / span 4", fontSize: "12px" }}
        >
          Consensus not yet published
        </span>
      ) : (
        <>
          <NumCell value={cons.eps} recapEventId={event.recapSent ? event.id : undefined} />
          <NumCell value={act.eps} recapEventId={event.recapSent ? event.id : undefined} muted={preRelease} />
          <NumCell value={cons.revenue} recapEventId={event.recapSent ? event.id : undefined} />
          <NumCell value={act.revenue} recapEventId={event.recapSent ? event.id : undefined} muted={preRelease} />
        </>
      )}
      {implausible ? (
        <span
          className="font-mono text-gold-ink cursor-help"
          title={IMPLAUSIBLE_TOOLTIP}
          style={{ fontSize: "12px", textAlign: "right" }}
        >
          ⚠
        </span>
      ) : (
        <span
          className={`font-mono tabular-nums ${preRelease ? "text-ink-faint" : deltaToneClass(delta)}`}
          style={{ fontSize: "12px", textAlign: "right" }}
        >
          {delta?.label ?? "—"}
        </span>
      )}
      <span style={{ textAlign: "center" }}>
        {event.symbol && (
          <BogeysEditButton
            eventId={event.id}
            symbol={event.symbol}
            hasBogeys={event.hasBogeys}
          />
        )}
      </span>
      <span
        className="inline-flex items-center justify-end gap-1 min-w-0"
        style={{ textAlign: "right" }}
      >
        <EarningsRowChips
          eventId={event.id}
          previewSent={event.previewSent}
          recapSent={event.recapSent}
          previewSkipped={event.previewSkipped}
          recapSkipped={event.recapSkipped}
          worksheetArmed={event.worksheetArmed}
          worksheetPrinted={event.worksheetPrinted}
          timeEstimateLabel={estimateLabel(event.display_time)}
          preReleaseActualTitle={preRelease ? PRE_RELEASE_ACTUAL_TITLE : null}
          preReleaseClearsAtMs={preRelease ? preReleaseClearsAtMs(event) : null}
          printed={isPostRelease && !isPreReleaseActual(event)}
        />
        {/* Manual rows delete directly; sync rows delete-with-suppression
            (stays removed across syncs — the wrong-date correction path). */}
        <EarningsDeleteButton
          eventId={event.id}
          symbol={event.symbol}
          source={event.source}
          vendorDate={fixDateOrigin(event)}
        />
      </span>
      {/* Spans every column, so it sits on its own line under the row. */}
      <EmailFollowsEarlierNote
        symbol={event.symbol}
        emailFollowsDate={event.emailFollowsDate}
        style={{ gridColumn: "1 / -1" }}
      />
    </div>
  );
}

/**
 * Consensus / actual EPS + revenue are PUBLIC market data (any reader can
 * look them up) — they reveal nothing about the user's holdings, so they
 * render unmasked per the privacy-masks-portfolio-only rule (B16).
 *
 * On a recapped row (`recapEventId` set) a populated figure becomes a
 * button opening the recap viewer (R9) — same viewer the "rec ✓" chip
 * opens, via RecapFigureButton's scoped custom event.
 */
function NumCell({
  value,
  recapEventId,
  muted = false,
}: {
  value: string | null;
  recapEventId?: number;
  /** A pre-release actual (isPreReleaseActual): faint italic, not fact ink. */
  muted?: boolean;
}) {
  const cls = `font-mono tabular-nums truncate ${
    value && !muted ? "text-ink-dim" : muted ? "text-ink-faint italic" : "text-ink-faint"
  }`;
  if (recapEventId != null && value) {
    return (
      <RecapFigureButton eventId={recapEventId} className={cls} style={{ fontSize: "13px" }}>
        {value}
      </RecapFigureButton>
    );
  }
  return (
    <span className={cls} style={{ fontSize: "13px" }}>
      {value ?? "—"}
    </span>
  );
}

/** The "pre-release" warn chip for an actual saved before its print window
 *  opened. Top-level (never nested in a row body — the remount trap). */
function PreReleaseChip({ manualActualsAt }: { manualActualsAt: string | null }) {
  return (
    <Chip tone="warn" size="xs" title={PRE_RELEASE_ACTUAL_TITLE}>
      {preReleaseActualChipText(manualActualsAt)}
    </Chip>
  );
}

function MobileCard({ event }: { event: EnrichedRow }) {
  const slot = whenCell(event);
  const consensus = effectiveConsensus(event);
  const cons = formatFinnhubFigure(consensus);
  const isPostRelease = !!event.enriched_at && !!event.actual_value;
  const implausible =
    isPostRelease && actualsAreImplausible(consensus, event.actual_value, event.manual_actuals_at);
  const actRaw = isPostRelease
    ? formatFinnhubFigure(event.actual_value)
    : { eps: null, revenue: null, fallback: null };
  const act = implausible ? { eps: null, revenue: null, fallback: null } : actRaw;
  const delta =
    isPostRelease && !implausible
      ? epsDelta(consensus, event.actual_value)
      : null;
  // Owner ruling 2026-10-06 (display-only): an actual saved before the
  // print's own BMO/AMC window opened renders muted under a "pre-release"
  // chip, never as reported fact. Reverts on its own once the window opens.
  const preRelease = isPostRelease && !implausible && isPreReleaseActual(event);
  const consensusMissing = !cons.eps && !cons.revenue && !isPostRelease;

  return (
    <div className="px-5 py-3 border-b border-edge">
      <div className="flex items-baseline gap-2 flex-wrap mb-1.5">
        <span className="font-mono font-medium text-ink" style={{ fontSize: "16px" }}>
          {event.symbol && event.security_id != null ? (
            <SymbolLink securityId={event.security_id} symbol={event.symbol} />
          ) : (
            event.symbol ?? "—"
          )}
        </span>
        <span
          className={`font-mono uppercase rounded px-1.5 py-0.5 ${statusChipClass(event.status)}`}
          style={{ fontSize: "10px", letterSpacing: "0.08em" }}
        >
          {statusChipLabel(event.status)}
        </span>
        {preRelease && <PreReleaseChip manualActualsAt={event.manual_actuals_at ?? null} />}
        {event.date_status && (
          <EarningsDateChip
            symbol={event.symbol ?? ""}
            eventDate={event.event_date}
            releaseTime={event.release_time}
            dateStatus={event.date_status}
            dateConflictWith={event.date_conflict_with}
          />
        )}
        <span className="font-mono ml-auto text-ink-faint" style={{ fontSize: "11px" }}>
          {slot}
        </span>
      </div>
      <div className="flex items-baseline gap-3 flex-wrap font-mono tabular-nums" style={{ fontSize: "13px" }}>
        {consensusMissing ? (
          <span className="text-ink-faint italic" style={{ fontSize: "12px" }}>
            Consensus not yet published
          </span>
        ) : (
          <span className="text-ink-faint">
            Cons{" "}
            <span className="text-ink-dim">
              {cons.eps ?? "—"} · {cons.revenue ?? "—"}
            </span>
          </span>
        )}
        {isPostRelease ? (
          implausible ? (
            <>
              <span className="text-ink-faint">→</span>
              <span
                className="text-gold-ink italic cursor-help"
                title={IMPLAUSIBLE_TOOLTIP}
                style={{ fontSize: "12px" }}
              >
                ⚠ Reported actuals flagged as implausible
              </span>
            </>
          ) : (
            <>
              <span className="text-ink-faint">→</span>
              {event.recapSent ? (
                <RecapFigureButton eventId={event.id} className="text-ink-faint">
                  Act{" "}
                  <span className="text-ink-dim">
                    {act.eps ?? "—"} · {act.revenue ?? "—"}
                  </span>
                </RecapFigureButton>
              ) : (
                <span className="text-ink-faint">
                  Act{" "}
                  <span className={preRelease ? "text-ink-faint italic" : "text-ink-dim"}>
                    {act.eps ?? "—"} · {act.revenue ?? "—"}
                  </span>
                </span>
              )}
              {delta && (
                <span className={`font-semibold ${preRelease ? "text-ink-faint" : deltaToneClass(delta)}`}>
                  {delta.label}
                </span>
              )}
            </>
          )
        ) : null}
      </div>
      <div className="flex items-center gap-2 mt-2">
        {event.symbol && (
          <BogeysEditButton
            eventId={event.id}
            symbol={event.symbol}
            hasBogeys={event.hasBogeys}
          />
        )}
        <EarningsRowChips
          eventId={event.id}
          previewSent={event.previewSent}
          recapSent={event.recapSent}
          previewSkipped={event.previewSkipped}
          recapSkipped={event.recapSkipped}
          worksheetArmed={event.worksheetArmed}
          worksheetPrinted={event.worksheetPrinted}
          timeEstimateLabel={estimateLabel(event.display_time)}
          preReleaseActualTitle={preRelease ? PRE_RELEASE_ACTUAL_TITLE : null}
          preReleaseClearsAtMs={preRelease ? preReleaseClearsAtMs(event) : null}
          printed={isPostRelease && !isPreReleaseActual(event)}
        />
        {/* Manual rows delete directly; sync rows delete-with-suppression. */}
        <EarningsDeleteButton
          eventId={event.id}
          symbol={event.symbol}
          source={event.source}
          vendorDate={fixDateOrigin(event)}
        />
      </div>
      <EmailFollowsEarlierNote
        symbol={event.symbol}
        emailFollowsDate={event.emailFollowsDate}
        className="block mt-1.5"
      />
    </div>
  );
}
