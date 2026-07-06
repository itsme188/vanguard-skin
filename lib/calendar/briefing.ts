import type Database from "better-sqlite3";
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
import { resolveFeatureModel } from "@/lib/ai/models";
import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { mondayOf } from "@/lib/calendar/date-utils";
import {
  findSelfAdmissions,
  buildSelfAdmissionAddendum,
} from "@/lib/calendar/briefing-self-admission";

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

// Hard caps to keep input cost predictable. Raised 2026-07-03 (30k/200k →
// 100k/400k): Eliant Capital weeklies routinely exceed 30k chars, so the
// Sunday briefing was reading only the opening third of a preferred deep-read
// source (same R2 long-email audit that raised the extraction caps). New
// worst case ≈ 100k tokens ≈ ~$1.50 Opus input once a week — accepted.
const MAX_CHARS_PER_ARTICLE = 100_000;  // truncate extremely long pieces
const MAX_TOTAL_DEEP_CHARS = 400_000;   // ~100k tokens input ceiling for deep section
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

  // ── Portfolio holdings (Vanguard accounts only — IBKR excluded) ──
  // `!= 0` (not `> 0`) so shorts surface in the symbol list. `net_qty` is
  // the cross-account sum so Opus knows the net direction without us
  // expanding into per-account legs — keeps the prompt compact while
  // closing A7 (the long-only filter previously hid e.g. shorted MSFT
  // entirely from the briefing's portfolio context). IBKR is excluded
  // (see getBriefingHoldings / BRIEFING_EXCLUDE_IBKR_SQL) — it's the
  // short-term trading book and must not be framed as core positioning.
  const holdings = getBriefingHoldings(db);

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

  // ── Current prices (held + option underlyings + earnings symbols) ─
  // The briefing once wrote "TER closed Friday well below $180" when TER was at $420.
  // Without explicit prices in the prompt, Opus fabricates them when assessing option moneyness.
  // We collect every symbol the model might reference and pass the latest close for each.
  const currentPrices = buildCurrentPrices(db, {
    holdings,
    expiringOptions,
    portfolioEarnings,
    wshEarnings,
  });

  // ── Combined positions per earnings event (issuer-family normalization) ─
  // Bug this fixes: a Finnhub earnings event uses ticker "GOOGL", but the
  // user holds "GOOG" Class C common. String equality misses the link, so
  // the briefing's "largest exposure" framing only saw the GOOGL LEAP and
  // ranked AMZN above Alphabet. With issuerSiblings, GOOG common rolls up
  // under GOOGL earnings and the roster is honest.
  const combinedPositions = buildCombinedPositionsForEvents(
    db,
    portfolioEarnings,
    currentPrices,
  );

  // ── Deterministic macro-exposure lists per macro event ───────────
  // Bug this fixes: the briefing's §6 ISM Manufacturing exposure list said
  // "XPO, NSC, CSX, PRIM, PWR, CLH, GFL — basically every industrial in
  // the book" and silently dropped XMTR (sector="Industrial"). Letting
  // Opus enumerate exposure from prose is unreliable for niche names. We
  // compute the list deterministically by sector and pass it verbatim.
  const macroExposures = buildMacroExposures(db, otherEvents);

  // ── Price levels: triggered this past week + approaching ─────────
  const levelsTriggered = getLevelsTriggeredInWindow(db, 7);
  const levelsNearby = getLevelsNearPrice(db, 0.05);

  // Build holdings list with inline current prices via the exported
  // pure helper (testable in isolation).
  const holdingsList = formatHoldingsList(holdings, currentPrices);

  // Standalone current-prices block — covers option underlyings + earnings
  // symbols not already in the holdings list (e.g., a LEAP whose underlying
  // stock isn't currently held). Belt-and-suspenders so Opus has the price
  // in context regardless of which section it's writing.
  const currentPricesBlock = formatCurrentPricesBlock(currentPrices);

  options?.onProgress?.("Loading weekend deep reads...", 1, 4);

  // ── Weekend deep-read context (full raw_text of 4 preferred sources) ──
  const deepArticles = getFullTextForSources(db, PREFERRED_SOURCE_IDS, DEEP_READ_HOURS);
  const deepContext = buildDeepReadSection(deepArticles);

  options?.onProgress?.("Loading broader market signals...", 2, 4);

  // ── Broader market signals (summary level for other sources) ────
  const allRecent = getRecentArticles(db, { processedOnly: true, relevantOnly: true, limit: 40 });
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

  // Macro context: read cached themes for "all" scope. Workspace card and
  // briefing email read from the same cache so they stay in sync. Failure
  // here MUST NOT block the email — just skip the section.
  //
  // Scope hardcoded to "all" because the briefing email goes to a single
  // recipient who owns every account; per-scope briefings would be a future
  // feature. The Workspace card reads per-scope (matches the current page).
  let macroContextMd: string | null = null;
  try {
    const { getCachedMacroThemes } = await import("@/lib/queries/analysis-macro-themes");
    const { renderMacroThemesMarkdown } = await import("@/lib/digest/macro-themes-markdown");
    const cached = getCachedMacroThemes(db, "all", mondayOf(weekOf));
    if (cached) {
      const themes = JSON.parse(cached.themesJson);
      macroContextMd = renderMacroThemesMarkdown(themes);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[send-briefing] macro-context section skipped: ${msg}`);
  }

  const prompt = buildPrompt({
    weekOf,
    holdingsList,
    currentPricesBlock,
    combinedPositions,
    macroExposures,
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
    macroContextMd,
  });

  const text = await generateBriefingTextWithRegen({
    feature: "briefing",
    prompt,
    onRegen: (matches) =>
      options?.onProgress?.(
        `Self-admission detected (${matches.length}) — regenerating...`,
        3,
        4,
      ),
  });

  const content = text.trim() || "Failed to generate briefing.";

  const title = `Week of ${formatWeekTitle(weekOf)}`;
  saveBriefing(db, {
    weekOf,
    title,
    content,
    eventCount: events.length,
    model: resolveFeatureModel("briefing").modelId,
  });

  options?.onProgress?.("Briefing complete", 4, 4);

  return { content, eventCount: events.length };
}

// ── A5 auto-regen on self-admission ────────────────────────────────

/**
 * Generate briefing text with a 1-shot retry when the first draft contains
 * self-admission phrases ("data looks corrupted", "I can't verify", etc.).
 * The retry appends a forcing addendum that quotes the matched phrases so
 * the model knows specifically what to undo. Capped at exactly one retry —
 * the verify-briefing-content.ts post-gen scan remains as the failsafe for
 * the rare case where both attempts leak.
 *
 * Extracted from `generateWeeklyBriefing` so the regen logic is testable
 * in isolation (without seeding the full briefing DB state).
 */
export async function generateBriefingTextWithRegen(args: {
  feature: FeatureKey;
  prompt: string;
  maxOutputTokens?: number;
  /** Optional hook so callers can surface "regenerating..." progress. */
  onRegen?: (matches: string[]) => void;
}): Promise<string> {
  const maxOutputTokens = args.maxOutputTokens ?? 8192;

  let firstText: string;
  try {
    const firstAttempt = await generateTextForFeature(args.feature, {
      maxOutputTokens,
      prompt: args.prompt,
    });
    firstText = firstAttempt.text;
  } catch (err) {
    if (err instanceof AIRefusalError) {
      console.warn(`[briefing] model refused the first generation attempt`);
      return "";
    }
    throw err;
  }

  const matches = findSelfAdmissions(firstText);
  if (matches.length === 0) return firstText;

  console.warn(
    `[briefing] self-admission detected on first draft (${matches.join(", ")}) — regenerating once`,
  );
  args.onRegen?.(matches);

  try {
    const retry = await generateTextForFeature(args.feature, {
      maxOutputTokens,
      prompt: args.prompt + buildSelfAdmissionAddendum(matches),
    });
    return retry.text;
  } catch (err) {
    if (err instanceof AIRefusalError) {
      console.warn(`[briefing] model refused the retry generation attempt`);
      return "";
    }
    throw err;
  }
}

// ── Prompt assembly ────────────────────────────────────────────────

interface PromptInput {
  weekOf: string;
  holdingsList: string;
  currentPricesBlock: string;
  combinedPositions: Map<number, CombinedPosition>;
  macroExposures: Map<number, MacroExposure>;
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
  macroContextMd?: string | null;
}

function buildPrompt(p: PromptInput): string {
  const weekTitle = formatWeekTitle(p.weekOf);

  const currentPricesSection = p.currentPricesBlock
    ? `\n## Current Prices (last market close — use these verbatim)\n${p.currentPricesBlock}\n\n**CRITICAL:** When discussing any price, option moneyness ("ITM/OTM", "above/below strike"), dollar exposure, or "closed above/below" claims, use the prices listed above. Do NOT fabricate or infer prices. If a symbol you'd reference isn't listed here, say so explicitly rather than guessing.\n`
    : "";

  const portfolioEarningsSection =
    p.portfolioEarnings.length > 0
      ? `\n## Portfolio Earnings This Week\nThese are earnings from companies the user currently holds (Finnhub, cross-referenced against all accounts). For each event, the **User's combined position** field rolls up *every* sibling-class share + option held under the issuer family (e.g., GOOG common counts as exposure to GOOGL earnings). Use that field verbatim — do NOT infer position size from prose elsewhere. For each: setup going in, Street expectations (EPS/revenue consensus are embedded in the description below), how the company has performed against estimates over the last 4 quarters (also in description), key thing to watch on the call, and position implications given current holdings.\n\n${p.portfolioEarnings
          .map((e, i) =>
            formatEventForPrompt(e, i + 1, p.combinedPositions.get(e.id)),
          )
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
      ? `\n## Macro & Other Events This Week\n**HARD RULES for §6 — non-negotiable:**\n\n1. **Verbatim cluster.** Each macro event below that has a "REQUIRED §6 cluster" field MUST have that exact line pasted into your §6 paragraph for that event. The cluster is data, not narrative. Do not edit it, do not drop symbols, do not add symbols (no "plus other industrials", no ETF baskets, no companies you happen to recall as relevant, no "VIS basket" / "VPU basket" type substitutions).\n\n2. **No multi-event lumping.** Even when two events share the same Holdings exposure list (e.g., the labor-market events JOLTS, ADP, Claims, NFP all have the same 11-name list), you must write a separate paragraph for each event with its own pasted cluster line. You may say "same exposure as JOLTS — see below" in the prose, but the cluster line still appears under each event.\n\n3. **Order.** Place the cluster line at the END of each event's paragraph, after your prose context. Prose context comes first (what's priced in, what would surprise, why this matters), then the verbatim cluster.\n\n4. **Trust the data over your memory.** Use the deterministic Holdings exposure field as the source of truth. Your training prior may classify a name differently than the user's portfolio sector field; defer to the field.\n\n5. **Events without a cluster.** Some events have no exposure mapping (e.g., Trade Balance, Durable Goods). For those, write the prose paragraph without a cluster line — do not invent one.\n\n${p.otherEvents
          .map((e, i) =>
            formatEventForPrompt(
              e,
              i + 1,
              undefined,
              p.macroExposures.get(e.id),
            ),
          )
          .join("\n\n")}\n`
      : "";

  const releasedLastWeekSection =
    p.releasedLastWeek.length > 0
      ? `\n## Released Last Week (actual + market reaction)\nCalendar events that printed in the last 7 days, with the actual value and the 2-hour market reaction captured automatically. Use this for continuity context — e.g., "last Tuesday's CPI came in hot and SPY sold off -0.4%" sets up this week's setup more honestly than consensus-only framing.\n\n${p.releasedLastWeek
          .map((e, i) => formatReleasedEventForPrompt(e, i + 1))
          .join("\n")}\n`
      : "";

  const weekendSection = p.deepContext
    ? `\n## Weekend Reading — Full Newsletter Text\nThese are the complete texts of the user's preferred weekend newsletters. Read each carefully. The user's goal is for your synthesis below to **replace** him reading these himself. Identify where authors agree, where they disagree, the consensus call vs contrarian takes, and any specific securities or sectors they highlight. Cite authors by name when referencing a view. ATTRIBUTION: when a newsletter is RELAYING a third party's views — a podcast guest, an interview subject, or a quoted analyst — attribute the view to that originator ("Gavin Baker, via TMT Breakout, argued ..."), never present it as the newsletter's own call.\n\n${p.deepContext}\n`
    : p.imapFallback
      ? `\n## Weekend Market Context (Vital Knowledge — IMAP fallback)\n${p.imapFallback}\n`
      : "";

  const breadthSection = p.breadthContext
    ? `\n## Broader Market Signals (Summary Level — Other Sources)\nPre-summarized by the research-feed pipeline. Use for breadth, not depth. A summary may name an ORIGINATOR it is relaying (e.g. "TMT Breakout summarizes Gavin Baker's podcast remarks") — when it does, attribute the view to that originator, not to the newsletter.\n\n${p.breadthContext}\n`
    : "";

  return `You are a financial research analyst preparing a weekly market briefing for a single portfolio manager. Generate a comprehensive briefing for the week of ${weekTitle}.
${p.macroContextMd ? `\n${p.macroContextMd}\n` : ""}
## Portfolio Holdings (for context on which events directly affect the portfolio)
${p.holdingsList}
${currentPricesSection}${portfolioEarningsSection}${wshSection}${optionsSection}${triggeredLevelsSection}${nearbyLevelsSection}${otherEventsSection}${releasedLastWeekSection}${weekendSection}${breadthSection}

## Instructions

Write a markdown briefing structured as follows:

1. **Week Overview** (2–3 sentences) — the big picture. Highest-impact events, the single most important question the week will answer.

2. **Weekend Reading Synthesis** — synthesize the full weekend newsletters into a narrative. Where do the four authors agree? Where do they diverge? What is the week's consensus call? What's the strongest contrarian take? Cite authors by name. This section should feel like reading the best parts of all four at once, not four disconnected summaries.

3. **Portfolio Earnings** — for each held-company earning above, give the setup, expectations vs. consensus (the estimates and last-4-quarter surprise history are in each event's description), what to watch, and position implications. If none reporting, skip this section.

4. **Options Expiring This Week** — for each expiring option, give the assessment (ITM/OTM/ATM if derivable), action to consider, and assignment risk where relevant. If none expire, skip this section.

5. **Price Levels in Play** — ONLY include if the data sections above show triggered or nearby levels. Two subsections:
   - Recent triggers (last 7 days): did the user's response make sense? Did price action validate or invalidate the level?
   - This week's watch list: for each level within 5% of current price, say what a hit would mean and the action to consider. **HARD RULE — thesis verbatim.** Each level row above carries a stored thesis string in double-quotes (e.g., — "demand zone from Q3 earnings reaction"). Quote that string verbatim when describing the level's direction or implication. Do NOT infer "breakdown" vs "pullback" vs "support" vs "resistance" from the price-action context alone — the user's stored thesis is the authoritative read on direction. When a level has no stored thesis attached, say so explicitly ("no stored thesis — direction implied by level type") rather than inventing one. Skip this whole subsection if there are no triggered or nearby levels.

6. **Macro & Other Events** — concise coverage of the remaining calendar. What's priced in, what would surprise, which holdings have exposure.

7. **Portfolio Implications** — a tight closing section. Which holdings have the most event-driven risk this week. **When ranking "largest position" or "biggest exposure," use the User's combined position rosters from §3 — they include cross-class siblings (e.g., GOOG common counts toward GOOGL earnings exposure).** Express sizing **qualitatively** ("concentrated stock position," "leveraged call exposure," "small starter," etc.) or in **percentage** terms ("~5% of holdings on this name" if a clean read is available) — do NOT multiply share counts by close prices to derive notional dollar exposure (the briefing is shared with cc recipients and should not echo exact position dollar size). Key levels or thresholds (tie back to the Price Levels section). Suggested positioning considerations (stay the course, reduce exposure, hedge, etc.).

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
         AND ${BRIEFING_EXCLUDE_IBKR_SQL}
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

// ── Macro-exposure helpers ─────────────────────────────────────────

export interface MacroExposure {
  basis: string; // human-readable explanation (e.g. "sector=Industrial")
  symbols: string[];
}

/**
 * For each macro event in the input list, compute the user's specific
 * holdings that map to that release's sector exposure. Returns a map keyed
 * by event.id so the formatter can attach the list to the event line.
 *
 * Why this exists: the briefing's §6 once said "ISM Manufacturing exposure:
 * XPO, NSC, CSX, PRIM, PWR, CLH, GFL — basically every industrial in the
 * book" and silently dropped XMTR (sector="Industrial"). Letting Opus
 * enumerate exposure from prose is unreliable for niche names. We pre-
 * compute the list and pass it verbatim.
 */
export function buildMacroExposures(
  db: Database.Database,
  events: CalendarEvent[],
): Map<number, MacroExposure> {
  const out = new Map<number, MacroExposure>();
  for (const e of events) {
    if (e.id == null) continue;
    const mapping = macroEventToSectors(e);
    if (!mapping) continue;
    const symbols = querySymbolsBySectors(db, mapping.sectors);
    if (symbols.length > 0) {
      out.set(e.id, { basis: mapping.basis, symbols });
    }
  }
  return out;
}

/**
 * Map a macro CalendarEvent to a sector whitelist. Returns null when the
 * event type isn't macro-mappable (e.g. earnings events, or events with no
 * meaningful sector exposure).
 *
 * For PMI we differentiate ISM Manufacturing vs ISM Services by the title.
 * For "broad" releases (GDP) we return an empty sectors array meaning
 * "all equity holdings."
 */
function macroEventToSectors(
  event: CalendarEvent,
): { sectors: string[]; basis: string } | null {
  const title = (event.title ?? "").toLowerCase();
  const type = event.event_type;

  if (type === "pmi" && title.includes("services")) {
    return {
      sectors: [
        "Consumer, Cyclical",
        "Consumer, Non-cyclical",
        "Communications",
        "Financial",
      ],
      basis: "ISM Services-sensitive sectors",
    };
  }
  if (type === "pmi") {
    return {
      sectors: ["Industrial", "Basic Materials"],
      basis: "ISM Manufacturing-sensitive sectors (Industrial + Basic Materials)",
    };
  }
  if (type === "fomc") {
    return {
      sectors: ["Financial"],
      basis: "rate-sensitive (Financial sector incl. Banks + REITs)",
    };
  }
  if (type === "cpi") {
    return {
      sectors: ["Consumer, Non-cyclical", "Consumer, Cyclical", "Industrial"],
      basis: "inflation-pass-through (Consumer + Industrial)",
    };
  }
  if (type === "gdp") {
    return {
      sectors: [],
      basis: "broad equity exposure (all holdings)",
    };
  }
  if (type === "jobs") {
    return {
      sectors: ["Consumer, Cyclical", "Financial"],
      basis: "labor-market-sensitive (Consumer Cyclical + Financial)",
    };
  }
  if (type === "housing") {
    return {
      sectors: ["Financial"],
      basis: "housing/rate-sensitive (Financial sector incl. REITs + mortgage)",
    };
  }
  if (type === "retail_sales") {
    return {
      sectors: ["Consumer, Cyclical"],
      basis: "Consumer Cyclical sector",
    };
  }
  if (
    type === "other_macro" &&
    (title.includes("consumer confidence") ||
      title.includes("umich") ||
      title.includes("sentiment"))
  ) {
    return {
      sectors: ["Consumer, Cyclical", "Consumer, Non-cyclical"],
      basis: "consumer-sentiment-sensitive (Consumer sectors)",
    };
  }
  return null;
}

function querySymbolsBySectors(
  db: Database.Database,
  sectors: string[],
): string[] {
  // NOTE: `quantity > 0` is intentional here (not `!= 0`). The macro §6
  // cluster narrates "user holdings in this sector" as positive exposure
  // ("you hold MSFT, AAPL, GOOG in tech"). Including shorts would
  // mislead Opus into framing anti-correlated positions as same-direction
  // sector bets. The main-holdings query at the top of this file does
  // surface shorts (A7) — this sector-cluster context is the exception.
  if (sectors.length === 0) {
    // Broad / all-equity case
    const rows = db
      .prepare(
        `SELECT DISTINCT s.symbol
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         WHERE h.quantity > 0
           AND ${BRIEFING_EXCLUDE_IBKR_SQL}
           AND LOWER(s.security_type) IN ('stock','common stock','etf')
           AND s.sector IS NOT NULL
           AND h.as_of_date = (
             SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id
           )
         ORDER BY s.symbol`,
      )
      .all() as { symbol: string }[];
    return rows.map((r) => r.symbol);
  }
  const placeholders = sectors.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT s.symbol
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE h.quantity > 0
         AND ${BRIEFING_EXCLUDE_IBKR_SQL}
         AND LOWER(s.security_type) IN ('stock','common stock','etf')
         AND s.sector IN (${placeholders})
         AND h.as_of_date = (
           SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id
         )
       ORDER BY s.symbol`,
    )
    .all(...sectors) as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

