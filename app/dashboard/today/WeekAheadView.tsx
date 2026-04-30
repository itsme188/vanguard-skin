import Link from "next/link";
import type { CalendarEvent } from "@/lib/types";
import { addDays, formatWeekRange } from "@/lib/calendar/date-utils";
import { formatFinnhubFigureCompact } from "@/lib/format/finnhub-figure";
import { PrivateText } from "@/lib/privacy/components";

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
  const todayIso = new Date().toISOString().slice(0, 10);
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

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-1">Week ahead</p>
          <h1 className="font-serif text-2xl text-gold tracking-tight">{formatWeekRange(weekOf)}</h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-faint font-mono">
            {totalEvents} {totalEvents === 1 ? "event" : "events"}
          </span>
          <Link
            href="/dashboard/today"
            className="text-[11px] uppercase tracking-widest text-ink-faint hover:text-gold border border-edge rounded-full px-3 py-1"
          >
            ← Today
          </Link>
        </div>
      </header>

      {totalEvents === 0 ? (
        <section className="rounded-xl border border-edge bg-panel p-5">
          <p className="text-[14px] text-ink-faint">
            No events scheduled this week. Calendar sync may not have run yet — check Charts ›
            Calendar (or trigger via the Sunday briefing).
          </p>
        </section>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-5">
          {days.map((day) => (
            <DayCard key={day.date} day={day} />
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
}

function DayCard({ day }: DayCardProps) {
  return (
    <section
      className={`rounded-xl border p-5 sm:p-6 min-w-0 ${
        day.isToday ? "border-blue bg-blue/8" : "border-edge bg-panel"
      }`}
    >
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-1">
        <div className="min-w-0">
          <p
            className={`text-[11px] uppercase tracking-widest mb-1 ${
              day.isToday ? "text-blue" : "text-ink-faint"
            }`}
          >
            {day.label}
          </p>
          <p className="font-serif text-2xl text-ink leading-tight">{fmtDayLabel(day.date)}</p>
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
        <ul className="space-y-2.5">
          {day.events.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EventRow({ event }: { event: CalendarEvent }) {
  const time = fmtTime(event.release_time ?? event.event_time);
  const symbol = event.symbol ?? null;
  const isEarnings = event.event_type === "earnings";
  // Earnings events store consensus + actual as Finnhub-shaped strings
  // ("EPS X.XX · Rev N"). Macro events (FRED/FOMC) store raw values
  // ("3.2%", "250K"). Only earnings need the compact formatter.
  const consensusDisplay = event.consensus_estimate
    ? isEarnings
      ? formatFinnhubFigureCompact(event.consensus_estimate)
      : event.consensus_estimate
    : null;
  const actualDisplay = event.actual_value
    ? isEarnings
      ? formatFinnhubFigureCompact(event.actual_value)
      : event.actual_value
    : null;
  const inner = (
    <div className="rounded-lg bg-raised border border-edge p-3.5 hover:border-edge-strong transition-colors">
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
        {actualDisplay && (
          <span className="text-[11px] font-mono text-up bg-up/10 rounded px-1.5 py-0.5 ml-auto truncate max-w-[60%]">
            <PrivateText>actual {actualDisplay}</PrivateText>
          </span>
        )}
      </div>
      <p className="text-[13px] text-ink-dim leading-snug line-clamp-2">{event.title}</p>
      {consensusDisplay && !actualDisplay && (
        <p className="text-[12px] font-mono text-ink-faint mt-1.5 truncate">
          <PrivateText>Cons: {consensusDisplay}</PrivateText>
        </p>
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
