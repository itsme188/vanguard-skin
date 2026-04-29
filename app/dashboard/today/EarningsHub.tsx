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
import { formatFinnhubFigure } from "@/lib/format/finnhub-figure";
import type { CalendarEvent } from "@/lib/types";
import { SymbolLink } from "../components/SymbolLink";
import { EarningsHubAddForm } from "./EarningsHubAddForm";
import { EarningsHubRefreshButton } from "./EarningsHubRefreshButton";
import { EarningsRowChips } from "./EarningsRowChips";
import { BogeysUploadButton } from "./BogeysUploadButton";
import { BogeysEditButton } from "./BogeysEditButton";

interface EmailAuditRow {
  event_id: number;
  phase: "preview" | "recap";
}

type EnrichedRow = CalendarEvent & {
  status: SymbolStatus;
  previewSent: boolean;
  recapSent: boolean;
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
  if (status === "watchlist") return "text-gold bg-gold/15 border border-gold/30";
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

export function EarningsHub() {
  const weekOf = getCurrentMonday();
  const weekEnd = addDays(weekOf, 6);
  const events = getEarningsForWeekDeduped(db, weekOf);

  const symbols = events.map((e) => e.symbol).filter((s): s is string => !!s);
  const statusMap = getSymbolStatus(db, symbols);

  const auditRows = events.length === 0
    ? []
    : (db
        .prepare(
          `SELECT event_id, phase FROM earnings_emails
            WHERE event_id IN (${events.map(() => "?").join(",")})`,
        )
        .all(...events.map((e) => e.id)) as EmailAuditRow[]);
  const previewSet = new Set<number>();
  const recapSet = new Set<number>();
  for (const r of auditRows) {
    if (r.phase === "preview") previewSet.add(r.event_id);
    if (r.phase === "recap") recapSet.add(r.event_id);
  }

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

  const enriched: EnrichedRow[] = events.map((e) => ({
    ...e,
    status: e.symbol ? (statusMap[e.symbol.toUpperCase()] ?? "neither") : "neither",
    previewSent: previewSet.has(e.id),
    recapSent: recapSet.has(e.id),
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
    <section className="rounded-xl border border-edge bg-panel overflow-hidden">
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
          <span className="text-ink-faint">{events.length} events</span>
          {heldCount > 0 && <span className="text-up">· {heldCount} held</span>}
          {watchCount > 0 && <span className="text-gold">· {watchCount} watchlist</span>}
        </div>
      </div>

      {events.length === 0 ? (
        <p className="px-5 py-6 text-[14px] text-ink-faint">
          No earnings events this week. Click <span className="text-gold">↻ Refresh from Finnhub</span> below
          or add one manually.
        </p>
      ) : (
        <>
          {/* Desktop: explicit-column grid table */}
          <div className="hidden md:block">
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
                    <span className="text-gold font-semibold">{dayLabel.weekday}</span>
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

          {/* Mobile: stacked card per event, day separators inline */}
          <div className="block md:hidden divide-y divide-edge">
            {days.map((day) => {
              const dayLabel = fmtDayLong(day);
              return (
                <div key={day}>
                  <div
                    className="px-5 py-2 bg-raised font-mono uppercase flex items-baseline gap-2"
                    style={{ fontSize: "11px", letterSpacing: "0.18em" }}
                  >
                    <span className="text-gold font-semibold">{dayLabel.weekday}</span>
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
  const cons = formatFinnhubFigure(event.consensus_estimate);
  const isPostRelease = !!event.enriched_at && !!event.actual_value;
  const act = isPostRelease
    ? formatFinnhubFigure(event.actual_value)
    : { eps: null, revenue: null, fallback: null };
  const delta = isPostRelease
    ? epsDelta(event.consensus_estimate, event.actual_value)
    : null;

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
      </span>
      <NumCell value={cons.eps} />
      <NumCell value={act.eps} />
      <NumCell value={cons.revenue} />
      <NumCell value={act.revenue} />
      <span
        className={`font-mono tabular-nums ${deltaToneClass(delta)}`}
        style={{ fontSize: "12px", textAlign: "right" }}
      >
        {delta?.label ?? "—"}
      </span>
      <span style={{ textAlign: "center" }}>
        {event.symbol && (
          <BogeysEditButton
            eventId={event.id}
            symbol={event.symbol}
            hasBogeys={event.hasBogeys}
          />
        )}
      </span>
      <span style={{ textAlign: "right" }}>
        <EarningsRowChips
          eventId={event.id}
          previewSent={event.previewSent}
          recapSent={event.recapSent}
        />
      </span>
    </div>
  );
}

function NumCell({ value }: { value: string | null }) {
  return (
    <span
      className={`font-mono tabular-nums truncate ${value ? "text-ink-dim" : "text-ink-faint"}`}
      style={{ fontSize: "13px" }}
    >
      {value ?? "—"}
    </span>
  );
}

function MobileCard({ event }: { event: EnrichedRow }) {
  const slot = fmtSlot(event.event_time, event.release_time);
  const cons = formatFinnhubFigure(event.consensus_estimate);
  const isPostRelease = !!event.enriched_at && !!event.actual_value;
  const act = isPostRelease
    ? formatFinnhubFigure(event.actual_value)
    : { eps: null, revenue: null, fallback: null };
  const delta = isPostRelease
    ? epsDelta(event.consensus_estimate, event.actual_value)
    : null;

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
        <span className="font-mono ml-auto text-ink-faint" style={{ fontSize: "11px" }}>
          {slot}
        </span>
      </div>
      <div className="flex items-baseline gap-3 flex-wrap font-mono tabular-nums" style={{ fontSize: "13px" }}>
        <span className="text-ink-faint">
          Cons{" "}
          <span className="text-ink-dim">
            {cons.eps ?? "—"} · {cons.revenue ?? "—"}
          </span>
        </span>
        {isPostRelease ? (
          <>
            <span className="text-ink-faint">→</span>
            <span className="text-ink-faint">
              Act{" "}
              <span className="text-ink-dim">
                {act.eps ?? "—"} · {act.revenue ?? "—"}
              </span>
            </span>
            {delta && (
              <span className={`font-semibold ${deltaToneClass(delta)}`}>{delta.label}</span>
            )}
          </>
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
        />
      </div>
    </div>
  );
}