// ── Briefing account scope: exclude IBKR ────────────────────────────

/**
 * The weekly briefing's portfolio context EXCLUDES the IBKR account(s).
 *
 * IBKR is the user's short-term / active-trading book; its positions are
 * tactical and must NEVER be framed as core holdings in the briefing. This
 * fixes the "you hold QQQ outright" bug — QQQ (and a large book of QQQ
 * options) is held only in IBKR, never in either Vanguard account, yet the
 * cross-account holdings sum surfaced it to Opus as a plain holding.
 *
 * The predicate matches the account-name "ibkr" convention used elsewhere in
 * the codebase (e.g. combineFamilyPositions) so a renamed/added IBKR account
 * is still caught. It is applied to every briefing-LOCAL holdings/positions
 * query. Shared queries used by OTHER surfaces are intentionally NOT filtered
 * — `getHeldStockSymbols` (drives the earnings-calendar sync for Today's
 * EarningsHub) and `getCrossAccountPositions` (earnings emails) keep their
 * full cross-account view.
 *
 * Assumes the holdings table is aliased `h` in the consuming query.
 */
export const BRIEFING_EXCLUDE_IBKR_SQL =
  "h.account_id NOT IN (SELECT id FROM accounts WHERE LOWER(name) LIKE '%ibkr%')";

