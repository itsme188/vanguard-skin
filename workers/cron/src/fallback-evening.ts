/**
 * Cloud-fallback evening email — runs when the Mac primary path fails.
 *
 * Flow:
 *   1. Load R2 snapshot. Require schemaVersion >= 2 (v1 has no useful content).
 *   2. Determine recipient: settings.evening_email_recipients → BRIEFING_EMAIL_TO.
 *   3. Determine `since`: settings.last_digest_sent_at ?? (now - 24h).
 *   4. Fetch articles via snapshot meta (same approach as fallback-digest).
 *   5. If schemaVersion >= 3 AND vanguardHoldings + securityBetas are present:
 *        fetch SPY + Vanguard-symbol last-2-closes from Yahoo and compute
 *        anomalies inline (ported from lib/digest/anomalies.ts, no DB access).
 *        Yahoo failure is swallowed — anomaly block gracefully omitted.
 *   6. Compose body: synthesis (AI) if >= 5 articles, otherwise per-source.
 *   7. Assemble markdown: [anomalyBlock, body] filtered + joined with "---".
 *   8. If empty → return {kind: "skipped"}.
 *   9. Send via Resend with fromLocalPart: "evening".
 *
 * Privacy: anomaly output emits only public market data (ticker, % move, beta).
 * No $ amounts, share counts, or portfolio-size language.
 */

import { generateText, generateObject, jsonSchema } from "ai";
import { loadLatestSnapshot, type Snapshot, type RecentArticleMeta } from "./state";
import { sendEmail } from "./resend";
import { getModelForFeature } from "./ai";
import { briefingToHtml } from "./html";
import { todayET } from "./dst";
import type { FallbackEnv, FallbackResult } from "./fallback-digest";

// ── Yahoo last-2-closes (lightweight, no reaction window needed) ──────────────

interface Last2Closes {
  prior: number;
  today: number;
}

/** Fetch the two most recent daily closes for a symbol from Yahoo Finance. */
async function fetchLast2Closes(symbol: string): Promise<Last2Closes | null> {
  // Request last 5 trading days so weekends/holidays don't produce empty results
  const toSec = Math.ceil(Date.now() / 1000);
  const fromSec = toSec - 7 * 86400; // 7 days back

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&period1=${fromSec}&period2=${toSec}`;

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return null;

  const data = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: Array<number | null> }> };
      }>;
    };
  };

  const result = data.chart?.result?.[0];
  if (!result) return null;

  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(
    (c): c is number => c != null
  );
  if (closes.length < 2) return null;

  // Last two valid closes
  return {
    prior: closes[closes.length - 2],
    today: closes[closes.length - 1],
  };
}

// ── Anomaly computation (ported from lib/digest/anomalies.ts) ─────────────────

interface AnomalyFlag {
  symbol: string;
  actualPct: number;
  spyPct: number;
  beta: number;
  expectedPct: number;
  thresholdPct: number;
  ratio: number;
  directionFlipped: boolean;
}

/**
 * Compute anomaly flags for Vanguard holdings using snapshot data + Yahoo closes.
 * Returns null on any Yahoo failure — caller should log and skip the block.
 */
async function computeAnomaliesFromSnapshot(
  vanguardHoldings: NonNullable<Snapshot["vanguardHoldings"]>,
  securityBetas: NonNullable<Snapshot["securityBetas"]>,
): Promise<AnomalyFlag[] | null> {
  if (vanguardHoldings.length === 0 || securityBetas.length === 0) return null;

  const symbols = [...new Set(vanguardHoldings.map((h) => h.symbol))];
  const betaMap = new Map<number, number>(
    securityBetas
      .filter((b) => b.lookbackDays === 60)
      .map((b) => [b.securityId, b.beta]),
  );

  // Fetch SPY + all Vanguard symbols
  const allSymbols = ["SPY", ...symbols.filter((s) => s !== "SPY")];
  const closesMap = new Map<string, Last2Closes>();

  for (const sym of allSymbols) {
    const closes = await fetchLast2Closes(sym);
    if (closes) closesMap.set(sym, closes);
  }

  const spyCloses = closesMap.get("SPY");
  if (!spyCloses || spyCloses.prior === 0) return null;

  const spyPct = ((spyCloses.today - spyCloses.prior) / spyCloses.prior) * 100;

  const flags: AnomalyFlag[] = [];

  for (const holding of vanguardHoldings) {
    if (holding.symbol === "SPY") continue;
    const beta = betaMap.get(holding.securityId);
    if (beta == null) continue;

    const closes = closesMap.get(holding.symbol);
    if (!closes || closes.prior === 0) continue;

    const actualPct = ((closes.today - closes.prior) / closes.prior) * 100;
    const expectedPct = spyPct * beta;
    const thresholdPct = Math.max(2 * Math.abs(expectedPct), 1.0);

    if (Math.abs(actualPct) <= thresholdPct) continue;

    const ratio = Math.abs(actualPct) / thresholdPct;
    const directionFlipped =
      Math.abs(expectedPct) > 0.1 &&
      Math.sign(actualPct) !== 0 &&
      Math.sign(expectedPct) !== 0 &&
      Math.sign(actualPct) !== Math.sign(expectedPct);

    flags.push({ symbol: holding.symbol, actualPct, spyPct, beta, expectedPct, thresholdPct, ratio, directionFlipped });
  }

  // Dedup by symbol (multiple accounts may hold same security)
  const seen = new Set<string>();
  const deduped = flags.filter((f) => {
    if (seen.has(f.symbol)) return false;
    seen.add(f.symbol);
    return true;
  });

  // Sort by ratio desc (largest deviation first), cap at 5
  deduped.sort((a, b) => b.ratio - a.ratio);
  return deduped;
}

function signedPct(value: number, decimals = 1): string {
  const rounded = parseFloat(value.toFixed(decimals));
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${rounded.toFixed(decimals)}%`;
}

