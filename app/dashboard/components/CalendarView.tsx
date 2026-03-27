"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { CalendarEvent, CalendarBriefing, EventImpact } from "@/lib/types";

// ── Event type styling ───────────────────────────────────────────

const EVENT_COLORS: Record<string, { border: string; bg: string; badge: string }> = {
  earnings:        { border: "border-l-gold",       bg: "bg-gold/8",       badge: "text-gold" },
  analyst_meeting: { border: "border-l-gold",       bg: "bg-gold/8",       badge: "text-gold" },
  conference:      { border: "border-l-gold",       bg: "bg-gold/8",       badge: "text-gold" },
  split:           { border: "border-l-blue",       bg: "bg-blue/8",       badge: "text-blue" },
  fomc:            { border: "border-l-down",       bg: "bg-down/8",       badge: "text-down" },
  cpi:             { border: "border-l-down",       bg: "bg-down/8",       badge: "text-down" },
  jobs:            { border: "border-l-down",       bg: "bg-down/8",       badge: "text-down" },
  gdp:             { border: "border-l-down",       bg: "bg-down/8",       badge: "text-down" },
  pmi:             { border: "border-l-amber-400",  bg: "bg-amber-400/8",  badge: "text-amber-400" },
  retail_sales:    { border: "border-l-amber-400",  bg: "bg-amber-400/8",  badge: "text-amber-400" },
  housing:         { border: "border-l-amber-400",  bg: "bg-amber-400/8",  badge: "text-amber-400" },
  other_macro:     { border: "border-l-amber-400",  bg: "bg-amber-400/8",  badge: "text-amber-400" },
  other:           { border: "border-l-ink-faint",  bg: "bg-muted",        badge: "text-ink-faint" },
};

const EVENT_ICONS: Record<string, string> = {
  earnings: "📊", analyst_meeting: "🎤", conference: "🏛", split: "✂️",
  fomc: "🏦", cpi: "📈", jobs: "👷", gdp: "🌐", pmi: "🏭",
  retail_sales: "🛒", housing: "🏠", other_macro: "📅", other: "📌",
};

const IMPACT_STYLES: Record<EventImpact, string> = {
  high:   "bg-down/20 text-down",
  medium: "bg-amber-400/20 text-amber-400",
  low:    "bg-muted text-ink-faint",
};

// ── Props ────────────────────────────────────────────────────────

interface CalendarViewProps {
  initialEvents: CalendarEvent[];
  initialBriefing: CalendarBriefing | null;
  initialWeekOf: string;
}

// ── Component ────────────────────────────────────────────────────

