import { db } from "@/lib/db";
import { getUpcomingEvents } from "@/lib/queries/calendar";
import { getLatestBriefing } from "@/lib/queries/calendar";
import Link from "next/link";
import { SymbolLink } from "@/app/dashboard/components/SymbolLink";

// ── Event icons (shared with UpcomingEventsCard) ──

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

const IMPACT_STYLES: Record<string, string> = {
  high: "bg-down/10 text-down",
  medium: "bg-amber-400/10 text-amber-400",
  low: "bg-ink-faint/10 text-ink-faint",
};

// ── Market session logic (US Eastern) ──

type MarketSession = "pre-market" | "open" | "after-hours" | "closed" | "weekend";

function getMarketSession(): { session: MarketSession; label: string; color: string } {
  // Convert to Eastern time
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const day = et.getDay(); // 0=Sun, 6=Sat
  const hours = et.getHours();
  const minutes = et.getMinutes();
  const time = hours * 60 + minutes;

  if (day === 0 || day === 6) {
    return { session: "weekend", label: "Markets Closed", color: "text-ink-faint" };
  }
  if (time < 4 * 60) {
    return { session: "closed", label: "Markets Closed", color: "text-ink-faint" };
  }
  if (time < 9 * 60 + 30) {
    return { session: "pre-market", label: "Pre-Market", color: "text-amber-400" };
  }
  if (time < 16 * 60) {
    return { session: "open", label: "Market Open", color: "text-up" };
  }
  if (time < 20 * 60) {
    return { session: "after-hours", label: "After Hours", color: "text-amber-400" };
  }
  return { session: "closed", label: "Markets Closed", color: "text-ink-faint" };
}

// ── Briefing summary extractor ──

function extractBriefingSummary(content: string, maxLen = 200): string {
  // Try to find the first substantive paragraph (skip headers)
  const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
  const summary = lines.slice(0, 3).join(" ").replace(/\*\*/g, "").replace(/\*/g, "").trim();
  if (summary.length <= maxLen) return summary;
  return summary.slice(0, maxLen).replace(/\s+\S*$/, "") + "...";
}

// ── Main component ──

export function MorningBriefing() {
  const today = new Date().toISOString().slice(0, 10);
  const market = getMarketSession();

  // Today's events
  let todayEvents;
  try {
    todayEvents = getUpcomingEvents(db, {
      startDate: today,
      endDate: today,
      limit: 6,
    });
  } catch {
    todayEvents = [];
  }

  // Latest briefing
  let briefing;
  try {
    briefing = getLatestBriefing(db);
  } catch {
    briefing = null;
  }

  // Format date
  const dateObj = new Date(today + "T12:00:00");
  const dayName = dateObj.toLocaleDateString("en-US", { weekday: "long" });
  const monthDay = dateObj.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  // Market session indicator dot
  const dotColor =
    market.session === "open" ? "bg-up" :
    market.session === "pre-market" || market.session === "after-hours" ? "bg-amber-400" :
    "bg-ink-faint";

  return (
    <div className="rounded-xl border border-edge bg-panel overflow-hidden">
      {/* Header bar */}
      <div className="px-5 py-3 border-b border-edge flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-ink">{dayName}</h3>
          <p className="text-xs text-ink-faint">{monthDay}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${dotColor} ${market.session === "open" ? "animate-pulse" : ""}`} />
          <span className={`text-xs font-medium ${market.color}`}>
            {market.label}
          </span>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {/* Today's events */}
        {todayEvents.length > 0 ? (
          <div>
            <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wider mb-2">
              Today&rsquo;s Events
            </h4>
            <div className="space-y-1.5">
              {todayEvents.map((event) => {
                const icon = EVENT_ICONS[event.event_type] ?? "📌";
                return (
                  <div key={event.id} className="flex items-center gap-2">
                    <span className="text-sm flex-shrink-0">{icon}</span>
                    <span className="text-sm text-ink truncate flex-1">{event.title}</span>
                    {event.symbol && event.security_id != null ? (
                      <SymbolLink
                        securityId={event.security_id}
                        symbol={event.symbol}
                        className="text-xs font-mono font-medium text-gold flex-shrink-0"
                      />
                    ) : event.symbol ? (
                      <span className="text-xs font-mono font-medium text-gold flex-shrink-0">
                        {event.symbol}
                      </span>
                    ) : null}
                    {event.expected_impact && (
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0 ${IMPACT_STYLES[event.expected_impact] ?? ""}`}>
                        {event.expected_impact.toUpperCase()}
                      </span>
                    )}
                    {event.event_time && (
                      <span className="text-xs font-mono text-ink-faint flex-shrink-0">
                        {event.event_time}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-faint">No events scheduled today.</p>
        )}

        {/* Briefing snippet */}
        {briefing && (
          <div className="border-t border-edge/50 pt-3">
            <div className="flex items-center justify-between mb-1.5">
              <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wider">
                Weekly Brief
              </h4>
              <span className="text-[10px] text-ink-faint font-mono">
                w/o {briefing.week_of}
              </span>
            </div>
            <p className="text-sm text-ink-dim leading-relaxed">
              {extractBriefingSummary(briefing.content)}
            </p>
            <Link
              href="/dashboard/calendar"
              className="text-xs text-gold hover:text-gold/80 transition-colors mt-1.5 inline-block"
            >
              Read full briefing &rarr;
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