/**
 * Portfolio holdings that feed the briefing's prompt — Vanguard accounts only
 * (IBKR excluded, see BRIEFING_EXCLUDE_IBKR_SQL). `quantity != 0` so net
 * shorts surface; `net_qty` is the cross-account (Vanguard Taxable + Roth)
 * sum. Extracted from generateWeeklyBriefing for unit testability.
 */
export function getBriefingHoldings(
  db: Database.Database,
): BriefingHolding[] {
  return db
    .prepare(
      `SELECT s.symbol, s.name, s.security_type, s.sector,
              SUM(h.quantity) AS net_qty
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE h.quantity != 0
         AND ${BRIEFING_EXCLUDE_IBKR_SQL}
         AND h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id)
       GROUP BY s.id
       ORDER BY s.symbol`,
    )
    .all() as BriefingHolding[];
}

// ── Main-holdings list formatter (A7 short-aware) ───────────────────

export interface BriefingHolding {
  symbol: string;
  name: string | null;
  security_type: string | null;
  sector: string | null;
  /** Cross-account net quantity (positive = long, negative = short). */
  net_qty: number;
}

/**
 * Render the portfolio-holdings symbol list that feeds Opus's portfolio
 * context. Long-only positions stay in the compact original shape so the
 * prompt doesn't bloat for the 99% case; net-short positions get an
 * explicit "NET SHORT n" marker so Opus does not narrate them as "you
 * hold X" (the original `quantity > 0` filter hid shorts entirely — A7).
 */
