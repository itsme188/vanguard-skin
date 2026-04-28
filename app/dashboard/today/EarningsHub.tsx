/**
 * Earnings Hub block on /dashboard/today.
 *
 * Server component. Renders all earnings events for the current week
 * (deduped: Finnhub preferred over manual when both exist) with per-row
 * status chips: held / watchlist / neither + preview-sent / recap-sent /
 * pending. Inline EarningsHubAddForm (client) lets the user manually
 * add an event Finnhub didn't have at sync time. "Refresh from Finnhub"
 * triggers /api/calendar/sync.
 */

import { db } from "@/lib/db";
import { getEarningsForWeekDeduped } from "@/lib/queries/calendar";
import { getSymbolStatus, type SymbolStatus } from "@/lib/queries/briefing-symbols";
import { getCurrentMonday, addDays } from "@/lib/calendar/date-utils";
import type { CalendarEvent } from "@/lib/types";
import { EarningsHubAddForm } from "./EarningsHubAddForm";
import { EarningsHubRefreshButton } from "./EarningsHubRefreshButton";

interface EmailAuditRow {
  event_id: number;
  phase: "preview" | "recap";
}

type EnrichedRow = CalendarEvent & {
  status: SymbolStatus;
  previewSent: boolean;
  recapSent: boolean;
};

function fmtDay(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function fmtSlot(eventTime: string | null, releaseTime: string | null): string {
  const t = (eventTime ?? "").trim().toUpperCase();
  if (t === "BMO") return `BMO${releaseTime ? ` ${releaseTime}` : ""}`;
  if (t === "AMC") return `AMC${releaseTime ? ` ${releaseTime}` : ""}`;
  if (releaseTime) return releaseTime;
  return t || "TBD";
}

function statusChipClass(status: SymbolStatus): string {
  if (status === "held") return "text-up bg-up/15";
  if (status === "watchlist") return "text-gold bg-gold/15";
  return "text-ink-faint bg-raised";
}

function statusChipLabel(status: SymbolStatus): string {
  if (status === "held") return "held";
  if (status === "watchlist") return "watchlist";
  return "no-position";
}

export function EarningsHub() {
  const weekOf = getCurrentMonday();
  const weekEnd = addDays(weekOf, 6);
  const events = getEarningsForWeekDeduped(db, weekOf);

  const symbols = events
    .map((e) => e.symbol)
    .filter((s): s is string => !!s);
  const statusMap = getSymbolStatus(db, symbols);

  // One audit-row lookup for the whole week, joined client-side. Cheaper
  // than running a per-row query inside the render loop.
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

  const enriched: EnrichedRow[] = events.map((e) => ({
    ...e,
    status: e.symbol ? (statusMap[e.symbol.toUpperCase()] ?? "neither") : "neither",
    previewSent: previewSet.has(e.id),
    recapSent: recapSet.has(e.id),
  }));

  // Group by event_date for day-headers.
  const byDay = new Map<string, EnrichedRow[]>();
  for (const e of enriched) {
    const list = byDay.get(e.event_date) ?? [];
    list.push(e);
    byDay.set(e.event_date, list);
  }
  const days = Array.from(byDay.keys()).sort();

  return (
    <section className="rounded-xl border border-edge bg-panel p-5">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-ink">Earnings this week</h2>
        <span className="text-[11px] text-ink-faint font-mono">
          {weekOf} → {weekEnd} · {events.length} event{events.length === 1 ? "" : "s"}
        </span>
      </div>

      {events.length === 0 ? (
        <p className="text-[13px] text-ink-faint mb-3">
          No earnings events for this week. Click &ldquo;Refresh from Finnhub&rdquo; or add one manually below.
        </p>
      ) : (
        <ul className="divide-y divide-edge -mx-5 mb-3">
          {days.map((day) => (
            <li key={day} className="px-5 py-3">
              <h3 className="text-[11px] uppercase tracking-widest text-ink-dim mb-2">
                {fmtDay(day)}
              </h3>
              <ul className="space-y-1.5">
                {byDay.get(day)!.map((e) => (
                  <EarningsRow key={e.id} event={e} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-edge -mx-5 px-5">
        <EarningsHubAddForm weekOf={weekOf} />
        <EarningsHubRefreshButton weekOf={weekOf} />
      </div>
    </section>
  );
}

function EarningsRow({ event }: { event: EnrichedRow }) {
  const slot = fmtSlot(event.event_time, event.release_time);
  const isManual = event.source === "manual";
  return (
    <li className="text-[12px] flex items-baseline gap-2">
      <span className="font-mono text-[11px] text-ink-faint w-20 shrink-0">{slot}</span>
      <span
        className={`text-[10px] font-mono uppercase tracking-wider rounded px-1.5 py-0.5 shrink-0 ${statusChipClass(event.status)}`}
        title={`Position: ${event.status}`}
      >
        {statusChipLabel(event.status)}
      </span>
      <span className="font-mono font-medium text-ink w-16 shrink-0">
        {event.symbol ?? "—"}
      </span>
      <span className="flex-1 min-w-0 text-ink-dim truncate">
        {event.enriched_at && event.actual_value
          ? <>actual {event.actual_value}</>
          : event.consensus_estimate
            ? <>consensus {event.consensus_estimate}</>
            : <span className="italic text-ink-faint">no consensus on file{isManual ? " (manual)" : ""}</span>}
      </span>
      <span className="flex items-center gap-1 shrink-0">
        <span
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${event.previewSent ? "text-up bg-up/15" : "text-ink-faint bg-raised"}`}
          title={event.previewSent ? "Preview email sent" : "Preview pending"}
        >
          {event.previewSent ? "✓ pre" : "pre"}
        </span>
        <span
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${event.recapSent ? "text-up bg-up/15" : "text-ink-faint bg-raised"}`}
          title={event.recapSent ? "Recap email sent" : "Recap pending"}
        >
          {event.recapSent ? "✓ rec" : "rec"}
        </span>
      </span>
    </li>
  );
}
