import type Database from "better-sqlite3";
import { generateText } from "ai";
import type { CalendarEvent } from "@/lib/types";
import { getEventsByWeek } from "@/lib/queries/calendar";
import { saveBriefing } from "@/lib/mutations/calendar";
import { fetchVitalKnowledge } from "@/lib/vital-knowledge";
import {
  getFullTextForSources,
  getRecentArticles,
} from "@/lib/queries/research";
import {
  getLevelsTriggeredInWindow,
  getLevelsNearPrice,
  type LevelTriggeredThisWeek,
  type LevelNearPrice,
} from "@/lib/queries/briefing-levels";
import { getModelForFeature } from "@/lib/ai/provider";
import { FEATURE_MODELS } from "@/lib/ai/models";

// Preferred weekend-reading sources — full raw_text is sent to the model.
// ids correspond to research_sources.id. Keep aligned with DB; wrong ids
// will just yield empty deep-read context (no crash).
const PREFERRED_SOURCE_IDS = [
  1,  // Vital Knowledge
  18, // Eliant Capital
  19, // Purple Drink's Market Musings
  28, // Helene Meisler
];

// Deep-read window. Weekend newsletters land Fri/Sat/Sun — 72h covers them
// without pulling mid-week back-catalog.
const DEEP_READ_HOURS = 72;

// Hard caps to keep input cost predictable.
const MAX_CHARS_PER_ARTICLE = 30_000;   // truncate extremely long pieces
const MAX_TOTAL_DEEP_CHARS = 200_000;   // ~50k tokens input ceiling for deep section
const BROADER_ARTICLE_LIMIT = 15;       // summary-level articles from other sources