export function CalendarView({
  initialEvents,
  initialBriefing,
  initialWeekOf,
}: CalendarViewProps) {
  const router = useRouter();
  const [events, setEvents] = useState(initialEvents);
  const [briefing, setBriefing] = useState(initialBriefing);
  const [weekOf, setWeekOf] = useState(initialWeekOf);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [generatingBriefing, setGeneratingBriefing] = useState(false);
  const [briefingMessage, setBriefingMessage] = useState<string | null>(null);
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null);

  // ── Week navigation ──────────────────────────────────────────
  const navigateWeek = useCallback(
    (direction: -1 | 0 | 1) => {
      let newWeekOf: string;
      if (direction === 0) {
        newWeekOf = getCurrentMonday();
      } else {
        newWeekOf = addDays(weekOf, direction * 7);
      }
      setWeekOf(newWeekOf);
      setExpandedEvent(null);
      router.push(`/dashboard/calendar?weekOf=${newWeekOf}`);
    },
    [weekOf, router]
  );

  // ── Sync calendar ────────────────────────────────────────────
  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncMessage("Starting sync...");
    try {
      const res = await fetch("/api/calendar/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekOf }),
      });
      if (!res.ok) { setSyncMessage("Sync failed: " + res.statusText); setSyncing(false); return; }

      await readSseStream(res, (data) => {
        if (data.progress) setSyncMessage(data.progress.message);
        if (data.complete) {
          const d = data.data;
          setSyncMessage(`Synced ${d.totalSaved} events (${d.wshEvents} company, ${d.macroEvents} macro)`);
        }
        if (data.error) setSyncMessage(`Error: ${data.error}`);
      });

      const eventsRes = await fetch(`/api/calendar/events?weekOf=${weekOf}`);
      if (eventsRes.ok) { const json = await eventsRes.json(); setEvents(json.events); }
    } catch (err) {
      setSyncMessage(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally { setSyncing(false); }
  }, [weekOf]);

  // ── Generate briefing ────────────────────────────────────────
  const handleGenerateBriefing = useCallback(async () => {
    setGeneratingBriefing(true);
    setBriefingMessage("Generating briefing...");
    try {
      const res = await fetch("/api/calendar/briefing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weekOf }),
      });
      if (!res.ok) { setBriefingMessage("Failed: " + res.statusText); setGeneratingBriefing(false); return; }

      await readSseStream(res, (data) => {
        if (data.progress) setBriefingMessage(data.progress.message);
        if (data.complete) setBriefingMessage(null);
        if (data.error) setBriefingMessage(`Error: ${data.error}`);
      });

      const briefRes = await fetch(`/api/calendar/briefing?weekOf=${weekOf}`);
      if (briefRes.ok) {
        const json = await briefRes.json();
        if (json.briefing) setBriefing(json.briefing);
      }
    } catch (err) {
      setBriefingMessage(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally { setGeneratingBriefing(false); }
  }, [weekOf]);

  // ── Group events by day ──────────────────────────────────────
  const dayGroups = groupEventsByDay(events, weekOf);
  const daysWithEvents = dayGroups.filter((d) => d.events.length > 0);

  return (
    <div className="space-y-4">
      {/* ── Header: Navigation + Actions ───────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <button onClick={() => navigateWeek(-1)}
            className="px-2.5 py-1.5 text-sm text-ink-dim hover:text-ink border border-edge rounded-md hover:border-edge-strong transition-colors">
            &larr;
          </button>
          <button onClick={() => navigateWeek(0)}
            className="px-3 py-1.5 text-sm text-ink-dim hover:text-ink border border-edge rounded-md hover:border-edge-strong transition-colors">
            This Week
          </button>
          <button onClick={() => navigateWeek(1)}
            className="px-2.5 py-1.5 text-sm text-ink-dim hover:text-ink border border-edge rounded-md hover:border-edge-strong transition-colors">
            &rarr;
          </button>
          <span className="text-sm font-medium text-ink ml-3">
            {formatWeekRange(weekOf)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={handleSync} disabled={syncing}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-gold/10 text-gold border border-gold/30 hover:bg-gold/20 disabled:opacity-50 transition-colors">
            {syncing ? "Syncing..." : "Sync Calendar"}
          </button>
          <button onClick={handleGenerateBriefing} disabled={generatingBriefing || events.length === 0}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue/10 text-blue border border-blue/30 hover:bg-blue/20 disabled:opacity-50 transition-colors">
            {generatingBriefing ? "Generating..." : "Generate Briefing"}
          </button>
        </div>
      </div>

      {/* ── Status ─────────────────────────────────────────── */}
      {(syncMessage || briefingMessage) && (
        <div className="text-xs font-mono text-ink-faint px-3 py-2 bg-panel rounded-md border border-edge">
          {syncMessage && <div>{syncMessage}</div>}
          {briefingMessage && <div>{briefingMessage}</div>}
        </div>
      )}

      {/* ── Main content: Agenda + Briefing ────────────────── */}
      {events.length === 0 ? (
        <div className="text-center py-16 text-ink-faint">
          <p className="text-lg mb-2">No events for this week</p>
          <p className="text-sm">Click &quot;Sync Calendar&quot; to pull earnings and macro events.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Left: Agenda List ─────────────────────────── */}
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-ink-faint mb-3 pb-2 border-b border-edge">
              Events &middot; {events.length} total
            </div>
            <div className="space-y-5">
              {daysWithEvents.map((day) => (
                <div key={day.date}>
                  {/* Day header */}
                  <div className={`text-xs font-mono mb-2 ${
                    day.isToday ? "text-gold font-semibold" : "text-ink-faint"
                  }`}>
                    {day.label}
                    {day.isToday && (
                      <span className="ml-2 text-[10px] bg-gold/20 text-gold px-1.5 py-0.5 rounded">
                        Today
                      </span>
                    )}
                  </div>

                  {/* Event rows */}
                  <div className="space-y-1.5">
                    {day.events.map((event) => {
                      const colors = EVENT_COLORS[event.event_type] ?? EVENT_COLORS.other;
                      const icon = EVENT_ICONS[event.event_type] ?? "📌";
                      const isExpanded = expandedEvent === event.id;

                      return (
                        <button
                          key={event.id}
                          type="button"
                          onClick={() => setExpandedEvent(isExpanded ? null : event.id)}
                          className={`w-full text-left border-l-2 ${colors.border} ${colors.bg} rounded-r-lg px-3 py-2.5 hover:brightness-125 transition-all cursor-pointer`}
                        >
                          {/* Top row: title + badges */}
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm text-ink font-medium">
                              {icon} {event.title}
                            </span>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {event.symbol && (
                                <span className="text-xs font-mono font-semibold text-gold">
                                  {event.symbol}
                                </span>
                              )}
                              {event.expected_impact && (
                                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${IMPACT_STYLES[event.expected_impact]}`}>
                                  {event.expected_impact.toUpperCase()}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Detail row: time + estimates */}
                          <div className="flex items-center gap-3 mt-1 text-xs font-mono text-ink-faint">
                            {event.event_time && (
                              <span>{formatEventTime(event.event_time)}</span>
                            )}
                            {event.consensus_estimate && (
                              <span>Est: <span className="text-ink-dim">{event.consensus_estimate}</span></span>
                            )}
                            {event.previous_value && (
                              <span>Prev: <span className="text-ink-dim">{event.previous_value}</span></span>
                            )}
                          </div>

                          {/* Expanded: full details */}
                          {isExpanded && (
                            <div className="mt-2.5 pt-2.5 border-t border-edge/30 space-y-2.5">
                              {/* Description */}
                              {event.description && (
                                <p className="text-xs text-ink-dim leading-relaxed">
                                  {event.description}
                                </p>
                              )}

                              {/* Estimates — prominent when available */}
                              {(event.consensus_estimate || event.previous_value) && (
                                <div className="grid grid-cols-2 gap-2">
                                  {event.consensus_estimate && (
                                    <div className="bg-canvas/50 rounded px-2.5 py-2 border border-edge/30">
                                      <div className="text-[10px] text-ink-faint uppercase tracking-wider">Consensus Est.</div>
                                      <div className="text-sm font-mono font-semibold text-ink mt-0.5">{event.consensus_estimate}</div>
                                    </div>
                                  )}
                                  {event.previous_value && (
                                    <div className="bg-canvas/50 rounded px-2.5 py-2 border border-edge/30">
                                      <div className="text-[10px] text-ink-faint uppercase tracking-wider">Previous</div>
                                      <div className="text-sm font-mono font-semibold text-ink mt-0.5">{event.previous_value}</div>
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Metadata row */}
                              <div className="flex items-center gap-3 text-[10px] text-ink-faint">
                                <span>Type: {formatEventType(event.event_type)}</span>
                                <span>&middot;</span>
                                <span>Source: {event.source === "wsh" ? "TWS / Wall Street Horizon" : "FRED + Claude"}</span>
                                {event.event_time && (
                                  <>
                                    <span>&middot;</span>
                                    <span>Release: {formatEventTime(event.event_time)}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Right: Briefing Panel ────────────────────── */}
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-ink-faint mb-3 pb-2 border-b border-edge">
              Weekly Briefing
            </div>
            {briefing ? (
              <div className="border border-edge rounded-lg bg-panel overflow-hidden">
                <div className="px-4 py-3 border-b border-edge bg-raised/50 flex items-center justify-between">
                  <span className="text-sm font-medium text-ink">
                    {briefing.title}
                  </span>
                  <span className="text-xs text-ink-faint font-mono">
                    {briefing.event_count} events
                  </span>
                </div>
                <div className="px-4 py-4 max-h-[calc(100vh-280px)] overflow-y-auto">
                  <BriefingContent content={briefing.content} />
                  <div className="mt-4 pt-3 border-t border-edge text-[10px] text-ink-faint font-mono">
                    Generated {new Date(briefing.generated_at).toLocaleString()} via {briefing.model}
                  </div>
                </div>
              </div>
            ) : (
              <div className="border border-dashed border-edge rounded-lg p-8 text-center">
                <p className="text-sm text-ink-faint mb-2">
                  No briefing for this week
                </p>
                <p className="text-xs text-ink-faint/70 max-w-xs mx-auto">
                  Click &quot;Generate Briefing&quot; to create an AI research summary covering all events and their impact on your portfolio.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Briefing markdown renderer ───────────────────────────────────

function BriefingContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let key = 0;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      elements.push(
        <h2 key={key++} className="text-sm font-semibold text-ink mt-5 mb-2">{renderInline(line.slice(3))}</h2>
      );
    } else if (line.startsWith("### ")) {
      elements.push(
        <h3 key={key++} className="text-sm font-semibold text-ink mt-3 mb-1">{renderInline(line.slice(4))}</h3>
      );
    } else if (line.startsWith("# ")) {
      elements.push(
        <h1 key={key++} className="text-base font-bold text-ink mt-4 mb-2">{renderInline(line.slice(2))}</h1>
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        <li key={key++} className="ml-4 list-disc text-sm text-ink-dim leading-relaxed">{renderInline(line.slice(2))}</li>
      );
    } else if (line.trim() === "") {
      elements.push(<div key={key++} className="h-1.5" />);
    } else {
      elements.push(
        <p key={key++} className="text-sm text-ink-dim leading-relaxed">{renderInline(line)}</p>
      );
    }
  }

  return <>{elements}</>;
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="text-ink font-semibold">{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

// ── SSE stream reader ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readSseStream(res: Response, onData: (data: any) => void) {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") return;
      try { onData(JSON.parse(payload)); } catch { /* skip */ }
    }
  }
}

// ── Day grouping ─────────────────────────────────────────────────

interface DayGroup { date: string; label: string; isToday: boolean; events: CalendarEvent[]; }

function groupEventsByDay(events: CalendarEvent[], weekOf: string): DayGroup[] {
  const today = new Date().toISOString().slice(0, 10);
  const days: DayGroup[] = [];
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri"];

  for (let i = 0; i < 5; i++) {
    const date = addDays(weekOf, i);
    const d = new Date(date + "T00:00:00");
    const label = `${dayNames[i]} ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    days.push({ date, label, isToday: date === today, events: events.filter((e) => e.event_date === date) });
  }

  // Weekend events (rare, but handle gracefully)
  const weekendEvents = events.filter((e) => {
    const sat = addDays(weekOf, 5);
    const sun = addDays(weekOf, 6);
    return e.event_date === sat || e.event_date === sun;
  });
  if (weekendEvents.length > 0) {
    days.push({ date: addDays(weekOf, 5), label: "Weekend", isToday: false, events: weekendEvents });
  }

  return days;
}

// ── Formatters ───────────────────────────────────────────────────

function formatEventType(type: string): string {
  const labels: Record<string, string> = {
    earnings: "Earnings", analyst_meeting: "Analyst Meeting", conference: "Conference",
    split: "Stock Split", fomc: "FOMC / Fed", cpi: "Inflation", jobs: "Employment",
    gdp: "GDP", pmi: "PMI / Manufacturing", retail_sales: "Retail Sales",
    housing: "Housing", other_macro: "Macro", other: "Other",
  };
  return labels[type] ?? type;
}

function formatEventTime(time: string): string {
  if (["BMO", "AMC", "TAS"].includes(time)) return time;
  if (time.includes(":")) return `${time} ET`;
  return time;
}

function getCurrentMonday(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  return monday.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatWeekRange(weekOf: string): string {
  const start = new Date(weekOf + "T00:00:00");
  const end = new Date(weekOf + "T00:00:00");
  end.setDate(end.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const yr = start.getFullYear();
  return `${fmt(start)} – ${fmt(end)}, ${yr}`;
}
