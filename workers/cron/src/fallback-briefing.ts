/**
 * Cloud-fallback weekly briefing — runs when the Mac primary path fails.
 *
 * Flow:
 *   1. Load latest R2 snapshot (calendar events, held symbols, deep-read
 *      newsletters for VK + Eliant + Purple Drink + Meisler, breadth summaries).
 *   2. Assemble the briefing prompt — same structure as Mac's
 *      lib/calendar/briefing.ts::buildPrompt but with the sections available
 *      in the snapshot.
 *   3. Call Claude Opus via AI Gateway.
 *   4. Compose HTML with italic footer disclosing fallback delivery.
 *   5. Send via Gmail REST.
 *
 * Missing vs. Mac-generated briefing (accepted gap):
 *   - Expiring options (TWS + SQLite data, not in snapshot)
 *   - Price levels (SQLite-only, not in snapshot)
 *   - Live Vital Knowledge IMAP fallback (Workers can't IMAP; we rely on
 *     snapshot's VK deep-read entries, which cover last 72h)
 */

import { generateText } from "ai";
import { loadLatestSnapshot, type Snapshot } from "./state";
import { sendEmail } from "./resend";
import { generateWithFailover } from "./ai";
import { briefingToHtml } from "./html";
import { todayET, getCurrentETDayOfWeek } from "./dst";
import type { FallbackEnv, FallbackResult } from "./fallback-digest";

// Must match Mac's lib/calendar/briefing.ts constants.
const PREFERRED_SOURCE_IDS = [1, 18, 19, 28];
const MAX_CHARS_PER_ARTICLE = 30_000;
const MAX_TOTAL_DEEP_CHARS = 200_000;
const BROADER_ARTICLE_LIMIT = 15;