export function formatHoldingsList(
  holdings: BriefingHolding[],
  currentPrices: Map<string, { close: number; date: string }>,
): string {
  return holdings
    .map((h) => {
      const p = currentPrices.get(h.symbol);
      const priceSuffix = p
        ? ` — last $${p.close.toFixed(2)} (${p.date})`
        : ` — no recent price`;
      const directionSuffix =
        h.net_qty < 0
          ? ` — NET SHORT ${Math.abs(h.net_qty)} (cross-account net)`
          : "";
      return `${h.symbol} (${h.name ?? "unknown"}, ${h.sector ?? "N/A"})${directionSuffix}${priceSuffix}`;
    })
    .join("\n");
}

// ── Combined-position helpers (issuer family per earnings event) ────

interface CombinedStockPosition {
  symbol: string;
  quantity: number;
  account: string;
  latestClose: number | null;
}

interface CombinedOptionPosition {
  occSymbol: string;
  underlying: string;
  strike: number | null;
  expiry: string;
  optionType: string | null;
  quantity: number;
  account: string;
}

export interface CombinedPosition {
  family: readonly string[];
  stockPositions: CombinedStockPosition[];
  optionPositions: CombinedOptionPosition[];
}

/**
 * For each earnings event, gather every position the user holds under the
 * same issuer family (Class A + Class C common, plus options on any
 * sibling). Returned keyed by event.id so the caller can attach the roster
 * to the corresponding event line in the prompt.
 *
 * Why this exists: a Finnhub earnings event uses ticker "GOOGL" but the
 * user holds "GOOG" Class C common. Without family normalization the GOOG
 * shares stay orphaned and the briefing's "largest exposure" framing is
 * wrong.
 */
