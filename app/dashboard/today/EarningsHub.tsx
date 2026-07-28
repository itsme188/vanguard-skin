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

import { db } from "@/lib/db";
import { getEarningsForWeekDeduped } from "@/lib/queries/calendar";
import { getSymbolStatus, type SymbolStatus } from "@/lib/queries/briefing-symbols";
import { getCurrentMonday, addDays } from "@/lib/calendar/date-utils";
import { formatFinnhubFigure, parseFinnhubFigure } from "@/lib/format/finnhub-figure";
import { effectiveConsensus } from "@/lib/calendar/consensus";
import { isPlausibleEarnings } from "@/lib/digest/send-earnings-email";
import type { CalendarEvent } from "@/lib/types";
import { SymbolLink } from "../components/SymbolLink";
import { EarningsHubAddForm } from "./EarningsHubAddForm";
import { RecapFigureButton } from "./RecapFigureButton";
import { EarningsHubRefreshButton } from "./EarningsHubRefreshButton";
import { EarningsRowChips } from "./EarningsRowChips";
import { EarningsDeleteButton } from "./EarningsDeleteButton";
import { EarningsDateChip } from "./EarningsDateChip";
import { BogeysUploadButton } from "./BogeysUploadButton";
import { BogeysEditButton } from "./BogeysEditButton";
import { getSkippedPhasesForEvents } from "@/lib/queries/earnings-skips";
import { getSentPhasesForEvents } from "@/lib/queries/earnings-emails";

type EnrichedRow = CalendarEvent & {
  status: SymbolStatus;
  previewSent: boolean;
  recapSent: boolean;
  previewSkipped: boolean;
  recapSkipped: boolean;
  hasBogeys: boolean;
};

function fmtDayLong(iso: string): { weekday: string; date: string } {
  const d = new Date(iso + "T12:00:00");
  return {
    weekday: d.toLocaleDateString("en-US", { weekday: "long" }).toUpperCase(),
    date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  };
}

function fmtSlot(eventTime: string | null, releaseTime: string | null): string {
  const t = (eventTime ?? "").trim().toUpperCase();
  if (releaseTime) return `${t || "—"} · ${releaseTime}`;
  return t || "TBD";
}

function statusChipClass(status: SymbolStatus): string {
  if (status === "held") return "text-up bg-up/15 border border-up/30";
  if (status === "watchlist") return "text-gold-ink bg-gold/15 border border-gold/30";
  return "text-ink-faint bg-raised border border-edge";
}

function statusChipLabel(status: SymbolStatus): string {
  if (status === "held") return "HELD";
  if (status === "watchlist") return "WATCH";
  return "—";
}

/**
 * Compute beat/miss percent off EPS only — matches what users naturally
 * read off an earnings line. Returns formatted string + a sign hint for
 * coloring. null when either side missing.
 */