export async function runFallbackBriefing(
  env: FallbackEnv,
  opts: { dryRun?: boolean } = {}
): Promise<FallbackResult> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_DOMAIN) {
    return {
      kind: "error",
      error: "RESEND_API_KEY / RESEND_FROM_DOMAIN missing",
    };
  }

  let snapshot: Snapshot | null;
  try {
    snapshot = await loadLatestSnapshot(env.ARCHIVE);
  } catch (err) {
    return {
      kind: "error",
      error: `snapshot load failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!snapshot) return { kind: "no_snapshot" };

  // ── Recipient resolution ─────────────────────────────────────────────────
  const rawRecipients = snapshot.settings.briefing_email_recipients;
  let recipient: string;
  if (rawRecipients && rawRecipients.trim().length > 0) {
    // Normalize comma-separated: trim each, rejoin with ", "
    recipient = rawRecipients
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0)
      .join(", ");
  } else if (env.BRIEFING_EMAIL_TO) {
    recipient = env.BRIEFING_EMAIL_TO;
  } else {
    return { kind: "error", error: "recipient missing: no briefing_email_recipients in snapshot and BRIEFING_EMAIL_TO is unset" };
  }

  const weekOf = briefingWeekOf();

  // IBKR is the short-term trading book and is deliberately EXCLUDED from the
  // briefing's portfolio context (mirrors the Mac's BRIEFING_EXCLUDE_IBKR_SQL /
  // getBriefingHoldings, U4 2026-06-15). buildPrompt renders snapshot
  // .briefingHoldings (Vanguard-only) and never pulls live IBKR — so a
  // cloud-generated briefing never surfaces the trading book as research
  // holdings, which the old live-IBKR-symbol merge used to do.
  const prompt = buildPrompt(snapshot, weekOf);

  const catalog = snapshot.modelCatalog ?? [];

  let text: string;
  try {
    const result = await generateWithFailover(env, "fallbackBriefing", catalog, (model) =>
      generateText({ model, maxOutputTokens: 8192, prompt }),
    );
    text = result.text;
  } catch (err) {
    // The credit-exhaustion / rate-limit analog. Surface loudly as kind:"error"
    // instead of letting it throw raw through runJob's catch-all (which loses
    // the stage context). This is the branch that hid the 5/20 outage.
    return {
      kind: "error",
      error: `briefing generation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const content = text.trim();
  if (!content) return { kind: "error", error: "Opus returned empty briefing" };

  const title = `Week of ${formatWeekTitle(weekOf)}`;
  const footer = `(fallback delivery, state snapshot ${snapshot.snapshotDate}) — Mac was offline. Options + price-levels sections unavailable.`;
  const html = briefingToHtml(content, title, footer);

  if (opts.dryRun) {
    return { kind: "success", processedCount: snapshot.calendarEvents.length };
  }

  let send: Awaited<ReturnType<typeof sendEmail>>;
  try {
    send = await sendEmail(env, {
      to: recipient,
      subject: `📊 ${title} — Weekly Portfolio Briefing`,
      html,
      fromLocalPart: "briefing",
    });
  } catch (err) {
    return {
      kind: "error",
      error: `resend send failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    kind: "success",
    sentMessageId: send.id,
    processedCount: snapshot.calendarEvents.length,
  };
}

// ── Prompt assembly ────────────────────────────────────────────────

/**
 * Render the briefing's portfolio-holdings context. Prefers the v7
 * Vanguard-only `briefingHoldings` (IBKR excluded — single-sourced from the
 * Mac's getBriefingHoldings), rendered richly (symbol, name, sector, NET SHORT
 * marker) to mirror the Mac briefing's formatHoldingsList. Falls back to the
 * cross-account `heldSymbols` flat list for pre-v7 snapshots (a ≤24h window
 * after deploy, until the next 2am snapshot writes the field) so the briefing
 * still ships rather than rendering an empty holdings block.
 */
export function renderBriefingHoldings(snapshot: Snapshot): string {
  const holdings = snapshot.briefingHoldings;
  if (holdings && holdings.length > 0) {
    return holdings
      .map((h) => {
        const shortSuffix =
          h.netQty < 0
            ? ` — NET SHORT ${Math.abs(h.netQty)} (cross-account net)`
            : "";
        return `${h.symbol} (${h.name ?? "unknown"}, ${h.sector ?? "N/A"})${shortSuffix}`;
      })
      .join("\n");
  }
  // Pre-v7 snapshot (no briefingHoldings field): degrade to the cross-account
  // flat symbol list. This includes IBKR names — accepted for the brief
  // post-deploy window only; the next nightly snapshot replaces it.
  return snapshot.heldSymbols.join(", ") || "(no holdings snapshot available)";
}

function buildPrompt(snapshot: Snapshot, weekOf: string): string {
  const weekTitle = formatWeekTitle(weekOf);

  const holdingsList = renderBriefingHoldings(snapshot);

  // Partition events by category — same classification as Mac side.
  const portfolioEarnings = snapshot.calendarEvents.filter(
    (e) => e.source === "finnhub" && e.event_type === "earnings"
  );
  const wshEarnings = snapshot.calendarEvents.filter(
    (e) => e.source === "wsh" && e.event_type === "earnings"
  );
  const otherEvents = snapshot.calendarEvents.filter(
    (e) => e.source !== "finnhub" && !(e.source === "wsh" && e.event_type === "earnings")
  );

  // Deep-read (72h full text of 4 preferred sources).
  const deepContext = buildDeepSection(snapshot);

  // Breadth context — summary level from other sources.
  const breadth = snapshot.recentArticlesMeta
    .filter((a) => !PREFERRED_SOURCE_IDS.includes(a.source_id))
    .filter((a) => a.summary)
    .slice(0, BROADER_ARTICLE_LIMIT);
  const breadthContext = breadth
    .map((a) => `[${a.received_at.slice(0, 10)}] ${a.source_name}: ${a.subject}\n${a.summary || ""}`)
    .join("\n\n---\n\n");

  const portfolioEarningsSection =
    portfolioEarnings.length > 0
      ? `\n## Portfolio Earnings This Week\nEarnings from held companies. For each: setup, expectations, what to watch, position implications.\n\n${portfolioEarnings
          .map((e, i) => formatEvent(e, i + 1))
          .join("\n\n")}\n`
      : "";

  const wshSection =
    wshEarnings.length > 0
      ? `\n## Other Earnings Announcements This Week\n${wshEarnings
          .map((e, i) => formatEvent(e, i + 1))
          .join("\n\n")}\n`
      : "";

  const otherEventsSection =
    otherEvents.length > 0
      ? `\n## Macro & Other Events This Week\n${otherEvents
          .map((e, i) => formatEvent(e, i + 1))
          .join("\n\n")}\n`
      : "";

  const weekendSection = deepContext
    ? `\n## Weekend Reading — Full Newsletter Text\nComplete texts of preferred weekend newsletters. Synthesize. Where do the authors agree? Disagree? Cite by name.\n\n${deepContext}\n`
    : "";

  const breadthSection = breadthContext
    ? `\n## Broader Market Signals (Summary Level)\nAlready summarized by the research-feed pipeline. Breadth, not depth.\n\n${breadthContext}\n`
    : "";

  return `You are a financial research analyst preparing a weekly market briefing for a single portfolio manager. Generate a comprehensive briefing for the week of ${weekTitle}.

## Portfolio Holdings (context)
${holdingsList}
${portfolioEarningsSection}${wshSection}${otherEventsSection}${weekendSection}${breadthSection}

## Instructions

Write a markdown briefing structured as follows:

1. **Week Overview** (2-3 sentences) — big picture, highest-impact events, single most important question.
2. **Weekend Reading Synthesis** — synthesize the deep-read newsletters into one narrative. Agreements, divergences, consensus call, strongest contrarian take. Cite authors by name.
3. **Portfolio Earnings** — for each held-company earning, give setup, expectations, what to watch, position implications. Skip if none.
4. **Macro & Other Events** — concise coverage, what is priced in, what would surprise, which holdings have exposure.
5. **Portfolio Implications** — tight closing. Event-driven risk this week, suggested positioning considerations.

Note: Options expiries and price-level monitoring sections are omitted — this fallback briefing is generated from a state snapshot and does not have access to live TWS position data or SQLite levels.`;
}