export function buildCombinedPositionsForEvents(
  db: Database.Database,
  events: CalendarEvent[],
  currentPrices: Map<string, { close: number; date: string }>,
): Map<number, CombinedPosition> {
  const out = new Map<number, CombinedPosition>();
  for (const e of events) {
    if (!e.symbol || e.id == null) continue;
    const family = issuerSiblings(e.symbol);
    const placeholders = family.map(() => "?").join(",");

    const stocks = db
      .prepare(
        `SELECT s.symbol, h.quantity, a.name AS account
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         JOIN accounts a ON a.id = h.account_id
         WHERE s.symbol IN (${placeholders})
           AND LOWER(s.security_type) != 'option'
           AND h.quantity != 0
           AND ${BRIEFING_EXCLUDE_IBKR_SQL}
           AND h.as_of_date = (
             SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id
           )`,
      )
      .all(...family) as { symbol: string; quantity: number; account: string }[];

    const stockPositions: CombinedStockPosition[] = stocks.map((s) => ({
      symbol: s.symbol,
      quantity: s.quantity,
      account: s.account,
      latestClose: currentPrices.get(s.symbol)?.close ?? null,
    }));

    const optionPositions = db
      .prepare(
        `SELECT s.symbol AS occSymbol, s.underlying_symbol AS underlying,
                s.strike_price AS strike, s.expiration_date AS expiry,
                s.option_type AS optionType, h.quantity, a.name AS account
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         JOIN accounts a ON a.id = h.account_id
         WHERE LOWER(s.security_type) = 'option'
           AND s.underlying_symbol IN (${placeholders})
           AND h.quantity != 0
           AND ${BRIEFING_EXCLUDE_IBKR_SQL}
           AND h.as_of_date = (
             SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id
           )`,
      )
      .all(...family) as CombinedOptionPosition[];

    if (stockPositions.length > 0 || optionPositions.length > 0) {
      out.set(e.id, { family, stockPositions, optionPositions });
    }
  }
  return out;
}

