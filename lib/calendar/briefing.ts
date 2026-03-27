import Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import type { CalendarEvent } from "@/lib/types";
import { getEventsByWeek } from "@/lib/queries/calendar";
import { saveBriefing } from "@/lib/mutations/calendar";

const BRIEFING_MODEL = "claude-sonnet-4-6";

/**
 * Generate a weekly research briefing for all calendar events in a given week.
 * Uses Claude to research each event and produce a comprehensive markdown document.
 *
 * @param db      Database instance
 * @param weekOf  YYYY-MM-DD (Monday of the week)
 * @param options.onProgress  Callback for progress updates
 * @returns The generated briefing content (markdown)
 */
export async function generateWeeklyBriefing(
  db: Database.Database,
  weekOf: string,
  options?: {
    onProgress?: (msg: string, current?: number, total?: number) => void;
  }
): Promise<{ content: string; eventCount: number }> {
  const events = getEventsByWeek(db, weekOf);

  if (events.length === 0) {
    return {
      content: `# Week of ${formatWeekTitle(weekOf)}\n\nNo events found for this week. Run a calendar sync first.`,
      eventCount: 0,
    };
  }

  options?.onProgress?.("Building event context...", 0, events.length);

  // Get portfolio holdings for context
  const holdings = db
    .prepare(
      `SELECT DISTINCT s.symbol, s.name, s.security_type, s.sector
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE h.quantity > 0
       ORDER BY s.symbol`
    )
    .all() as { symbol: string; name: string | null; security_type: string | null; sector: string | null }[];

  const holdingsList = holdings
    .map((h) => `${h.symbol} (${h.name ?? "unknown"}, ${h.sector ?? "N/A"})`)
    .join("\n");

  // Build the event list for the prompt
  const eventSummary = events
    .map((e, i) => formatEventForPrompt(e, i + 1))
    .join("\n\n");

  options?.onProgress?.("Generating briefing via Claude...", 1, 2);

  const prompt = `You are a financial research analyst preparing a weekly market briefing for a portfolio manager. Generate a comprehensive briefing for the week of ${formatWeekTitle(weekOf)}.

## Portfolio Holdings (for context on which events directly affect the portfolio)
${holdingsList}

## Events This Week
${eventSummary}

## Instructions

Write a well-structured markdown briefing document that covers:

1. **Week Overview** (2-3 sentences) — What's the big picture for this week? What are the highest-impact events?

2. **Key Events** — For each significant event (skip low-impact ones unless they affect portfolio holdings):
   - What it is and when it happens
   - Market consensus expectations (if available)
   - What to watch for — what outcome is "priced in" vs. what would surprise
   - How it could affect the portfolio specifically (reference holdings where relevant)
   - Historical context: how markets have reacted to recent readings

3. **Portfolio Implications** — A summary section tying it all together:
   - Which holdings have the most event-driven risk this week
   - Key levels or thresholds to watch
   - Suggested positioning considerations (stay the course, reduce exposure, etc.)

Format as clean markdown with headers (##), bold for key figures, and bullet points for readability. Keep the total length under 2000 words — concise but substantive.`;

  const client = new Anthropic();

  const response = await client.messages.create({
    model: BRIEFING_MODEL,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const content = textBlock && textBlock.type === "text" ? textBlock.text : "Failed to generate briefing.";

  // Save to database
  const title = `Week of ${formatWeekTitle(weekOf)}`;
  saveBriefing(db, {
    weekOf,
    title,
    content,
    eventCount: events.length,
    model: BRIEFING_MODEL,
  });

  options?.onProgress?.("Briefing complete", 2, 2);

  return { content, eventCount: events.length };
}

// ── Helpers ──────────────────────────────────────────────────────

function formatWeekTitle(weekOf: string): string {
  const d = new Date(weekOf + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatEventForPrompt(event: CalendarEvent, index: number): string {
  const parts = [`${index}. **${event.title}**`];
  parts.push(`   - Date: ${event.event_date}${event.event_time ? ` at ${event.event_time} ET` : ""}`);
  parts.push(`   - Type: ${event.event_type}`);

  if (event.symbol) {
    parts.push(`   - Company: ${event.symbol}`);
  }
  if (event.expected_impact) {
    parts.push(`   - Expected Impact: ${event.expected_impact}`);
  }
  if (event.consensus_estimate) {
    parts.push(`   - Consensus: ${event.consensus_estimate}`);
  }
  if (event.previous_value) {
    parts.push(`   - Previous: ${event.previous_value}`);
  }
  if (event.description) {
    parts.push(`   - ${event.description}`);
  }

  return parts.join("\n");
}
