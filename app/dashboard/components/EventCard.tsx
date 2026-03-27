"use client";

import { useState } from "react";
import type { CalendarEvent, EventImpact } from "@/lib/types";

// ── Event type styling ───────────────────────────────────────────

const EVENT_TYPE_CONFIG: Record<
  string,
  { icon: string; color: string; bgColor: string }
> = {
  earnings: { icon: "📊", color: "text-gold", bgColor: "bg-gold/10" },
  analyst_meeting: { icon: "🎤", color: "text-gold", bgColor: "bg-gold/10" },
  conference: { icon: "🏛", color: "text-gold", bgColor: "bg-gold/10" },
  split: { icon: "✂️", color: "text-blue", bgColor: "bg-blue/10" },
  fomc: { icon: "🏦", color: "text-down", bgColor: "bg-down/10" },
  cpi: { icon: "📈", color: "text-down", bgColor: "bg-down/10" },
  jobs: { icon: "👷", color: "text-down", bgColor: "bg-down/10" },
  gdp: { icon: "🌐", color: "text-down", bgColor: "bg-down/10" },
  pmi: { icon: "🏭", color: "text-amber-400", bgColor: "bg-amber-400/10" },
  retail_sales: {
    icon: "🛒",
    color: "text-amber-400",
    bgColor: "bg-amber-400/10",
  },
  housing: {
    icon: "🏠",
    color: "text-amber-400",
    bgColor: "bg-amber-400/10",
  },
  other_macro: {
    icon: "📅",
    color: "text-amber-400",
    bgColor: "bg-amber-400/10",
  },
  other: { icon: "📌", color: "text-ink-dim", bgColor: "bg-muted" },
};

const IMPACT_BADGE: Record<EventImpact, { label: string; className: string }> =
  {
    high: { label: "High Impact", className: "bg-down/20 text-down" },
    medium: { label: "Medium", className: "bg-amber-400/20 text-amber-400" },
    low: { label: "Low", className: "bg-muted text-ink-faint" },
  };

// ── Component ────────────────────────────────────────────────────

interface EventCardProps {
  event: CalendarEvent;
  compact?: boolean;
}

export function EventCard({ event, compact = false }: EventCardProps) {
  const [expanded, setExpanded] = useState(false);
  const config = EVENT_TYPE_CONFIG[event.event_type] ?? EVENT_TYPE_CONFIG.other;

  if (compact) {
    return (
      <div className="flex items-center gap-2 py-1.5">
        <span className="text-sm flex-shrink-0">{config.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-ink-faint">
              {formatShortDate(event.event_date)}
            </span>
            {event.symbol && (
              <span className="text-xs font-mono font-medium text-gold">
                {event.symbol}
              </span>
            )}
          </div>
          <p className="text-sm text-ink truncate">{event.title}</p>
        </div>
        {event.expected_impact && (
          <ImpactBadge impact={event.expected_impact} />
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className={`w-full text-left rounded-lg border border-edge p-3.5 ${config.bgColor} transition-colors hover:border-edge-strong cursor-pointer`}
    >
      <div className="flex items-start gap-2.5">
        <span className="text-lg mt-0.5 flex-shrink-0">{config.icon}</span>
        <div className="min-w-0 flex-1">
          {/* Header row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-ink-faint">
              {formatTime(event)}
            </span>
            {event.symbol && (
              <span className="text-xs font-mono font-semibold text-gold">
                {event.symbol}
              </span>
            )}
            {event.expected_impact && (
              <ImpactBadge impact={event.expected_impact} />
            )}
          </div>

          {/* Title */}
          <p className={`text-sm font-medium mt-1 ${config.color}`}>
            {event.title}
          </p>

          {/* Description — always visible, no truncation */}
          {event.description && (
            <p className="text-xs text-ink-dim mt-1.5 leading-relaxed">
              {event.description}
            </p>
          )}

          {/* Estimates row */}
          {(event.consensus_estimate || event.previous_value) && (
            <div className="flex gap-4 mt-2 text-xs font-mono">
              {event.consensus_estimate && (
                <span className="text-ink-dim">
                  Est:{" "}
                  <span className="text-ink font-medium">
                    {event.consensus_estimate}
                  </span>
                </span>
              )}
              {event.previous_value && (
                <span className="text-ink-dim">
                  Prev:{" "}
                  <span className="text-ink font-medium">
                    {event.previous_value}
                  </span>
                </span>
              )}
            </div>
          )}

          {/* Expanded details */}
          {expanded && (
            <div className="mt-3 pt-3 border-t border-edge/50 space-y-2">
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                <Detail label="Type" value={formatEventType(event.event_type)} />
                <Detail label="Source" value={event.source === "wsh" ? "TWS / Wall Street Horizon" : "Claude Research"} />
                {event.event_time && (
                  <Detail label="Time" value={event.event_time.includes(":") ? `${event.event_time} ET` : event.event_time} />
                )}
                {event.symbol && (
                  <Detail label="Symbol" value={event.symbol} />
                )}
              </div>
              <p className="text-[10px] text-ink-faint mt-1">
                Click to collapse
              </p>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

// ── Sub-components ───────────────────────────────────────────────

function ImpactBadge({ impact }: { impact: EventImpact }) {
  const cfg = IMPACT_BADGE[impact];
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-ink-faint">{label}: </span>
      <span className="text-ink">{value}</span>
    </div>
  );
}

// ── Formatters ───────────────────────────────────────────────────

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatTime(event: CalendarEvent): string {
  const d = new Date(event.event_date + "T00:00:00");
  const dayStr = d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  if (event.event_time) {
    if (["BMO", "AMC", "TAS"].includes(event.event_time)) {
      return `${dayStr} ${event.event_time}`;
    }
    return `${dayStr} ${event.event_time} ET`;
  }
  return dayStr;
}

function formatEventType(type: string): string {
  const labels: Record<string, string> = {
    earnings: "Earnings",
    analyst_meeting: "Analyst Meeting",
    conference: "Conference",
    split: "Stock Split",
    fomc: "FOMC / Fed",
    cpi: "CPI / Inflation",
    jobs: "Employment",
    gdp: "GDP",
    pmi: "PMI / Manufacturing",
    retail_sales: "Retail Sales",
    housing: "Housing",
    other_macro: "Macro",
    other: "Other",
  };
  return labels[type] ?? type;
}