function epsDelta(consensus: string | null, actual: string | null): { label: string; sign: 1 | -1 | 0 } | null {
  const cons = formatFinnhubFigure(consensus);
  const act = formatFinnhubFigure(actual);
  if (!cons.eps || !act.eps) return null;
  // formatFinnhubFigure returns "$0.91"-style — strip $ to get number
  const c = Number(cons.eps.replace(/[$,]/g, ""));
  const a = Number(act.eps.replace(/[$,]/g, ""));
  if (!Number.isFinite(c) || !Number.isFinite(a) || c === 0) return null;
  const pct = ((a - c) / Math.abs(c)) * 100;
  const sign: 1 | -1 | 0 = Math.abs(pct) < 0.05 ? 0 : pct > 0 ? 1 : -1;
  if (sign === 0) return { label: "in-line", sign };
  return { label: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`, sign };
}

function deltaToneClass(delta: { sign: 1 | -1 | 0 } | null): string {
  if (delta == null) return "text-ink-faint";
  if (delta.sign === 1) return "text-up";
  if (delta.sign === -1) return "text-down";
  return "text-ink-dim";
}

/**
 * Run the same plausibility guard the email scoreboard uses, so a bogus
 * Finnhub actual (e.g. the GOOGL Q1 2026 5.11-vs-2.70 EPS scrape failure)
 * doesn't render verbatim on the Today view. Pre-release rows (no actual)
 * always pass — the guard is consensus-vs-actual.
 */
export function actualsAreImplausible(
  consensus: string | null,
  actual: string | null,
): boolean {
  if (!actual) return false;
  const c = parseFinnhubFigure(consensus);
  const a = parseFinnhubFigure(actual);
  return !isPlausibleEarnings(c.eps, a.eps, c.revenue, a.revenue);
}

const IMPLAUSIBLE_TOOLTIP =
  "Reported actuals flagged as implausible vs. consensus — see email scoreboard for details.";

export function EarningsHub() {
  const weekOf = getCurrentMonday();
  const weekEnd = addDays(weekOf, 6);
  const events = getEarningsForWeekDeduped(db, weekOf);

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
          WHERE event_id IN (${events.map(() => "?").join(",")})`,
      )
      .all(...events.map((e) => e.id)) as { event_id: number }[];
    for (const r of rows) bogeysSet.add(r.event_id);
  }

  const skipMap = getSkippedPhasesForEvents(db, events.map((e) => e.id));

  const enriched: EnrichedRow[] = events.map((e) => ({
    ...e,
    status: e.symbol ? (statusMap[e.symbol.toUpperCase()] ?? "neither") : "neither",
    previewSent: sentPhases[e.id]?.preview ?? false,
    recapSent: sentPhases[e.id]?.recap ?? false,
    previewSkipped: skipMap[e.id]?.preview ?? false,
    recapSkipped: skipMap[e.id]?.recap ?? false,
    hasBogeys: bogeysSet.has(e.id),
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

  return (
    <section className="rounded-xl border border-edge bg-panel overflow-hidden card-elev">
      {/* Section header — uppercase mono micro-label, tracking, dim subtitle */}
      <div className="flex items-baseline justify-between flex-wrap gap-2 px-5 py-3 border-b border-edge bg-raised">
        <div className="flex items-baseline gap-3">
          <h2
            className="font-mono uppercase font-semibold text-ink"
            style={{ fontSize: "12px", letterSpacing: "0.2em" }}
          >
            Earnings This Week
          </h2>
          <span
            className="font-mono text-ink-faint"
            style={{ fontSize: "11px", letterSpacing: "0.1em" }}
          >
            {weekOf} → {weekEnd}
          </span>
        </div>
        <div className="flex items-baseline gap-2 font-mono" style={{ fontSize: "11px" }}>
          <span className="text-ink-faint">{events.length} {events.length === 1 ? "event" : "events"}</span>
          {heldCount > 0 && <span className="text-up">· {heldCount} held</span>}
          {watchCount > 0 && <span className="text-gold-ink">· {watchCount} watchlist</span>}
        </div>
      </div>

      {events.length === 0 ? (
        <p className="px-5 py-6 text-[14px] text-ink-faint">
          No earnings events this week. Click <span className="text-gold-ink">↻ Refresh from Finnhub</span> below
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
                gridTemplateColumns: "84px 64px 92px 1fr 1fr 1fr 1fr 64px 80px 96px",
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
                    <DesktopRow key={e.id} event={e} />
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
                    <MobileCard key={e.id} event={e} />
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Footer toolbar — secondary action row */}
      <div className="flex flex-col gap-2 px-5 py-3 border-t border-edge bg-raised">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <EarningsHubAddForm weekOf={weekOf} />
          <EarningsHubRefreshButton weekOf={weekOf} />
        </div>
        <div className="flex items-center justify-start gap-2 pt-1">
          <BogeysUploadButton weekOf={weekOf} />
        </div>
      </div>
    </section>
  );
}

function DesktopRow({ event }: { event: EnrichedRow }) {
  const slot = fmtSlot(event.event_time, event.release_time);
  const consensus = effectiveConsensus(event);
  const cons = formatFinnhubFigure(consensus);
  const isPostRelease = !!event.enriched_at && !!event.actual_value;
  const implausible =
    isPostRelease && actualsAreImplausible(consensus, event.actual_value);
  const actRaw = isPostRelease
    ? formatFinnhubFigure(event.actual_value)
    : { eps: null, revenue: null, fallback: null };
  const act = implausible ? { eps: null, revenue: null, fallback: null } : actRaw;
  const delta =
    isPostRelease && !implausible
      ? epsDelta(consensus, event.actual_value)
      : null;
  // When a pre-release event has no consensus at all (Finnhub hasn't
  // published estimates), the four numeric cells used to render as a row of
  // em-dashes which read as broken. Show a single italic hint spanning the
  // four data columns instead.
  const consensusMissing = !cons.eps && !cons.revenue && !isPostRelease;

  return (
    <div
      className="grid items-baseline px-5 py-2.5 border-b border-edge transition-colors hover:bg-muted"
      style={{
        gridTemplateColumns: "84px 64px 92px 1fr 1fr 1fr 1fr 64px 80px 96px",
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
          <NumCell value={act.eps} recapEventId={event.recapSent ? event.id : undefined} />
          <NumCell value={cons.revenue} recapEventId={event.recapSent ? event.id : undefined} />
          <NumCell value={act.revenue} recapEventId={event.recapSent ? event.id : undefined} />
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
          className={`font-mono tabular-nums ${deltaToneClass(delta)}`}
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
        className="inline-flex items-center justify-end gap-1"
        style={{ textAlign: "right" }}
      >
        <EarningsRowChips
          eventId={event.id}
          previewSent={event.previewSent}
          recapSent={event.recapSent}
          previewSkipped={event.previewSkipped}
          recapSkipped={event.recapSkipped}
        />
        {/* Manual rows delete directly; sync rows delete-with-suppression
            (stays removed across syncs — the wrong-date correction path). */}
        <EarningsDeleteButton
          eventId={event.id}
          symbol={event.symbol}
          source={event.source}
        />
      </span>
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
function NumCell({ value, recapEventId }: { value: string | null; recapEventId?: number }) {
  const cls = `font-mono tabular-nums truncate ${value ? "text-ink-dim" : "text-ink-faint"}`;
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

function MobileCard({ event }: { event: EnrichedRow }) {
  const slot = fmtSlot(event.event_time, event.release_time);
  const consensus = effectiveConsensus(event);
  const cons = formatFinnhubFigure(consensus);
  const isPostRelease = !!event.enriched_at && !!event.actual_value;
  const implausible =
    isPostRelease && actualsAreImplausible(consensus, event.actual_value);
  const actRaw = isPostRelease
    ? formatFinnhubFigure(event.actual_value)
    : { eps: null, revenue: null, fallback: null };
  const act = implausible ? { eps: null, revenue: null, fallback: null } : actRaw;
  const delta =
    isPostRelease && !implausible
      ? epsDelta(consensus, event.actual_value)
      : null;
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
                  <span className="text-ink-dim">
                    {act.eps ?? "—"} · {act.revenue ?? "—"}
                  </span>
                </span>
              )}
              {delta && (
                <span className={`font-semibold ${deltaToneClass(delta)}`}>{delta.label}</span>
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
        />
        {/* Manual rows delete directly; sync rows delete-with-suppression. */}
        <EarningsDeleteButton
          eventId={event.id}
          symbol={event.symbol}
          source={event.source}
        />
      </div>
    </div>
  );
}