/**
 * Generate a weekly research briefing for all calendar events in a given week.
 * Uses Opus to synthesize full weekend newsletter text, portfolio context,
 * macro/earnings events, and expiring option positions.
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

  options?.onProgress?.("Building portfolio + events context...", 0, 4);

  // ── Portfolio holdings (cross-account) ─────────────────────────
  const holdings = db
    .prepare(
      `SELECT DISTINCT s.symbol, s.name, s.security_type, s.sector
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE h.quantity > 0
         AND h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id)
       ORDER BY s.symbol`
    )
    .all() as {
      symbol: string;
      name: string | null;
      security_type: string | null;
      sector: string | null;
    }[];

  const holdingsList = holdings
    .map((h) => `${h.symbol} (${h.name ?? "unknown"}, ${h.sector ?? "N/A"})`)
    .join("\n");

  // ── Event partitioning: portfolio earnings (Finnhub) vs macro ──
  const weekStart = weekOf;
  const weekEnd = addDays(weekOf, 6);
  const portfolioEarnings = events.filter(
    (e) => e.source === "finnhub" && e.event_type === "earnings"
  );
  const wshEarnings = events.filter(
    (e) => e.source === "wsh" && e.event_type === "earnings"
  );
  const otherEvents = events.filter(
    (e) => e.source !== "finnhub" && !(e.source === "wsh" && e.event_type === "earnings")
  );

  // ── Expiring options ─────────────────────────────────────────────
  const expiringOptions = getExpiringOptions(db, weekStart, weekEnd);

  // ── Price levels: triggered this past week + approaching ─────────
  const levelsTriggered = getLevelsTriggeredInWindow(db, 7);
  const levelsNearby = getLevelsNearPrice(db, 0.05);

  options?.onProgress?.("Loading weekend deep reads...", 1, 4);

  // ── Weekend deep-read context (full raw_text of 4 preferred sources) ──
  const deepArticles = getFullTextForSources(db, PREFERRED_SOURCE_IDS, DEEP_READ_HOURS);
  const deepContext = buildDeepReadSection(deepArticles);

  options?.onProgress?.("Loading broader market signals...", 2, 4);

  // ── Broader market signals (summary level for other sources) ────
  const allRecent = getRecentArticles(db, { processedOnly: true, limit: 40 });
  const otherSourceSummaries = allRecent
    .filter((a) => !PREFERRED_SOURCE_IDS.includes(a.source_id))
    .slice(0, BROADER_ARTICLE_LIMIT);

  const breadthContext = otherSourceSummaries
    .map(
      (a) =>
        `[${a.received_at.slice(0, 10)}] ${a.source_name}: ${a.subject}\n${a.summary || ""}`
    )
    .join("\n\n---\n\n");

  // ── Optional: Vital Knowledge IMAP fallback if DB has no VK rows ─
  let imapFallback = "";
  const vkInDeep = deepArticles.some((a) => a.source_id === 1);
  if (!vkInDeep) {
    const gmailAddress = process.env.GMAIL_ADDRESS;
    const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
    if (gmailAddress && gmailAppPassword) {
      imapFallback = await fetchVitalKnowledge(gmailAddress, gmailAppPassword, 7);
    }
  }

  options?.onProgress?.("Generating briefing via Opus...", 3, 4);

  // ── Released last week — enriched events from the prior 7 days ──
  const priorWeekStart = addDays(weekOf, -7);
  const priorWeekEnd = addDays(weekOf, -1);
  const releasedLastWeek = db
    .prepare(
      `SELECT * FROM calendar_events
       WHERE enriched_at IS NOT NULL
         AND event_date BETWEEN ? AND ?
         AND actual_value IS NOT NULL
       ORDER BY event_date ASC, release_time ASC`,
    )
    .all(priorWeekStart, priorWeekEnd) as CalendarEvent[];

  const prompt = buildPrompt({
    weekOf,
    holdingsList,
    portfolioEarnings,
    wshEarnings,
    otherEvents,
    expiringOptions,
    levelsTriggered,
    levelsNearby,
    deepContext,
    breadthContext,
    imapFallback,
    releasedLastWeek,
  });

  const { text } = await generateText({
    model: getModelForFeature("briefing"),
    maxOutputTokens: 8192,
    prompt,
  });

  const content = text.trim() || "Failed to generate briefing.";

  const title = `Week of ${formatWeekTitle(weekOf)}`;
  saveBriefing(db, {
    weekOf,
    title,
    content,
    eventCount: events.length,
    model: FEATURE_MODELS.briefing,
  });

  options?.onProgress?.("Briefing complete", 4, 4);

  return { content, eventCount: events.length };
}

// ── Prompt assembly ────────────────────────────────────────────────

interface PromptInput {
  weekOf: string;
  holdingsList: string;
  portfolioEarnings: CalendarEvent[];
  wshEarnings: CalendarEvent[];
  otherEvents: CalendarEvent[];
  expiringOptions: ExpiringOption[];
  levelsTriggered: LevelTriggeredThisWeek[];
  levelsNearby: LevelNearPrice[];
  deepContext: string;
  breadthContext: string;
  imapFallback: string;
  releasedLastWeek: CalendarEvent[];
}

function buildPrompt(p: PromptInput): string {
  const weekTitle = formatWeekTitle(p.weekOf);

  const portfolioEarningsSection =
    p.portfolioEarnings.length > 0
      ? `\n## Portfolio Earnings This Week\nThese are earnings from companies the user currently holds (Finnhub, cross-referenced against all accounts). For each: setup going in, Street expectations (EPS/revenue consensus are embedded in the description below), how the company has performed against estimates over the last 4 quarters (also in description), key thing to watch on the call, and position implications given current holdings.\n\n${p.portfolioEarnings
          .map((e, i) => formatEventForPrompt(e, i + 1))
          .join("\n\n")}\n`
      : "";

  const wshSection =
    p.wshEarnings.length > 0
      ? `\n## Other Earnings Announcements This Week (WSH)\n${p.wshEarnings
          .map((e, i) => formatEventForPrompt(e, i + 1))
          .join("\n\n")}\n`
      : "";

  const optionsSection =
    p.expiringOptions.length > 0
      ? `\n## Options Expiring This Week\nThe user has the following open option positions that expire this week. For each, assess: ITM / OTM / ATM vs the stated strike, action the user should consider (let expire worthless, close before expiry, roll, exercise), and — for sold calls/puts — assignment risk. If you don't have a current underlying price, flag that explicitly rather than guessing.\n\n${p.expiringOptions
          .map((o, i) => formatOptionForPrompt(o, i + 1))
          .join("\n")}\n`
      : "";

  const triggeredLevelsSection =
    p.levelsTriggered.length > 0
      ? `\n## Price Levels Hit in the Past Week\nLevels the user set — or that were auto-extracted from newsletters — that the price crossed in the last 7 days. Include whether the user responded (acted / ignored / dismissed) and whether the subsequent price action validated the signal.\n\n${p.levelsTriggered
          .map((l, i) => {
            const who = l.source_author || l.source;
            const thesis = l.thesis ? ` — "${l.thesis}"` : "";
            return `${i + 1}. **${l.symbol}** ${l.level_type.replace("_", " ")} at $${l.level_price.toFixed(2)} hit on ${l.triggered_at.slice(0, 10)} (price: $${l.triggered_price.toFixed(2)}). Source: ${who}${thesis}. User response: ${l.user_response}.`;
          })
          .join("\n")}\n`
      : "";

  const nearbyLevelsSection =
    p.levelsNearby.length > 0
      ? `\n## Active Levels Within 5% of Current Price (likely to be tested this week)\nLevels that have NOT yet triggered but are close enough to be in play this week. If price trends toward these, the user should be prepared.\n\n${p.levelsNearby
          .map((l, i) => {
            const who = l.source_author || l.source;
            const thesis = l.thesis ? ` — "${l.thesis}"` : "";
            const distance = `${(l.distance_pct * 100).toFixed(1)}% ${l.distance_pct >= 0 ? "above" : "below"}`;
            const action = l.action_hint ? ` [action hint: ${l.action_hint.replace("_", " ")}]` : "";
            return `${i + 1}. **${l.symbol}** ${l.level_type.replace("_", " ")} at $${l.level_price.toFixed(2)} — currently $${l.current_price.toFixed(2)} (${distance}). ${who}${thesis}${action}`;
          })
          .join("\n")}\n`
      : "";

  const otherEventsSection =
    p.otherEvents.length > 0
      ? `\n## Macro & Other Events This Week\n${p.otherEvents
          .map((e, i) => formatEventForPrompt(e, i + 1))
          .join("\n\n")}\n`
      : "";

  const releasedLastWeekSection =
    p.releasedLastWeek.length > 0
      ? `\n## Released Last Week (actual + market reaction)\nCalendar events that printed in the last 7 days, with the actual value and the 2-hour market reaction captured automatically. Use this for continuity context — e.g., "last Tuesday's CPI came in hot and SPY sold off -0.4%" sets up this week's setup more honestly than consensus-only framing.\n\n${p.releasedLastWeek
          .map((e, i) => formatReleasedEventForPrompt(e, i + 1))
          .join("\n")}\n`
      : "";

  const weekendSection = p.deepContext
    ? `\n## Weekend Reading — Full Newsletter Text\nThese are the complete texts of the user's preferred weekend newsletters. Read each carefully. The user's goal is for your synthesis below to **replace** him reading these himself. Identify where authors agree, where they disagree, the consensus call vs contrarian takes, and any specific securities or sectors they highlight. Cite authors by name when referencing a view.\n\n${p.deepContext}\n`
    : p.imapFallback
      ? `\n## Weekend Market Context (Vital Knowledge — IMAP fallback)\n${p.imapFallback}\n`
      : "";

  const breadthSection = p.breadthContext
    ? `\n## Broader Market Signals (Summary Level — Other Sources)\nPre-summarized by the research-feed pipeline. Use for breadth, not depth.\n\n${p.breadthContext}\n`
    : "";

  return `You are a financial research analyst preparing a weekly market briefing for a single portfolio manager. Generate a comprehensive briefing for the week of ${weekTitle}.

## Portfolio Holdings (for context on which events directly affect the portfolio)
${p.holdingsList}
${portfolioEarningsSection}${wshSection}${optionsSection}${triggeredLevelsSection}${nearbyLevelsSection}${otherEventsSection}${releasedLastWeekSection}${weekendSection}${breadthSection}

## Instructions

Write a markdown briefing structured as follows:

1. **Week Overview** (2–3 sentences) — the big picture. Highest-impact events, the single most important question the week will answer.

2. **Weekend Reading Synthesis** — synthesize the full weekend newsletters into a narrative. Where do the four authors agree? Where do they diverge? What is the week's consensus call? What's the strongest contrarian take? Cite authors by name. This section should feel like reading the best parts of all four at once, not four disconnected summaries.

3. **Portfolio Earnings** — for each held-company earning above, give the setup, expectations vs. consensus (the estimates and last-4-quarter surprise history are in each event's description), what to watch, and position implications. If none reporting, skip this section.

4. **Options Expiring This Week** — for each expiring option, give the assessment (ITM/OTM/ATM if derivable), action to consider, and assignment risk where relevant. If none expire, skip this section.

5. **Price Levels in Play** — ONLY include if the data sections above show triggered or nearby levels. Two subsections:
   - Recent triggers (last 7 days): did the user's response make sense? Did price action validate or invalidate the level?
   - This week's watch list: for each level within 5% of current price, say what a hit would mean and the action to consider. Ground each in the source author's thesis where cited. Skip this whole section if there are no triggered or nearby levels.

6. **Macro & Other Events** — concise coverage of the remaining calendar. What's priced in, what would surprise, which holdings have exposure.

7. **Portfolio Implications** — a tight closing section. Which holdings have the most event-driven risk this week. Key levels or thresholds (tie back to the Price Levels section). Suggested positioning considerations (stay the course, reduce exposure, hedge, etc.).

Format as clean markdown. Use \`##\` for section headers, \`###\` for sub-sections, **bold** for key figures, and bullet points where helpful. Aim for a substantive briefing in the 2,500–3,500 word range — dense with actionable information, not filler.`;
}

// ── Expiring options query ─────────────────────────────────────────

interface ExpiringOption {
  symbol: string;
  underlying_symbol: string | null;
  expiration_date: string;
  option_type: string | null;
  strike_price: number | null;
  quantity: number;
  account_name: string;
}

function getExpiringOptions(
  db: Database.Database,
  startDate: string,
  endDate: string
): ExpiringOption[] {
  return db
    .prepare(
      `SELECT s.symbol, s.underlying_symbol, s.expiration_date,
              s.option_type, s.strike_price,
              h.quantity, a.name AS account_name
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       JOIN accounts a ON a.id = h.account_id
       WHERE LOWER(s.security_type) = 'option'
         AND h.quantity != 0
         AND s.expiration_date BETWEEN ? AND ?
         AND h.as_of_date = (
           SELECT MAX(h2.as_of_date) FROM holdings h2
           WHERE h2.account_id = h.account_id
         )
       ORDER BY s.expiration_date, s.underlying_symbol`
    )
    .all(startDate, endDate) as ExpiringOption[];
}

function formatOptionForPrompt(o: ExpiringOption, index: number): string {
  const side = (o.quantity ?? 0) > 0 ? "LONG" : "SHORT";
  const qty = Math.abs(o.quantity);
  const strike = o.strike_price != null ? `$${o.strike_price}` : "?";
  const type = o.option_type ?? "?";
  return `${index}. **${o.underlying_symbol ?? o.symbol}** ${type} ${strike} exp ${o.expiration_date} — ${side} ${qty} contract${qty === 1 ? "" : "s"} in ${o.account_name}`;
}

// ── Deep-read section builder ──────────────────────────────────────

function buildDeepReadSection(
  articles: {
    source_id: number;
    source_name: string;
    subject: string;
    received_at: string;
    raw_text: string;
  }[]
): string {
  if (articles.length === 0) return "";

  const sections: string[] = [];
  let totalChars = 0;

  for (const a of articles) {
    let body = a.raw_text;
    if (body.length > MAX_CHARS_PER_ARTICLE) {
      body = body.slice(0, MAX_CHARS_PER_ARTICLE) + "\n...[truncated]";
    }
    const header = `### ${a.source_name} — "${a.subject}" (${a.received_at.slice(0, 10)})`;
    const section = `${header}\n${body}`;
    if (totalChars + section.length > MAX_TOTAL_DEEP_CHARS) {
      sections.push(
        `### ...[remaining weekend articles truncated to stay within budget]`
      );
      break;
    }
    sections.push(section);
    totalChars += section.length;
  }

  return sections.join("\n\n---\n\n");
}

// ── Existing helpers ────────────────────────────────────────────────

function formatWeekTitle(weekOf: string): string {
  const d = new Date(weekOf + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatEventForPrompt(event: CalendarEvent, index: number): string {
  const parts = [`${index}. **${event.title}**`];
  parts.push(
    `   - Date: ${event.event_date}${event.event_time ? ` at ${event.event_time} ET` : ""}`
  );
  parts.push(`   - Type: ${event.event_type}`);
  if (event.symbol) parts.push(`   - Company: ${event.symbol}`);
  if (event.expected_impact) parts.push(`   - Expected Impact: ${event.expected_impact}`);
  if (event.consensus_estimate) parts.push(`   - Consensus: ${event.consensus_estimate}`);
  if (event.previous_value) parts.push(`   - Previous: ${event.previous_value}`);
  if (event.description) parts.push(`   - ${event.description}`);
  return parts.join("\n");
}

/**
 * One-liner per released event for the "Released last week" context block.
 *
 * Example:
 *   - **CPI** (Apr 16): actual 3.2% vs est 3.1% · SPY -0.41% / QQQ -0.57% / XLF -0.68%
 */