function buildDeepSection(snapshot: Snapshot): string {
  let total = 0;
  const chunks: string[] = [];
  for (const article of snapshot.deepReadArticles) {
    if (!article.raw_text) continue;
    const text = article.raw_text.slice(0, MAX_CHARS_PER_ARTICLE);
    if (total + text.length > MAX_TOTAL_DEEP_CHARS) break;
    chunks.push(
      `### ${article.source_name} — ${article.received_at.slice(0, 10)}: ${article.subject}\n\n${text}`
    );
    total += text.length;
  }
  return chunks.join("\n\n---\n\n");
}

function formatEvent(e: Snapshot["calendarEvents"][number], n: number): string {
  const sym = e.symbol ? ` [${e.symbol}]` : "";
  const time = e.event_time ? ` ${e.event_time}` : "";
  const impact = e.expected_impact ? ` (impact: ${e.expected_impact})` : "";
  const desc = e.description ? `\n${String(e.description).slice(0, 1500)}` : "";
  const consensus = e.consensus_estimate
    ? `\nConsensus: ${e.consensus_estimate}`
    : "";
  const previous = e.previous_value ? `\nPrevious: ${e.previous_value}` : "";
  return `${n}. **${e.title}**${sym} — ${e.event_date}${time}${impact}${desc}${consensus}${previous}`;
}

function formatWeekTitle(weekOf: string): string {
  const d = new Date(`${weekOf}T12:00:00Z`);
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function briefingWeekOf(now: Date = new Date()): string {
  // The week the briefing covers, matching the Mac's getCurrentMonday():
  //  - Sunday → NEXT Monday (the upcoming trading week)
  //  - Monday-Friday → THIS Monday (used when the briefing is deferred to a
  //    holiday Monday — it must cover the week that's starting, not next week)
  //  - Saturday → next Monday
  // Computed in ET, not UTC: a late-Sunday-ET catch-up tick (22:00 ET = 02:00
  // UTC Mon) reads as Monday in UTC and would jump a week with getUTCDay().
  const day = getCurrentETDayOfWeek(now); // 0 = Sunday ET
  const diff = day === 0 ? 1 : day === 6 ? 2 : 1 - day;
  // Anchor the ET date at noon-UTC and add whole days; slice(0,10) stays stable.
  const d = new Date(`${todayET(now)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}
