import { db } from "@/lib/db";
import { getUpcomingEvents } from "@/lib/queries/calendar";
import Link from "next/link";
import { SymbolLink } from "@/app/dashboard/components/SymbolLink";

// ── Event type icons (duplicated from EventCard for server component) ──

const EVENT_ICONS: Record<string, string> = {
  earnings: "📊",
  analyst_meeting: "🎤",
  conference: "🏛",
  split: "✂️",
  fomc: "🏦",
  cpi: "📈",
  jobs: "👷",
  gdp: "🌐",
  pmi: "🏭",
  retail_sales: "🛒",
  housing: "🏠",
  other_macro: "📅",
  other: "📌",
};

const IMPACT_COLORS: Record<string, string> = {
  high: "text-down",
  medium: "text-amber-400",
  low: "text-ink-faint",
};

/**
 * Server component — compact card for the Overview tab showing
 * the next upcoming calendar events.
 */
export function UpcomingEventsCard() {
  const today = new Date().toISOString().slice(0, 10);
  // Show events for the next 14 days
  const end = new Date();
  end.setDate(end.getDate() + 14);
  const endDate = end.toISOString().slice(0, 10);

  let events;
  try {
    events = getUpcomingEvents(db, {
      startDate: today,
      endDate,
      limit: 7,
    });
  } catch {
    // Calendar table may not exist yet (pre-migration) — show guidance
    return (
      <div className="rounded-lg border border-dashed border-edge bg-panel p-4">
        <h3 className="text-sm font-medium text-ink mb-1">Upcoming Events</h3>
        <p className="text-sm text-ink-faint">
          <Link href="/dashboard/calendar" className="text-gold hover:underline">
            Sync the calendar
          </Link>{" "}
          to see upcoming earnings and macro events.
        </p>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-edge bg-panel p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-ink">Upcoming Events</h3>
          <Link
            href="/dashboard/calendar"
            className="text-xs text-gold hover:text-gold/80 transition-colors"
          >
            Calendar &rarr;
          </Link>
        </div>
        <p className="text-sm text-ink-faint">
          No upcoming events.{" "}
          <Link
            href="/dashboard/calendar"
            className="text-gold hover:underline"
          >
            Sync calendar
          </Link>{" "}
          to pull earnings and macro events.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-edge bg-panel p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-ink">Upcoming Events</h3>
        <Link
          href="/dashboard/calendar"
          className="text-xs text-gold hover:text-gold/80 transition-colors"
        >
          View All &rarr;
        </Link>
      </div>
      <div className="divide-y divide-edge">
        {events.map((event) => {
          const icon = EVENT_ICONS[event.event_type] ?? "📌";
          return (
            <div key={event.id} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
              <span className="text-sm flex-shrink-0">{icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-ink-faint">
                    {formatCompactDate(event.event_date)}
                  </span>
                  {event.symbol && event.security_id != null ? (
                    <SymbolLink
                      securityId={event.security_id}
                      symbol={event.symbol}
                      className="text-xs font-mono font-medium text-gold"
                    />
                  ) : event.symbol ? (
                    <span className="text-xs font-mono font-medium text-gold">
                      {event.symbol}
                    </span>
                  ) : null}
                  {event.expected_impact && (
                    <span
                      className={`text-[11px] font-semibold uppercase tracking-wide ${IMPACT_COLORS[event.expected_impact] ?? "text-ink-faint"}`}
                    >
                      {event.expected_impact.toUpperCase()}
                    </span>
                  )}
                </div>
                <p className="text-sm text-ink truncate">{event.title}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatCompactDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (dateStr === today.toISOString().slice(0, 10)) return "Today";
  if (dateStr === tomorrow.toISOString().slice(0, 10)) return "Tomorrow";

  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