export function formatCombinedPosition(cp: CombinedPosition): string {
  // Presence-only rendering: never include the position's mkt val in $ —
  // outbound emails are shared with cc recipients per 2026-05-12 design
  // decision. Strike + expiry + qty + direction stay visible (public-market
  // metadata + ownership disclosure); what stays hidden is the dollar
  // exposure derivable from qty × price. Briefing CombinedPosition lacks
  // cost_basis, so relative-% returns are not available here (only the
  // earnings emails carry that data) — emit ownership-only.
  const parts: string[] = [];
  for (const s of cp.stockPositions) {
    const side = s.quantity < 0 ? "short " : "";
    parts.push(
      `${formatQty(s.quantity)} sh ${side}${s.symbol} (${s.account})`,
    );
  }
  for (const o of cp.optionPositions) {
    const side = o.quantity > 0 ? "long" : "short";
    const qty = Math.abs(o.quantity);
    const strike = o.strike != null ? `$${o.strike}` : "?";
    parts.push(
      `${qty} ${side} ${o.underlying} ${o.expiry} ${strike} ${o.optionType ?? "?"} (${o.account})`,
    );
  }
  return parts.join(" + ");
}

function formatQty(q: number): string {
  // Integer-quantity stocks render cleanly; fractional shares (Vanguard
  // dividend-reinvest etc.) get two decimals.
  if (Number.isInteger(q)) return q.toString();
  return q.toFixed(2);
}