function formatAnomalyBlock(flags: AnomalyFlag[]): string {
  if (flags.length === 0) return "";

  const MAX_DISPLAY = 5;
  const displayed = flags.slice(0, MAX_DISPLAY);
  const extras = flags.length - MAX_DISPLAY;

  const lines: string[] = [
    "## Significant Moves in Vanguard Holdings (vs. expected)",
    "",
  ];

  for (const flag of displayed) {
    const signedActual = signedPct(flag.actualPct);
    const signedExpected = signedPct(flag.expectedPct);
    const signedSpy = signedPct(flag.spyPct);
    const reason = flag.directionFlipped
      ? "Direction flipped."
      : `${flag.ratio.toFixed(1)}× expected.`;
    lines.push(
      `- **${flag.symbol}** ${signedActual} — expected ${signedExpected} (beta ${flag.beta.toFixed(1)} × SPY ${signedSpy}). ${reason}`,
    );
  }

  if (extras > 0) {
    lines.push(`*(${extras} more flagged — see /dashboard/today)*`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── Article rendering ─────────────────────────────────────────────────────────

function renderPerSource(articles: RecentArticleMeta[]): string {
  if (articles.length === 0) return "";
  const lines: string[] = [];
  for (const a of articles) {
    const sentiment = a.sentiment ?? "neutral";
    lines.push(`## ${a.source_name.toUpperCase()} · *${sentiment}*`);
    const url = a.source_url || a.website_url;
    lines.push(url ? `### [${a.subject}](${url})` : `### ${a.subject}`);
    lines.push("");
    if (a.summary) {
      lines.push(a.summary);
      lines.push("");
    }
    if (a.portfolio_relevance) {
      lines.push(`> **Portfolio relevance**: ${a.portfolio_relevance}`);
      lines.push("");
    }
    const themes = parseJsonArray(a.key_themes);
    if (themes.length > 0) {
      lines.push(`*${themes.join(" · ")}*`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n").trim();
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ── AI synthesis ──────────────────────────────────────────────────────────────

/** Group articles by company using their mentioned_symbols field. */
function bucketByCompany(
  articles: RecentArticleMeta[],
): Record<string, RecentArticleMeta[]> {
  const buckets: Record<string, RecentArticleMeta[]> = {};
  for (const a of articles) {
    const symbols = parseJsonArray(a.mentioned_symbols);
    if (symbols.length === 0) {
      (buckets["(macro/other)"] ??= []).push(a);
    } else {
      for (const sym of symbols) {
        (buckets[sym.toUpperCase()] ??= []).push(a);
      }
    }
  }
  return buckets;
}

function buildSynthesisPrompt(
  buckets: Record<string, RecentArticleMeta[]>,
  snap: Snapshot,
): string {
  const holdingsList = snap.heldSymbols.join(", ") || "(none)";
  const dateStr = todayET();

  const bucketLines: string[] = [];
  for (const [sym, arts] of Object.entries(buckets)) {
    bucketLines.push(`### ${sym}`);
    for (const a of arts) {
      bucketLines.push(`**${a.source_name}**: ${a.subject}`);
      if (a.summary) bucketLines.push(a.summary);
      if (a.portfolio_relevance) bucketLines.push(`> ${a.portfolio_relevance}`);
      bucketLines.push("");
    }
  }

  return `You are a financial analyst writing an evening recap email (${dateStr}) for a portfolio manager.

Portfolio holdings: ${holdingsList}

Today's research feed — grouped by company/topic:

${bucketLines.join("\n")}

Write a concise markdown evening recap:
1. **Today's Key Themes** (2-3 sentences) — what mattered most across the day's research.
2. **Company-by-Company** — for each relevant holding with significant coverage, one tight paragraph: what was said, what it means for the position.
3. **Positioning Notes** — brief closing on any names where today's coverage changes the near-term thesis.

Output markdown only. No preamble, no sign-off.`;
}

/**
 * Mirrors the Mac-side validation in `lib/ai/strip-preamble.ts`. Worker is bundled
 * separately and can't import from the Mac codebase — duplication is intentional.
 */
function stripModelPreamble(text: string): string {
  const lines = text.split("\n");
  let firstReal = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    if (/^(#|\||[-*+]\s|>\s|---|```)/.test(trimmed)) {
      firstReal = i;
      break;
    }
  }
  return lines.slice(firstReal).join("\n").trim();
}

const SYNTHESIS_MIN_CHARS = 200;

async function synthesizeViaAI(
  env: FallbackEnv,
  articles: RecentArticleMeta[],
  snap: Snapshot,
): Promise<string | null> {
  const buckets = bucketByCompany(articles);
  const prompt = buildSynthesisPrompt(buckets, snap);
  try {
    const result = await generateText({
      model: getModelForFeature(env, "fallbackEvening"),
      maxOutputTokens: 4096,
      prompt,
    });

    // Mirror Mac's strict validation in lib/digest/synthesize.ts:
    //   1. Truncation guard, 2. preamble strip, 3. header check, 4. min length.
    // On any failure return null so the caller falls back to per-source layout.
    if (result.finishReason === "length") {
      console.warn("[fallback-evening] synthesis truncated by max tokens");
      return null;
    }

    const stripped = stripModelPreamble(result.text ?? "");
    const firstNonEmpty = stripped.split("\n").find((line) => line.trim().length > 0);
    if (!firstNonEmpty || !firstNonEmpty.trim().startsWith("#")) {
      console.warn("[fallback-evening] synthesis has no markdown header");
      return null;
    }

    if (stripped.length < SYNTHESIS_MIN_CHARS) {
      console.warn(
        `[fallback-evening] synthesis too short (${stripped.length} chars)`,
      );
      return null;
    }

    return stripped;
  } catch (err) {
    console.warn("[fallback-evening] synthesis failed:", err);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultSince(): string {
  return new Date(Date.now() - 86_400_000).toISOString();
}

function formatDateForTitle(now: Date = new Date()): string {
  return now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function filterSinceArticles(
  articles: RecentArticleMeta[],
  since: string,
): RecentArticleMeta[] {
  // Normalize `since` to a comparable prefix (YYYY-MM-DD HH:MM:SS)
  // received_at is stored as "YYYY-MM-DD HH:MM:SS"; since may be ISO-Z.
  // Both normalize to a comparable form via Date comparison.
  let sinceMs: number;
  try {
    sinceMs = new Date(since).getTime();
  } catch {
    sinceMs = Date.now() - 86_400_000;
  }
  return articles.filter((a) => {
    const artMs = new Date(a.received_at.replace(" ", "T") + "Z").getTime();
    return artMs >= sinceMs;
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runFallbackEvening(
  env: FallbackEnv,
  opts: { dryRun?: boolean } = {},
): Promise<FallbackResult & { htmlLength?: number; reason?: string }> {
  // ── Pre-flight checks ────────────────────────────────────────────────────
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_DOMAIN) {
    return { kind: "error", error: "RESEND_API_KEY / RESEND_FROM_DOMAIN missing" };
  }

  // ── Load snapshot ────────────────────────────────────────────────────────
  const snap = await loadLatestSnapshot(env.ARCHIVE);
  if (!snap) {
    return { kind: "error", error: "snapshot missing" };
  }

  // ── Recipient resolution ─────────────────────────────────────────────────
  const rawRecipients = snap.settings.evening_email_recipients;
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
    return { kind: "error", error: "recipient missing: no evening_email_recipients in snapshot and BRIEFING_EMAIL_TO is unset" };
  }

  // ── Since timestamp ──────────────────────────────────────────────────────
  const sinceSnapshot = snap.settings.last_digest_sent_at ?? defaultSince();

  // ── Articles ─────────────────────────────────────────────────────────────
  const articlesInWindow = filterSinceArticles(
    snap.recentArticlesMeta as RecentArticleMeta[],
    sinceSnapshot,
  );

  // ── Anomaly block (schemaVersion 3 only) ─────────────────────────────────
  let anomalyBlock = "";
  if (
    snap.schemaVersion >= 3 &&
    snap.vanguardHoldings &&
    snap.vanguardHoldings.length > 0 &&
    snap.securityBetas &&
    snap.securityBetas.length > 0
  ) {
    try {
      const flags = await computeAnomaliesFromSnapshot(
        snap.vanguardHoldings,
        snap.securityBetas,
      );
      if (flags && flags.length > 0) {
        anomalyBlock = formatAnomalyBlock(flags);
      }
    } catch (err) {
      console.warn("[fallback-evening] anomaly computation failed:", err);
      // gracefully omit — don't fail the whole email
    }
  }

  // ── Body: synthesis or per-source ────────────────────────────────────────
  let body = "";
  if (articlesInWindow.length >= 5) {
    const synthesized = await synthesizeViaAI(env, articlesInWindow, snap);
    body = synthesized ?? renderPerSource(articlesInWindow);
  } else {
    body = renderPerSource(articlesInWindow);
  }

  // ── Assemble full markdown ────────────────────────────────────────────────
  const sections = [anomalyBlock, body].filter((s) => s && s.trim().length > 0);
  const fullMd = sections.join("\n\n---\n\n").trim();

  if (!fullMd) {
    return { kind: "skipped", reason: "no content" } as FallbackResult & { reason: string };
  }

  // ── HTML + subject ────────────────────────────────────────────────────────
  const now = new Date();
  const title = `Evening Recap — ${formatDateForTitle(now)}`;
  const footer = `(fallback delivery, state snapshot ${snap.snapshotDate}) — Mac was offline.`;
  const html = briefingToHtml(fullMd, title, footer);

  if (opts.dryRun) {
    return { kind: "success", htmlLength: html.length };
  }

  const send = await sendEmail(env, {
    to: recipient,
    subject: `📊 ${title}`,
    html,
    fromLocalPart: "evening",
  });

  return { kind: "success", sentMessageId: send.id };
}