function formatReleasedEventForPrompt(event: CalendarEvent, index: number): string {
  const parts: string[] = [];
  parts.push(`${index}. **${event.title}**`);
  parts.push(`(${event.event_date})`);

  const values: string[] = [];
  if (event.actual_value) values.push(`actual ${event.actual_value}`);
  if (event.consensus_value && event.consensus_value !== event.actual_value) {
    values.push(`vs est ${event.consensus_value}`);
  }
  if (values.length > 0) parts.push(`— ${values.join(" ")}`);

  if (event.reaction_snapshot) {
    try {
      const snap = JSON.parse(event.reaction_snapshot) as {
        spy?: { delta_pct: number };
        qqq?: { delta_pct: number };
        tlt?: { delta_pct: number };
        sector?: { symbol: string; delta_pct: number };
      };
      const reacts: string[] = [];
      if (snap.spy) reacts.push(`SPY ${fmtSignedPct(snap.spy.delta_pct)}`);
      if (snap.qqq) reacts.push(`QQQ ${fmtSignedPct(snap.qqq.delta_pct)}`);
      if (snap.tlt) reacts.push(`TLT ${fmtSignedPct(snap.tlt.delta_pct)}`);
      if (snap.sector) {
        reacts.push(
          `${snap.sector.symbol} ${fmtSignedPct(snap.sector.delta_pct)}`,
        );
      }
      if (reacts.length > 0) parts.push(`· ${reacts.join(" / ")}`);
    } catch {
      // malformed snapshot — skip reaction line
    }
  }

  return `- ${parts.join(" ")}`;
}

function fmtSignedPct(n: number | null | undefined): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