// ── Current-prices helpers ─────────────────────────────────────────

/**
 * Collects every symbol the briefing might cite a price for and returns the
 * latest close per symbol. Sources of symbols:
 *   - held stocks/ETFs (the holdings list)
 *   - underlyings of options expiring this week
 *   - earnings event tickers (Finnhub + WSH)
 *   - underlyings of any non-expiring options the user holds (e.g. a TER LEAP
 *     when TER stock isn't currently in holdings)
 * Why all four: we don't want Opus inferring "TER closed Friday well below
 * $180" when TER is at $420. Pass the price; do not let the model guess.
 */
export function buildCurrentPrices(
  db: Database.Database,
  args: {
    holdings: { symbol: string }[];
    expiringOptions: ExpiringOption[];
    portfolioEarnings: CalendarEvent[];
    wshEarnings: CalendarEvent[];
  }
): Map<string, { close: number; date: string }> {
  const symbols = new Set<string>();
  for (const h of args.holdings) symbols.add(h.symbol);
  for (const o of args.expiringOptions) {
    if (o.underlying_symbol) symbols.add(o.underlying_symbol);
  }
  for (const e of args.portfolioEarnings) if (e.symbol) symbols.add(e.symbol);
  for (const e of args.wshEarnings) if (e.symbol) symbols.add(e.symbol);

  const optUnderlyings = db
    .prepare(
      `SELECT DISTINCT s.underlying_symbol AS sym
       FROM holdings h JOIN securities s ON s.id = h.security_id
       WHERE LOWER(s.security_type) = 'option'
         AND h.quantity != 0
         AND ${BRIEFING_EXCLUDE_IBKR_SQL}
         AND s.underlying_symbol IS NOT NULL
         AND h.as_of_date = (
           SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id
         )`
    )
    .all() as { sym: string }[];
  for (const u of optUnderlyings) if (u.sym) symbols.add(u.sym);

  const out = new Map<string, { close: number; date: string }>();
  if (symbols.size === 0) return out;

  const list = Array.from(symbols);
  const placeholders = list.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.symbol, p.close_price * COALESCE(fx.usd_per_unit, 1) AS close_price, p.date
       FROM securities s
       JOIN prices p ON p.security_id = s.id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE s.symbol IN (${placeholders})
         AND LOWER(s.security_type) IN ('stock','etf','mutual fund','common stock','bond')
         AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = s.id)`
    )
    .all(...list) as { symbol: string; close_price: number; date: string }[];

  for (const r of rows) out.set(r.symbol, { close: r.close_price, date: r.date });
  return out;
}

export function formatCurrentPricesBlock(
  currentPrices: Map<string, { close: number; date: string }>
): string {
  if (currentPrices.size === 0) return "";
  return Array.from(currentPrices.keys())
    .sort()
    .map((sym) => {
      const p = currentPrices.get(sym)!;
      return `- ${sym}: $${p.close.toFixed(2)} (${p.date})`;
    })
    .join("\n");
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

function formatEventForPrompt(
  event: CalendarEvent,
  index: number,
  combinedPosition?: CombinedPosition,
  macroExposure?: MacroExposure,
): string {
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
  if (
    combinedPosition &&
    (combinedPosition.stockPositions.length > 0 ||
      combinedPosition.optionPositions.length > 0)
  ) {
    parts.push(
      `   - User's combined position (across ${combinedPosition.family.join(" + ")}): ${formatCombinedPosition(combinedPosition)}`,
    );
  }
  if (macroExposure && macroExposure.symbols.length > 0) {
    const symbolsCsv = macroExposure.symbols.join(", ");
    parts.push(
      `   - Holdings exposure (${macroExposure.basis}): ${symbolsCsv}`,
    );
    // Pre-rendered §6 cluster — Opus must paste verbatim, no edits.
    // Earlier directive-only attempts (f02517c) had Opus drop names + add
    // training-prior names ("PWR, VIS basket") despite HARD RULE language.
    // By rendering the cluster deterministically and instructing Opus to
    // paste it, the verbatim guarantee no longer relies on Opus's restraint.
    parts.push(
      `   - **REQUIRED §6 cluster (paste this exact line into the §6 paragraph for this event — do not edit, drop, or add symbols):** \`**Holdings exposed:** ${symbolsCsv}\``,
    );
  }
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

