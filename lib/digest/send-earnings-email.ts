import type Anthropic from "@anthropic-ai/sdk";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { sendEmail } from "@/lib/email";
import { getRawAnthropicClient } from "@/lib/ai/provider";
import { resolveFeatureModel } from "@/lib/ai/models";
import { stripModelPreamble } from "@/lib/ai/strip-preamble";
import {
  formatPositionPresence,
  formatCombinedExposurePresence,
} from "@/lib/digest/presence-only-position";
import { formatLargeUSD } from "@/lib/format";
import { parseFinnhubFigure } from "@/lib/format/finnhub-figure";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { listPressReleases } from "@/lib/queries/press-releases";
import {
  getRecommendationHistory,
  getPriceTarget,
  getRatingChanges,
} from "@/lib/queries/analyst-estimates";
import { getCachedTranscript } from "@/lib/queries/transcripts";
import { getNotesForFamily, type NoteWithContext } from "@/lib/queries/notes";
import { getBogeysForEvent, type EarningsBogey } from "@/lib/queries/earnings-bogeys";
import { getReadThroughsForTargets } from "@/lib/queries/read-through-pairs";
import {
  getCallNoteForEvent,
  getLatestCallNoteForFamily,
  type EarningsCallNote,
} from "@/lib/queries/earnings-call-notes";
import { addDays } from "@/lib/calendar/date-utils";
import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot";
import type { CalendarEvent, EarningsTranscript } from "@/lib/types";
import { isPlausibleEarnings } from "@/lib/earnings/plausibility";
import { getIntelForEvents, getReportHistoryForFamily } from "@/lib/queries/earnings-intel";
import { summarizeHistory, type HistorySummary } from "@/lib/earnings/report-history";
import { ensureIntelForEvents } from "@/lib/earnings/intel";
import type { ReportHistoryRow } from "@/lib/mutations/earnings-intel";
import { classifyEdition } from "@/lib/digest/editions";

const ARTICLE_BODY_CAP = 8_000;
const TOTAL_CONTEXT_CAP = 80_000;

export class EarningsEmailError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Benign 409 coordination outcomes the sweep should log as skips. */
    public readonly code?: "claim_held" | "not_ready",
  ) {
    super(message);
    this.name = "EarningsEmailError";
  }
}

export interface SendEarningsEmailOpts {
  recipient?: string;
  footerNote?: string;
}

export interface SendEarningsEmailResult {
  success: true;
  eventId: number;
  symbol: string;
  phase: "preview" | "recap";
  sentTo: string;
  title: string;
  modelOutputChars: number;
}

// ── Public entry points ────────────────────────────────────────────

export async function sendEarningsPreview(
  db: Database.Database,
  eventId: number,
  opts: SendEarningsEmailOpts = {},
): Promise<SendEarningsEmailResult> {
  return sendEarningsEmail(db, eventId, "preview", opts);
}

export async function sendEarningsRecap(
  db: Database.Database,
  eventId: number,
  opts: SendEarningsEmailOpts = {},
): Promise<SendEarningsEmailResult> {
  return sendEarningsEmail(db, eventId, "recap", opts);
}

// ── Earnings-intelligence view (Task 7) ────────────────────────────
//
// Read-only projection over the earnings-intel cache (implied move from
// `earnings_intel`) + the report-history cache (`earnings_report_history`)
// for a single event/symbol. Consumed by the scoreboard (implied-move +
// history-summary rows), the "## Past prints" block (preview email body +
// preview prompt), and the in-app viewer route — all three must render the
// same numbers, so they all call this one loader rather than re-querying.
//
// Pure DB reads — never throws (getIntelForEvents/getReportHistoryForFamily
// are plain SELECTs); callers that want it best-effort still wrap the call
// (see composeEarningsEmail) because a future change to these queries should
// never be able to block a send.
export interface EarningsIntelView {
  impliedMovePct: number | null;
  impliedMethod: "straddle" | "iv_approx" | null;
  expiryUsed: string | null;
  history: ReportHistoryRow[];
  summary: HistorySummary;
}

export function loadIntelView(
  db: Database.Database,
  eventId: number,
  symbol: string,
): EarningsIntelView {
  const intel = getIntelForEvents(db, [eventId]).get(eventId) ?? null;
  const history = getReportHistoryForFamily(db, symbol, 8);
  return {
    impliedMovePct: intel?.impliedMovePct ?? null,
    impliedMethod: intel?.impliedMethod ?? null,
    expiryUsed: intel?.expiryUsed ?? null,
    history,
    summary: summarizeHistory(history),
  };
}

/**
 * Composer-only path: build context, render prompt, run Claude, assemble
 * markdown + HTML. Does NOT send email and does NOT write the audit row.
 *
 * Shared between the email-send path (`sendEarningsEmail`) and the in-app
 * preview path (`/api/earnings/recap-modal`) so the rendered output is
 * byte-identical between "what the email looks like" and "what the user
 * sees on the dashboard before sending".
 */
export interface ComposeEarningsResult {
  symbol: string;
  title: string;
  markdown: string;
  aiMarkdown: string;
  html: string;
  promptHash: string;
}

export async function composeEarningsEmail(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
  opts: { footerNote?: string } = {},
): Promise<ComposeEarningsResult> {
  const event = getEventByIdRow(db, eventId);
  if (!event) {
    throw new EarningsEmailError(`Event ${eventId} not found.`, 404);
  }
  if (event.event_type !== "earnings") {
    throw new EarningsEmailError(
      `Event ${eventId} is not an earnings event (event_type=${event.event_type}).`,
      400,
    );
  }
  if (!event.symbol) {
    throw new EarningsEmailError(`Event ${eventId} has no symbol.`, 400);
  }

  // Defensive guard: never compose a recap when actuals haven't landed.
  // Better no output than wrong numbers — the caller can re-run once
  // enrichment completes (manual override via POST /api/earnings/actuals
  // also unblocks).
  if (phase === "recap" && !event.actual_value) {
    throw new EarningsEmailError(
      `Event ${eventId} (${event.symbol}) has no actual_value yet — recap deferred until enrichment lands or POST /api/earnings/actuals overrides.`,
      409,
      "not_ready",
    );
  }

  const symbol = event.symbol.toUpperCase();

  // Earnings-intelligence tier (Task 6/7): refresh the implied-move +
  // history cache on every PREVIEW compose (forceFresh — the preview is the
  // one send where fresh options pricing/history matters; recap just reads
  // whatever's cached). Best-effort by contract (ensureIntelForEvents never
  // throws internally per its own doc comment) — wrapped here too so a
  // future change to that contract can never block the claim-mutexed send
  // path below. `!event.actual_value` (2026-07-23, IMAX): a wrong-slot
  // preview candidate that reaches this far (e.g. the sweep guard's
  // best-effort layers both missed) must never force-refresh — that would
  // overwrite the preview-time "priced-in" anchor with post-print
  // crushed-IV pricing shown as the expected move.
  if (phase === "preview" && !event.actual_value) {
    try {
      await ensureIntelForEvents(
        db,
        [{ id: event.id, symbol, event_date: event.event_date, event_time: event.event_time }],
        { forceFresh: true },
      );
    } catch (err) {
      console.warn(`[earnings-intel] ensureIntelForEvents failed for event ${eventId} (${symbol}):`, err);
    }
  }

  let intelView: EarningsIntelView | null = null;
  try {
    intelView = loadIntelView(db, event.id, symbol);
  } catch (err) {
    console.warn(`[earnings-intel] loadIntelView failed for event ${eventId} (${symbol}):`, err);
  }

  const ctx =
    phase === "preview"
      ? buildPreviewContext(db, event)
      : buildRecapContext(db, event);
  const prompt =
    phase === "preview"
      ? renderPreviewPrompt(ctx)
      : renderRecapPrompt(ctx as RecapContext);

  const headlineTable = renderHeadlineTable(ctx.event, ctx.symbol, phase, intelView);
  const aiMarkdown = await callClaude(prompt, phase);
  // Headline scoreboard is rendered deterministically from structured
  // fields (consensus_estimate, actual_value, reaction_snapshot) — printable
  // + same shape across preview + recap. AI takes over after for line-by-line
  // + prose. "## Past prints" is preview-only (code-rendered, never
  // AI-generated) — the recap doesn't repeat it.
  const pastPrintsBlock =
    phase === "preview" ? renderPastPrintsBlock(intelView?.history ?? []) : "";
  const markdown = pastPrintsBlock
    ? `${headlineTable}\n\n${pastPrintsBlock}\n\n${aiMarkdown}`
    : `${headlineTable}\n\n${aiMarkdown}`;

  const dateStr = formatDateLong(event.event_date);
  const releaseTimeStr = event.release_time ? ` ${event.release_time} ET` : "";
  const phaseLabel = phase === "preview" ? "Earnings Preview" : "Earnings Recap";
  const title = `${symbol} ${phaseLabel} — ${dateStr}${releaseTimeStr}`;
  const html = briefingToHtml(markdown, title, opts.footerNote);

  return {
    symbol,
    title,
    markdown,
    aiMarkdown,
    html,
    promptHash: hashPrompt(prompt),
  };
}

async function sendEarningsEmail(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
  opts: SendEarningsEmailOpts,
): Promise<SendEarningsEmailResult> {
  const recipient = opts.recipient || process.env.BRIEFING_EMAIL_TO;
  if (!recipient) {
    throw new EarningsEmailError(
      "No recipient. Set BRIEFING_EMAIL_TO env var or pass 'recipient'.",
      400,
    );
  }

  const claim = claimEarningsEmailSlot(db, eventId, phase, recipient);
  if (!claim.claimed) {
    throw new EarningsEmailError(
      `Event ${eventId} ${phase} is already being sent by another process — skipping duplicate.`,
      409,
      "claim_held",
    );
  }

  let composed: ComposeEarningsResult;
  try {
    composed = await composeEarningsEmail(db, eventId, phase, {
      footerNote: opts.footerNote,
    });

    const phaseEmoji = phase === "preview" ? "\u{1F50D}" : "\u{1F4CA}";
    try {
      await sendEmail({
        to: recipient,
        subject: `${phaseEmoji} ${composed.title}`,
        html: composed.html,
        fromLocalPart: "earnings",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new EarningsEmailError(`Send failed: ${msg}`, 500);
    }
  } catch (err) {
    // A fresh claim must not survive a failed compose/send — the next sweep
    // tick should retry. (Refire mode never wrote a claim row.)
    if (claim.mode === "fresh" && claim.token) {
      releaseEarningsEmailClaim(db, eventId, phase, claim.token);
    }
    throw err;
  }

  // Audit row for the EarningsHub UI status chips + Phase-3 cron dedup.
  // UNIQUE(event_id, phase) — re-fires update in place rather than fail.
  // This upsert converts the 'in_progress' claim row into the completed row
  // (or, for a manual refire, overwrites the prior completed row in place).
  recordEarningsEmailAudit(db, {
    eventId,
    phase,
    recipient,
    aiInputHash: composed.promptHash,
    aiOutputMd: composed.aiMarkdown,
    error: null,
  });

  return {
    success: true,
    eventId,
    symbol: composed.symbol,
    phase,
    sentTo: recipient,
    title: composed.title,
    modelOutputChars: composed.markdown.length,
  };
}

// ── Cross-process send claims ──────────────────────────────────────
//
// The launchd shell has a curl timeout + tsx fallback chain; on a heavy tick
// the fallback re-runs the sweep while the first invocation is still
// composing (60-180s per Claude call), and audit rows land only post-send —
// so in-flight candidates used to send twice (audit 2026-07-04, bug B3).
// The UNIQUE(event_id, phase) constraint doubles as a cross-process mutex:
// claim the slot with error='in_progress' BEFORE composing. States:
//   error='in_progress'   → claim held by a live send (or a crashed one; reaped after 30 min)
//   error='sent-by-cloud' → Worker fallback delivered (email-sweep.ts writes these)
//   error IS NULL         → completed local send
// A failed send releases its fresh claim so the next tick retries.
//
// Note for future readers: `error` stores non-error states too
// ('in_progress', 'sent-by-cloud') — don't treat `error IS NOT NULL` as a
// failure signal; those two sentinels must be checked explicitly.

const CLAIM_STALE_MINUTES = 30;

export function claimEarningsEmailSlot(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
  recipient: string,
): { claimed: boolean; mode: "fresh" | "refire"; token?: string; reason?: "in_progress" } {
  const token = randomUUID();
  const ins = db
    .prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error, claim_token)
       VALUES (?, ?, ?, datetime('now'), NULL, NULL, 'in_progress', ?)
       ON CONFLICT(event_id, phase) DO NOTHING`,
    )
    .run(eventId, phase, recipient, token);
  if (ins.changes === 1) return { claimed: true, mode: "fresh", token };

  const existing = db
    .prepare(
      `SELECT error FROM earnings_emails WHERE event_id = ? AND phase = ?`,
    )
    .get(eventId, phase) as { error: string | null } | undefined;

  if (existing?.error === "in_progress") {
    // Take over only if the holder looks dead (claim older than the stale cutoff).
    const takeover = db
      .prepare(
        `UPDATE earnings_emails
            SET sent_at = datetime('now'), recipient = ?, claim_token = ?
          WHERE event_id = ? AND phase = ? AND error = 'in_progress'
            AND datetime(sent_at) <= datetime('now', '-${CLAIM_STALE_MINUTES} minutes')`,
      )
      .run(recipient, token, eventId, phase);
    if (takeover.changes === 1) return { claimed: true, mode: "fresh", token };
    return { claimed: false, mode: "fresh", reason: "in_progress" };
  }

  // Completed row (local send or cloud-sent placeholder): this is a manual
  // re-fire — allowed; the final audit upsert overwrites in place.
  return { claimed: true, mode: "refire" };
}

export function releaseEarningsEmailClaim(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
  token: string,
): void {
  // Token-conditional: a late finisher must not delete a successor's
  // takeover claim (migration 063).
  db.prepare(
    `DELETE FROM earnings_emails
      WHERE event_id = ? AND phase = ? AND error = 'in_progress' AND claim_token = ?`,
  ).run(eventId, phase, token);
}

export function reapStaleEarningsEmailClaims(db: Database.Database): number {
  return db
    .prepare(
      `DELETE FROM earnings_emails
        WHERE error = 'in_progress'
          AND datetime(sent_at) <= datetime('now', '-${CLAIM_STALE_MINUTES} minutes')`,
    )
    .run().changes;
}

// ── Calendar event helper ──────────────────────────────────────────

function getEventByIdRow(
  db: Database.Database,
  id: number,
): CalendarEvent | null {
  return (
    (db
      .prepare(`SELECT * FROM calendar_events WHERE id = ?`)
      .get(id) as CalendarEvent | undefined) ?? null
  );
}

// ── Audit row writer ───────────────────────────────────────────────

interface AuditInput {
  eventId: number;
  phase: "preview" | "recap";
  recipient: string;
  aiInputHash: string;
  aiOutputMd: string;
  error: string | null;
}

function recordEarningsEmailAudit(
  db: Database.Database,
  input: AuditInput,
): void {
  // ON CONFLICT updates in place — a re-fire (manual or cron) overwrites the
  // previous row's sent_at + ai_output_md. The Phase-3 cron sweep checks
  // `WHERE NOT EXISTS (SELECT 1 FROM earnings_emails ...)` to skip events
  // already audited, so a successful row here is the dedup floor.
  db
    .prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_input_hash, ai_output_md, error)
       VALUES (?, ?, ?, datetime('now'), ?, ?, ?)
       ON CONFLICT(event_id, phase) DO UPDATE SET
         recipient = excluded.recipient,
         sent_at = excluded.sent_at,
         ai_input_hash = excluded.ai_input_hash,
         ai_output_md = excluded.ai_output_md,
         error = excluded.error`,
    )
    .run(
      input.eventId,
      input.phase,
      input.recipient,
      input.aiInputHash,
      input.aiOutputMd,
      input.error,
    );
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

// ── Context builders ───────────────────────────────────────────────

interface PositionEntry {
  account_name: string;
  symbol: string;
  quantity: number;
  cost_basis: number | null;
  as_of_date: string;
  latest_price: number | null;
  // Option-specific (null for stock/ETF/MF)
  security_type: string;
  underlying_symbol: string | null;
  option_type: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  multiplier: number | null;
}

export interface NewsletterEntry {
  source_name: string;
  subject: string;
  received_at: string;
  body: string;
  sentiment: string | null;
  sentiment_score: number | null;
  source_id: number;
  earnings_rank: number | null;
  earnings_note: string | null;
}

interface PreviewContext {
  symbol: string;
  family: readonly string[];
  event: CalendarEvent;
  positions: PositionEntry[];
  // Long/short breakdowns (signed totals are NOT exposed to the prompt; see
  // formatCombinedExposurePresence). Stock shares + option contracts split by
  // direction so the summary line can say "500 long shares + 3 long option
  // contract(s)" without leaking notional dollar exposure.
  longShares: number;
  shortShares: number;
  longContracts: number;
  shortContracts: number;
  userNotes: NoteWithContext[];
  recentArticles: NewsletterEntry[];
  recommendationTrend: string | null;
  priceTarget: string | null;
  ratingChanges: string | null;
  recentPressReleases: string | null;
  priorTranscript: EarningsTranscript | null;
  bogeys: EarningsBogey[];
  readThroughs: ReadThroughEntry[];
  priorCallNote: EarningsCallNote | null;
  // Earnings-intelligence tier (Task 7). Optional + best-effort: absent
  // (undefined) when the intel/history queries error, never blocks context
  // build. Drives the "## Past prints" prompt block; the scoreboard rows
  // are wired independently in composeEarningsEmail via loadIntelView.
  intel?: EarningsIntelView;
}

/**
 * One per (reporter symbol → this target) where the reporter has already
 * printed within the 14-day window AND has both an actual_value and a
 * reaction_snapshot captured. Built from `read_through_pairs` joined to
 * `calendar_events`. Drives the "## Read-throughs" preview-prompt block.
 *
 * Reporters lacking actual or reaction are silently dropped — the rendered
 * bullet is only useful when both data points exist (per design doc §4
 * edge cases).
 */
export interface ReadThroughEntry {
  reporter: string;
  reporterEventDate: string;
  hypothesis: string | null;
  weight: number;
  consensusEps: number | null;
  consensusRev: number | null;
  actualEps: number | null;
  actualRev: number | null;
  reactionStockPct: number | null;
  reactionSpyPct: number | null;
  reactionQqqPct: number | null;
}

interface RecapContext extends PreviewContext {
  reactionSnapshotMarkdown: string | null;
  freshPressReleases: string | null;
  callNote: EarningsCallNote | null;
}

function buildPreviewContext(
  db: Database.Database,
  event: CalendarEvent,
): PreviewContext {
  const symbol = event.symbol!.toUpperCase();
  const family = issuerSiblings(symbol);

  const positions = getCrossAccountPositions(db, family);
  let longShares = 0;
  let shortShares = 0;
  let longContracts = 0;
  let shortContracts = 0;
  for (const p of positions) {
    const isOption = p.security_type.toLowerCase() === "option";
    if (isOption) {
      if (p.quantity > 0) longContracts += p.quantity;
      else shortContracts += Math.abs(p.quantity);
    } else {
      if (p.quantity > 0) longShares += p.quantity;
      else shortShares += Math.abs(p.quantity);
    }
  }

  const userNotes = getNotesForFamily(db, family, 90);
  const recentArticles = getNewsletterContext(db, family);
  const recommendationTrend = formatRecommendationTrend(db, symbol);
  const priceTarget = formatPriceTarget(db, symbol);
  const ratingChanges = formatRatingChanges(db, symbol);
  const recentPressReleases = formatPressReleases(db, family, 30, 8);
  const priorTranscript = findPriorTranscript(db, symbol, event.event_date);
  const bogeys = getBogeysForEvent(db, event.id);
  const readThroughs = buildReadThroughEntries(db, family, event.event_date);
  const priorCallNote = getLatestCallNoteForFamily(db, symbol, event.event_date);
  let intel: EarningsIntelView | undefined;
  try {
    intel = loadIntelView(db, event.id, symbol);
  } catch (err) {
    console.warn(`[earnings-intel] loadIntelView failed for event ${event.id} (${symbol}):`, err);
  }

  return {
    symbol,
    family,
    event,
    positions,
    longShares,
    shortShares,
    longContracts,
    shortContracts,
    userNotes,
    recentArticles,
    recommendationTrend,
    priceTarget,
    ratingChanges,
    recentPressReleases,
    priorTranscript,
    bogeys,
    readThroughs,
    priorCallNote,
    intel,
  };
}

/**
 * Build read-through entries for a target's preview prompt.
 *
 * For every pair where a member of `family` is the target symbol, find the
 * most recent `calendar_events` row for that pair's reporter symbol whose
 * event_date sits inside [eventDate − 14d, eventDate]. Both `actual_value`
 * AND `reaction_snapshot` must be populated — without the reaction, the
 * read-through bullet would render with empty post-print color and add
 * noise rather than signal.
 *
 * Sorted by pair weight desc so high-conviction reporters lead the prompt.
 * Deduped per reporter (a single reporter never appears twice even if it
 * targets multiple sibling-class members of the family).
 */
export function buildReadThroughEntries(
  db: Database.Database,
  family: readonly string[],
  eventDate: string,
): ReadThroughEntry[] {
  const familyUpper = Array.from(new Set(family.map((s) => s.toUpperCase())));
  const pairs = getReadThroughsForTargets(db, familyUpper);
  if (pairs.length === 0) return [];

  // Per-reporter metadata. If a single reporter targets multiple family
  // members (dual-class siblings), keep the highest-weight pair's hypothesis.
  const reporterMeta = new Map<
    string,
    { hypothesis: string | null; weight: number }
  >();
  for (const p of pairs) {
    const sym = p.reporter_symbol.toUpperCase();
    const existing = reporterMeta.get(sym);
    if (!existing || p.weight > existing.weight) {
      reporterMeta.set(sym, { hypothesis: p.hypothesis, weight: p.weight });
    }
  }

  const reporters = Array.from(reporterMeta.keys());
  if (reporters.length === 0) return [];

  const fromDate = addDays(eventDate, -14);
  const placeholders = reporters.map(() => "?").join(",");
  const reporterEvents = db
    .prepare(
      `SELECT *
       FROM calendar_events
       WHERE event_type = 'earnings'
         AND UPPER(symbol) IN (${placeholders})
         AND event_date BETWEEN ? AND ?
         AND actual_value IS NOT NULL
         AND reaction_snapshot IS NOT NULL
       ORDER BY event_date DESC`,
    )
    .all(...reporters, fromDate, eventDate) as CalendarEvent[];

  // Dedup: keep the most-recent print per reporter symbol.
  const seen = new Set<string>();
  const entries: ReadThroughEntry[] = [];
  for (const ev of reporterEvents) {
    const sym = (ev.symbol ?? "").toUpperCase();
    if (!sym || seen.has(sym)) continue;
    const meta = reporterMeta.get(sym);
    if (!meta) continue; // Belt-and-braces — should not happen given the IN clause.
    seen.add(sym);

    const cons = parseFinnhubFigure(ev.consensus_estimate ?? ev.consensus_value);
    const act = parseFinnhubFigure(ev.actual_value);

    // Sanity guard against bogus Finnhub actuals.
    //
    // Finnhub's day-of-release earnings actual is unreliable for some large
    // names (e.g. GOOGL Q1 2026: stored EPS 5.11 against consensus 2.70 —
    // confirmed bogus, the live re-fetch returned 2.62). Including such a
    // bullet would feed Sonnet "+89% beat" garbage and corrupt the prompt
    // reasoning. Skip the reporter when the divergence is implausible:
    //   - EPS: stored magnitude ≥ 2× consensus magnitude (and consensus > 0)
    //   - Revenue: stored ≥ 1.4× consensus OR ≤ 0.7× consensus
    // Keep the reporter when either field is null — partial data is OK,
    // but a multi-x divergence is almost always a bad scrape.
    if (!isPlausibleEarnings(cons.eps, act.eps, cons.revenue, act.revenue)) {
      continue;
    }

    let stockPct: number | null = null;
    let spyPct: number | null = null;
    let qqqPct: number | null = null;
    try {
      const rs = JSON.parse(ev.reaction_snapshot!) as ReactionSnapshot;
      stockPct = rs.symbol?.delta_pct ?? null;
      spyPct = rs.spy?.delta_pct ?? null;
      qqqPct = rs.qqq?.delta_pct ?? null;
    } catch {
      // Malformed reaction_snapshot JSON — skip gracefully.
    }

    entries.push({
      reporter: sym,
      reporterEventDate: ev.event_date,
      hypothesis: meta.hypothesis,
      weight: meta.weight,
      consensusEps: cons.eps,
      consensusRev: cons.revenue,
      actualEps: act.eps,
      actualRev: act.revenue,
      reactionStockPct: stockPct,
      reactionSpyPct: spyPct,
      reactionQqqPct: qqqPct,
    });
  }

  // Per design doc §4: sort by weight desc.
  entries.sort((a, b) => b.weight - a.weight);
  return entries;
}

function buildRecapContext(
  db: Database.Database,
  event: CalendarEvent,
): RecapContext {
  const base = buildPreviewContext(db, event);

  const reactionSnapshotMarkdown = formatReactionSnapshot(event.reaction_snapshot);
  // For the recap we want every PR since the release time, not just last 30d.
  // 2 days back from now is plenty for both BMO + AMC.
  const freshPressReleases = formatPressReleases(db, base.family, 2, 12);
  const callNote = getCallNoteForEvent(db, event.id);

  return {
    ...base,
    reactionSnapshotMarkdown,
    freshPressReleases,
    callNote,
  };
}

// ── Cross-account positions ────────────────────────────────────────

export function getCrossAccountPositions(
  db: Database.Database,
  family: readonly string[],
): PositionEntry[] {
  if (family.length === 0) return [];
  const upperFamily = family.map((s) => s.toUpperCase());
  const placeholders = upperFamily.map(() => "?").join(",");
  // Match BOTH the security's own symbol AND its underlying_symbol — the
  // latter catches option holdings whose s.symbol is OCC format
  // (e.g., "TER   280121C00180000") but underlying_symbol is "TER".
  // Without this branch, every option leg on an event symbol gets dropped.
  //
  // Cost basis fallback: TWS auto-refresh writes intra-day positions with
  // cost_basis = NULL because TWS doesn't expose that field. Statement
  // imports write the same (account, security) pair with cost_basis populated
  // on the period-end date. Pre-fix the query keyed off MAX(as_of_date) per
  // (account, security) and silently dropped cost_basis whenever a TWS row
  // existed on a later date than the most recent statement — the AI then
  // saw "cost basis ?" and hallucinated ("around your cost basis" for PRIM
  // when the user was up 115%). Now we coalesce the latest non-null
  // cost_basis from any prior row of the same (account, security) into the
  // returned row, while still picking quantity / as_of_date from MAX-date.
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, a.name AS account_name, s.symbol,
              s.security_type, s.underlying_symbol, s.option_type,
              s.strike_price, s.expiration_date, s.multiplier,
              h.quantity,
              COALESCE(
                h.cost_basis,
                (SELECT h3.cost_basis FROM holdings h3
                  WHERE h3.account_id = h.account_id
                    AND h3.security_id = h.security_id
                    AND h3.cost_basis IS NOT NULL
                  ORDER BY h3.as_of_date DESC LIMIT 1)
              ) AS cost_basis,
              h.as_of_date,
              (SELECT close_price FROM prices p
                 WHERE p.security_id = s.id
                 ORDER BY p.date DESC LIMIT 1) AS latest_price
         FROM holdings h
         JOIN accounts a ON a.id = h.account_id
         JOIN securities s ON s.id = h.security_id
         WHERE (UPPER(s.symbol) IN (${placeholders})
                OR UPPER(COALESCE(s.underlying_symbol, '')) IN (${placeholders}))
           AND h.quantity != 0
           AND h.as_of_date = (
             SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id
               AND h2.security_id = h.security_id
           )
         ORDER BY a.id, LOWER(s.security_type), s.expiration_date NULLS LAST, s.symbol`,
    )
    .all(...upperFamily, ...upperFamily) as PositionEntry[];
  return rows;
}

// ── Newsletter context ─────────────────────────────────────────────

interface CandidateRow {
  id: number;
  source_id: number;
  source_name: string;
  earnings_rank: number | null;
  earnings_note: string | null;
  subject: string;
  received_at: string;
  raw_text: string | null;
  summary: string | null;
  sentiment: string | null;
  sentiment_score: number | null;
}

const MAX_NEWSLETTER_ARTICLES = 6;
/**
 * Real-data finding (2026-07-17): one prolific ranked source (Vital
 * Knowledge, ~6 articles/week per big name) was winning every slot under
 * the plain rank-ordered fill, so lower-ranked sources — including TMT
 * Breakout's bogies coverage, this feature's motivating case — never
 * appeared. Pass 1 below enforces this cap per source; pass 2 refills any
 * still-open slots so a single-source symbol still gets full coverage
 * (there's nothing to diversify away from when only one source covers it).
 */
const MAX_ARTICLES_PER_SOURCE = 2;
const CANDIDATE_FETCH_LIMIT = 30;
/**
 * Per-source ceiling inside the candidate fetch (final-review Minor j,
 * 2026-07-17): without it, one ranked source with ≥CANDIDATE_FETCH_LIMIT
 * in-window rows consumes the whole rank-ordered pool — every other
 * source's rows are evicted at the SQL layer, distinctSources reads 1,
 * and the pass-2 single-source refill re-monopolizes all the slots.
 * Derived, not picked: MAX_NEWSLETTER_ARTICLES × 3 (max editions per ET
 * day among multi-edition sources — VK dawn/midday/recap). Edition
 * supersedence runs in JS AFTER this fetch, so the cap must leave enough
 * raw rows that a genuinely single-source symbol still yields
 * MAX_NEWSLETTER_ARTICLES usable post-supersedence articles for pass 2.
 * Because 18 < CANDIDATE_FETCH_LIMIT, a capped flooder leaves ≥12 pool
 * slots for other sources, which also keeps distinctSources truthful
 * (a 1-source pool now implies only one source actually covers the
 * family in-window).
 */
const PER_SOURCE_FETCH_CAP = MAX_NEWSLETTER_ARTICLES * 3;

/** ET calendar day of a received_at timestamp (ISO or SQLite space format, UTC). */
function receivedAtEtDay(receivedAt: string): string {
  const iso = receivedAt.includes("T")
    ? receivedAt
    : receivedAt.replace(" ", "T") + (receivedAt.endsWith("Z") ? "" : "Z");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return receivedAt.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(d);
}

/**
 * Same-source same-ET-day edition supersedence: a VK Dawn dies to the
 * Mid-Day Update (lib/digest/editions.ts). Runs BEFORE the fill loop so
 * no slot or cap budget is spent on an article we're about to discard.
 */
function dropSupersededEditions(rows: CandidateRow[]): CandidateRow[] {
  const groups = new Map<string, CandidateRow[]>();
  for (const r of rows) {
    const key = `${r.source_id}|${receivedAtEtDay(r.received_at)}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const dropped = new Set<number>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const infos = group.map((r) => ({
      r,
      info: classifyEdition(r.source_name, r.subject),
    }));
    for (const { r, info } of infos) {
      const superseded = infos.some(
        (other) =>
          other.r.id !== r.id && other.info.supersedes.includes(info.edition)
      );
      if (superseded) dropped.add(r.id);
    }
  }
  return rows.filter((r) => !dropped.has(r.id));
}

/**
 * Rank-ordered fill (spec 2026-07-17): one candidate query over ALL sources
 * carrying the source's hierarchy rank, edition supersedence, then ranked
 * sources first (rank asc, id asc on duplicate ranks) / unranked after,
 * recency desc within — unranked articles fill remaining slots instead of
 * requiring the ranked tier to be empty (the old starvation bug).
 * Exported for tests.
 */
export function getNewsletterContext(
  db: Database.Database,
  family: readonly string[],
): NewsletterEntry[] {
  if (family.length === 0) return [];
  const placeholders = family.map(() => "?").join(",");
  const upperFamily = family.map((s) => s.toUpperCase());

  const fetchWindow = (days: 7 | 30): CandidateRow[] =>
    db
      .prepare(
        `SELECT id, source_id, source_name, earnings_rank, earnings_note,
                subject, received_at, raw_text, summary,
                sentiment, sentiment_score
           FROM (
             SELECT a.id, a.source_id, rs.name AS source_name,
                    rs.earnings_rank, rs.earnings_note,
                    a.subject, a.received_at, a.raw_text, a.summary,
                    a.sentiment, a.sentiment_score,
                    ROW_NUMBER() OVER (
                      PARTITION BY a.source_id
                      ORDER BY a.received_at DESC, a.id DESC
                    ) AS src_rn
               FROM research_articles a
               JOIN research_article_securities ras ON ras.article_id = a.id
               JOIN securities s ON s.id = ras.security_id
               JOIN research_sources rs ON rs.id = a.source_id
              WHERE UPPER(s.symbol) IN (${placeholders})
                AND datetime(a.received_at) >= datetime('now', '-${days} days')
                AND a.processed_at IS NOT NULL
                AND COALESCE(a.is_relevant, 1) = 1
              GROUP BY a.id
           )
          -- Per-source ceiling BEFORE the pool limit: one prolific source
          -- must not consume the whole rank-ordered pool (see the
          -- PER_SOURCE_FETCH_CAP constant comment).
          WHERE src_rn <= ${PER_SOURCE_FETCH_CAP}
          -- Pre-filter must stay rank-aware to agree with the JS comparator
          -- below: a recency-only ORDER BY here would let a flood of
          -- unranked articles evict a ranked source's older in-window
          -- article before the LIMIT ever reaches the JS sort.
          ORDER BY (earnings_rank IS NULL) ASC, earnings_rank ASC, received_at DESC
          LIMIT ${CANDIDATE_FETCH_LIMIT}`,
      )
      .all(...upperFamily) as CandidateRow[];

  // 7-day window; zero candidates → 30-day backstop (old tier-2 semantics).
  let rows = fetchWindow(7);
  if (rows.length === 0) rows = fetchWindow(30);

  rows = dropSupersededEditions(rows);

  const UNRANKED = Number.MAX_SAFE_INTEGER;
  rows.sort((a, b) => {
    const ra = a.earnings_rank ?? UNRANKED;
    const rb = b.earnings_rank ?? UNRANKED;
    if (ra !== rb) return ra - rb;
    // Duplicate ranks across two sources: deterministic source id tie-break.
    if (ra !== UNRANKED && a.source_id !== b.source_id)
      return a.source_id - b.source_id;
    const ta = a.received_at;
    const tb = b.received_at;
    if (ta !== tb) return ta < tb ? 1 : -1; // recency desc
    return b.id - a.id;
  });

  let totalChars = 0;
  const selectedIds = new Set<number>();
  const perSourceCount = new Map<number, number>();
  const bodyById = new Map<number, string>();

  function bodyFor(r: CandidateRow): string {
    let cached = bodyById.get(r.id);
    if (cached === undefined) {
      const fullText = r.raw_text || r.summary || "";
      cached =
        fullText.length > ARTICLE_BODY_CAP
          ? fullText.slice(0, ARTICLE_BODY_CAP) + "\n[...truncated...]"
          : fullText;
      bodyById.set(r.id, cached);
    }
    return cached;
  }

  /**
   * Attempts to admit one row into the selection against the running
   * char/slot budget. Truncation + char accounting happen here exactly
   * once per selected row, shared by both passes below. Returns false when
   * either hard limit (slot count or TOTAL_CONTEXT_CAP) is hit — the caller
   * should stop walking immediately, same "break" semantics the original
   * single-pass loop had.
   */
  function tryAdmit(r: CandidateRow): boolean {
    if (selectedIds.size >= MAX_NEWSLETTER_ARTICLES) return false;
    const body = bodyFor(r);
    if (totalChars + body.length > TOTAL_CONTEXT_CAP) return false;
    totalChars += body.length;
    selectedIds.add(r.id);
    perSourceCount.set(r.source_id, (perSourceCount.get(r.source_id) ?? 0) + 1);
    return true;
  }

  // Pass 1: diversity-capped walk — skip (not stop on) any row whose source
  // has already hit MAX_ARTICLES_PER_SOURCE, so a later-ranked source's rows
  // still get a look.
  for (const r of rows) {
    if ((perSourceCount.get(r.source_id) ?? 0) >= MAX_ARTICLES_PER_SOURCE) continue;
    if (!tryAdmit(r)) break;
  }

  // Pass 2: refill only when this symbol's ENTIRE candidate pool is a
  // single source — the "single-source symbol still gets full coverage"
  // case from the constant comment above. When 2+ distinct sources cover
  // the symbol, leaving slots under MAX_NEWSLETTER_ARTICLES unfilled is the
  // diversity cap working as intended, not a bug: refilling from the
  // already-capped majority source would silently undo pass 1's whole
  // point (the real-data monopolization finding this amendment fixes).
  const distinctSources = new Set(rows.map((r) => r.source_id)).size;
  if (distinctSources === 1 && selectedIds.size < MAX_NEWSLETTER_ARTICLES) {
    for (const r of rows) {
      if (selectedIds.has(r.id)) continue;
      if (!tryAdmit(r)) break;
    }
  }

  // Selection order is inherited from `rows` (already trust-ordered), not
  // re-derived — pass 2 can admit rows out of walk order relative to pass
  // 1's skips, so we filter the original sorted array rather than sort the
  // result again.
  return rows
    .filter((r) => selectedIds.has(r.id))
    .map((r) => ({
      source_name: r.source_name,
      subject: r.subject,
      received_at: r.received_at,
      body: bodyFor(r),
      sentiment: r.sentiment,
      sentiment_score: r.sentiment_score,
      source_id: r.source_id,
      earnings_rank: r.earnings_rank,
      earnings_note: r.earnings_note,
    }));
}

// ── Analyst formatters ─────────────────────────────────────────────

function formatRecommendationTrend(
  db: Database.Database,
  symbol: string,
): string | null {
  const history = getRecommendationHistory(db, symbol, 6);
  if (history.length === 0) return null;
  const lines = history.map((r) => {
    const total = r.strong_buy + r.buy + r.hold + r.sell + r.strong_sell;
    return `- ${r.period}: ${r.strong_buy} SB / ${r.buy} B / ${r.hold} H / ${r.sell} S / ${r.strong_sell} SS (n=${total})`;
  });
  return lines.join("\n");
}

function formatPriceTarget(
  db: Database.Database,
  symbol: string,
): string | null {
  const target = getPriceTarget(db, symbol);
  if (!target) return null;
  if (
    target.target_mean == null &&
    target.target_high == null &&
    target.target_low == null
  ) {
    return null;
  }
  const parts: string[] = [];
  if (target.target_mean != null) parts.push(`mean $${target.target_mean.toFixed(2)}`);
  if (target.target_median != null) parts.push(`median $${target.target_median.toFixed(2)}`);
  if (target.target_high != null) parts.push(`high $${target.target_high.toFixed(2)}`);
  if (target.target_low != null) parts.push(`low $${target.target_low.toFixed(2)}`);
  if (target.number_of_analysts != null) parts.push(`n=${target.number_of_analysts}`);
  return parts.join(" · ");
}

function formatRatingChanges(
  db: Database.Database,
  symbol: string,
): string | null {
  const changes = getRatingChanges(db, symbol, 8);
  if (changes.length === 0) return null;
  const lines = changes.map((c) => {
    const firm = c.firm || "unnamed firm";
    const fromTo = c.from_grade ? `${c.from_grade} → ${c.to_grade}` : c.to_grade;
    const action = c.action ? ` [${c.action}]` : "";
    return `- ${c.rating_date.slice(0, 10)}: ${firm}: ${fromTo}${action}`;
  });
  return lines.join("\n");
}

// ── Press release formatter ────────────────────────────────────────

function formatPressReleases(
  db: Database.Database,
  family: readonly string[],
  daysBack: number,
  limit: number,
): string | null {
  const out: string[] = [];
  for (const sym of family) {
    const prs = listPressReleases(db, {
      symbol: sym,
      days_back: daysBack,
      limit,
    });
    for (const pr of prs) {
      const summary = pr.summary && pr.summary.length > 800
        ? pr.summary.slice(0, 800) + "…"
        : pr.summary || "";
      out.push(
        `- [${pr.published_at.slice(0, 16).replace("T", " ")}] (${pr.source || "?"}) ${pr.headline}${summary ? `\n  ${summary}` : ""}`,
      );
    }
  }
  if (out.length === 0) return null;
  return out.slice(0, limit).join("\n");
}

// ── Prior-quarter transcript ───────────────────────────────────────

function findPriorTranscript(
  db: Database.Database,
  symbol: string,
  eventDate: string,
): EarningsTranscript | null {
  // Try the obvious prior quarter first, then walk back two.
  const date = new Date(eventDate + "T00:00:00Z");
  const month = date.getUTCMonth() + 1; // 1..12
  const year = date.getUTCFullYear();
  // Map current event-month to prior-quarter (year, quarter).
  let priorQ: number;
  let priorY: number;
  if (month <= 3) {
    priorQ = 4;
    priorY = year - 1;
  } else if (month <= 6) {
    priorQ = 1;
    priorY = year;
  } else if (month <= 9) {
    priorQ = 2;
    priorY = year;
  } else {
    priorQ = 3;
    priorY = year;
  }
  return (
    getCachedTranscript(db, symbol, priorY, priorQ) ||
    getCachedTranscript(db, symbol, priorY - (priorQ === 1 ? 1 : 0), ((priorQ + 2) % 4) + 1)
  );
}

// ── Reaction snapshot formatter ────────────────────────────────────

export function formatReactionSnapshot(json: string | null): string | null {
  if (!json) return null;
  try {
    const snap = JSON.parse(json) as {
      t0_utc?: string;
      window_min?: number;
      source?: string;
      spy?: { delta_pct?: number };
      qqq?: { delta_pct?: number };
      tlt?: { delta_pct?: number };
      sector?: { symbol?: string; delta_pct?: number };
      symbol?: { symbol?: string; delta_pct?: number };
    };
    const lines: string[] = [];
    const win = snap.window_min ?? 120;
    lines.push(`- Window: T+${win} minutes from release (source: ${snap.source ?? "?"})`);
    if (snap.symbol && snap.symbol.delta_pct != null) {
      lines.push(`- ${snap.symbol.symbol ?? "stock"}: ${pctSign(snap.symbol.delta_pct)}`);
    }
    if (snap.spy?.delta_pct != null) lines.push(`- SPY: ${pctSign(snap.spy.delta_pct)}`);
    if (snap.qqq?.delta_pct != null) lines.push(`- QQQ: ${pctSign(snap.qqq.delta_pct)}`);
    if (snap.tlt?.delta_pct != null) lines.push(`- TLT: ${pctSign(snap.tlt.delta_pct)}`);
    if (snap.sector && snap.sector.delta_pct != null) {
      lines.push(`- ${snap.sector.symbol ?? "sector ETF"}: ${pctSign(snap.sector.delta_pct)}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

function pctSign(v: number): string {
  // delta_pct arrives already in percent (matchBarsToReaction multiplies by
  // 100 at capture time) — format as-is.
  const n = v.toFixed(2);
  return v >= 0 ? `+${n}%` : `${n}%`;
}

// ── Deterministic headline scoreboard ──────────────────────────────
//
// A markdown table at the very top of every earnings email — same shape
// across preview + recap so the user can print the preview, sit through
// the call, and fill in the right-hand columns by hand. Recap fills the
// same cells in automatically. Built from structured fields only:
// `consensus_estimate`, `actual_value`, `reaction_snapshot`. Anything we
// don't have lands as `—` (the HTML renderer detects this and pads the
// cell taller for handwriting).

function formatRevenueDisplay(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return formatLargeUSD(n);
}

function formatPctDelta(actual: number, consensus: number): string {
  if (consensus === 0) return "—";
  const pct = ((actual - consensus) / Math.abs(consensus)) * 100;
  const abs = Math.abs(pct);
  if (abs < 0.05) return "in-line";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

// Raw numeric sibling of readReactionDelta — same parsing, no formatting.
// Used by the scoreboard's implied-vs-realized "expected move" row, which
// needs the number to compare against `intel.impliedMovePct`, not just a
// pre-formatted display string.
function readReactionPct(json: string | null, key: "spy" | "qqq" | "tlt" | "symbol"): number | null {
  if (!json) return null;
  try {
    const snap = JSON.parse(json) as Record<string, unknown>;
    const node = snap[key] as { delta_pct?: number } | undefined;
    if (!node || node.delta_pct == null) return null;
    const v = Number(node.delta_pct);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function readReactionDelta(json: string | null, key: "spy" | "qqq" | "tlt" | "symbol"): string {
  const v = readReactionPct(json, key);
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

// ── Earnings-intelligence scoreboard rows (Task 7) ─────────────────
//
// "Expected move (options)" + "Avg move last 8 prints" rows. Both are
// code-rendered from the EarningsIntelView cache — never AI-generated —
// same discipline as the rest of the scoreboard.

function fmtExpiryShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtImplied(intel: EarningsIntelView | null | undefined): string {
  if (!intel || intel.impliedMovePct == null || !intel.impliedMethod) return "—";
  const pct = intel.impliedMovePct.toFixed(1);
  return intel.impliedMethod === "straddle"
    ? `±${pct}% (straddle, ${fmtExpiryShort(intel.expiryUsed)} exp)`
    : `~±${pct}% (IV approx)`;
}

function fmtHistSummary(intel: EarningsIntelView | null | undefined): string {
  const s = intel?.summary;
  if (!s || s.avgAbsMovePct == null) return "—";
  const denom = s.beatCount + s.missCount;
  const beat = denom > 0 ? ` · beat ${s.beatCount}/${denom}` : "";
  return `±${s.avgAbsMovePct.toFixed(1)}%${beat}`;
}

// Deterministic, code-rendered — no AI involvement, same discipline as the
// scoreboard. Preview-only consumer (email body right after the scoreboard,
// and the preview prompt after the bogeys block): "" (empty string) when
// there's no history yet, so callers can splice it in unconditionally
// without producing an empty "## Past prints" section.
export function renderPastPrintsBlock(history: ReportHistoryRow[]): string {
  if (history.length === 0) return "";
  const sign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
  const rows = history.map((h) => {
    const eps = h.epsActual != null && h.epsEstimate != null
      ? `${h.epsActual.toFixed(2)} / ${h.epsEstimate.toFixed(2)}`
      : h.epsActual != null ? h.epsActual.toFixed(2) : "—";
    const surprise = h.surprisePct != null ? sign(h.surprisePct) : "—";
    const move = h.postPrintMovePct != null ? sign(h.postPrintMovePct) : "—";
    return `| ${h.reportedDate} | ${eps} | ${surprise} | ${move} |`;
  });
  return `## Past prints

| Reported | EPS act / est | Surprise | Next-day move |
|---|---|---|---|
${rows.join("\n")}

*Next-day move is close-over-close around the print (public market data; history via Alpha Vantage).*`;
}

// Pure function — exported so the in-app email viewer can rebuild the
// scoreboard from a stored audit row + the live calendar_events fields.
// The scoreboard is deterministic (no AI involvement) so re-rendering on
// read gives the user current consensus/actual/reaction values, not the
// snapshot at email-send time.
export function renderHeadlineTable(
  event: Pick<CalendarEvent, "consensus_estimate" | "actual_value" | "consensus_value" | "reaction_snapshot">,
  symbol: string,
  phase: "preview" | "recap",
  intel?: EarningsIntelView | null,
): string {
  // Consensus precedence: consensus_value (at-release, set by enrichment) wins
  // over consensus_estimate (Finnhub-sync-time). Apply identically to BOTH
  // columns so the Δ math is anchored on the same baseline. Pre-fix the cons
  // column read consensus_estimate and the actual fallback read consensus_value
  // — when these diverged the user's printable Δ column was wrong.
  const consSource = event.consensus_value ?? event.consensus_estimate;
  const cons = parseFinnhubFigure(consSource);
  const rawActual = phase === "recap"
    ? parseFinnhubFigure(event.actual_value)
    : { eps: null, revenue: null };

  // Site-wide Finnhub-drift defense. Bogus scrape values (e.g. GOOGL Q1 2026
  // stored EPS 5.11 vs consensus 2.70 — confirmed wrong by live re-fetch)
  // would otherwise hit the scoreboard as if real. When flagged, blank the
  // affected actual cells; the table picks up an explicit "data flagged —
  // verify before relying" sub-line below the rows. Read-throughs already
  // guard at line 433; scoreboard now shares the rule.
  const plausible = isPlausibleEarnings(
    cons.eps,
    rawActual.eps,
    cons.revenue,
    rawActual.revenue,
  );
  const actual = plausible ? rawActual : { eps: null, revenue: null };

  const epsConsensus = cons.eps != null ? cons.eps.toFixed(2) : "—";
  const epsActual = actual.eps != null ? actual.eps.toFixed(2) : "—";
  const epsDelta =
    cons.eps != null && actual.eps != null ? formatPctDelta(actual.eps, cons.eps) : "—";

  const revConsensus = formatRevenueDisplay(cons.revenue);
  const revActual = formatRevenueDisplay(actual.revenue);
  const revDelta =
    cons.revenue != null && actual.revenue != null
      ? formatPctDelta(actual.revenue, cons.revenue)
      : "—";

  // Reaction rows are recap-only; preview leaves the actual columns blank.
  const isRecap = phase === "recap";
  const stockReaction = isRecap ? readReactionDelta(event.reaction_snapshot, "symbol") : "—";
  const spyReaction = isRecap ? readReactionDelta(event.reaction_snapshot, "spy") : "—";
  const qqqReaction = isRecap ? readReactionDelta(event.reaction_snapshot, "qqq") : "—";

  const phaseLabel = phase === "preview" ? "into the print" : "post-print";

  // Expected move: preview shows the implied cell only (Actual/Δ dashes —
  // there's nothing to compare against yet). Recap echoes the realized
  // |stock reaction| against the implied move and calls it inside/outside
  // the priced-in range — never recomputed here, `intel.impliedMovePct` is
  // whatever was cached at preview-compose time.
  const impliedCell = fmtImplied(intel);
  let impliedActual = "—";
  let impliedVerdict = "—";
  if (isRecap && intel?.impliedMovePct != null) {
    const realized = readReactionPct(event.reaction_snapshot, "symbol");
    if (realized != null) {
      impliedActual = `${realized >= 0 ? "+" : ""}${realized.toFixed(1)}%`;
      impliedVerdict = Math.abs(realized) <= intel.impliedMovePct ? "inside" : "outside";
    }
  }

  const rows = [
    `| **EPS** | ${epsConsensus} | ${epsActual} | ${epsDelta} |`,
    `| **Revenue** | ${revConsensus} | ${revActual} | ${revDelta} |`,
    `| **Expected move (options)** | ${impliedCell} | ${impliedActual} | ${impliedVerdict} |`,
    `| **Avg move last 8 prints** | ${fmtHistSummary(intel)} | — | — |`,
    `| **Guidance (next quarter)** | — | — | — |`,
    `| **${symbol} @ T+2h** | — | ${stockReaction} | — |`,
    `| **SPY @ T+2h** | — | ${spyReaction} | — |`,
    `| **QQQ @ T+2h** | — | ${qqqReaction} | — |`,
  ].join("\n");

  // Surface a flagged-actuals warning beneath the scoreboard so the user (and
  // the AI) sees that what's missing isn't an enrichment gap, it's a quality
  // gate. Only renders on a recap — preview never has actuals to flag.
  const flaggedNote =
    phase === "recap" && !plausible
      ? "\n\n*⚠ Reported actuals were flagged as implausible vs consensus (likely Finnhub scrape error). Cells blanked to avoid misleading; verify via press release before relying on them.*"
      : "";

  return `## ${symbol} scoreboard — ${phaseLabel}

| Metric | Consensus | Actual | Δ |
|---|---|---|---|
${rows}

*Empty cells in a preview are intentional — print this, fill them in live during the call. Recap fills them automatically. \`—\` in the actual column on a recap means data wasn't available at send time (e.g. TWS disconnected, transcript not posted).*${flaggedNote}`;
}

// ── Prompt rendering (pure for testability) ────────────────────────

export function renderPreviewPrompt(ctx: PreviewContext): string {
  const consensusBlock = ctx.event.consensus_estimate
    ? `\n## Street Consensus (from Finnhub at sync time)\n${ctx.event.consensus_estimate}\n`
    : `\n## Street Consensus\nNot in our database. Use web_search to find consensus EPS, revenue, and any other key metrics analysts are watching for this print. Cite source URLs.\n`;

  const positionsBlock = renderPositionsBlock(ctx);
  const userNotesBlock = renderUserNotesBlock(ctx);
  const bogeysBlock = renderBogeysBlock(ctx);
  // Code-rendered, never AI-generated (same discipline as the scoreboard
  // rows it accompanies) — gives the model quantitative context on implied
  // move + surprise/reaction history without asking it to compute or recall
  // any of these numbers itself. "" when the symbol has no cached history.
  const pastPrintsBlock = renderPastPrintsBlock(ctx.intel?.history ?? []);
  const newslettersBlock = renderNewslettersBlock(ctx, "preview");
  const readThroughsBlock = renderReadThroughsBlock(ctx);
  const analystBlock = renderAnalystBlock(ctx);
  const pressBlock = ctx.recentPressReleases
    ? `\n## Recent Press Releases (last 30 days)\n${ctx.recentPressReleases}\n`
    : "";
  const priorCallBlock = renderPriorTranscriptBlock(ctx);

  return `You are a financial analyst writing a focused pre-earnings briefing for a single portfolio manager who holds ${ctx.symbol}. The release is in approximately 2 hours. Goal: prepare him as if he were sitting next to a sell-side analyst he trusts — concise, candid, no cheerleading.

## Event
- Symbol: **${ctx.symbol}**
- Family (siblings rolled up): ${ctx.family.join(", ")}
- Date: ${ctx.event.event_date}
- Release time: ${ctx.event.release_time ?? "(not specified — assume BMO or AMC based on context)"}
- Source: ${ctx.event.source}
- Expected impact: ${ctx.event.expected_impact ?? "n/a"}
${userNotesBlock}
${renderPriorCallNoteBlock(ctx.priorCallNote)}
${bogeysBlock}
${pastPrintsBlock}
${consensusBlock}
${positionsBlock}
${newslettersBlock}
${readThroughsBlock}
${analystBlock}
${pressBlock}
${priorCallBlock}

## Your task

Use the structured context above as the source of truth for positions, consensus, and newsletter quotes. **For anything missing or thin, use web_search** — bogies for the print, sell-side notes published in the last 24-48 hours, recent buy-side commentary, expectations on segment-level metrics, prior-quarter takeaways. Cite source URLs inline as [Source Name](url).

**Already-reported check:** if your web search shows ${ctx.symbol} has ALREADY released these results (figures published as actuals dated today or earlier), do NOT frame them as expectations. Open the briefing by stating plainly that the report is already out, label every published figure as an ACTUAL, and skip the "into the print" framing — the calendar slot for this event was wrong.

**IMPORTANT — output structure.** A deterministic "scoreboard" headline table is rendered ABOVE your output by the system; do NOT repeat the headline metrics (EPS / Revenue / Expected move / Avg move / SPY reaction / QQQ reaction) — your output starts AFTER the scoreboard. The "## Past prints" section (if present above) is also rendered by the system, not by you — reference it in your analysis if useful, but do not re-list its rows. Lead with the line-by-line bogies table, then prose. Specifically:

1. **\`## Line-by-line bogies\`** — a markdown table the user can print and fill in by hand during the call. Columns MUST be exactly:

\`\`\`
| Metric | Consensus / Prior | Actual | Δ |
|---|---|---|---|
\`\`\`

Rows: every segment, KPI, and guidance metric the Street is watching for ${ctx.symbol} specifically — pulled from the prior-quarter transcript / sell-side notes / press releases in the context above (or web_search if context is thin). Examples for a tech name: revenue by segment, gross margin, operating margin, FCF, capex, ARR / billings, customer count, guide for next quarter, full-year guide. Examples for a consumer name: organic revenue growth, unit case volume by region, operating margin by segment. **Use \`—\` (em-dash) in the Actual + Δ columns** — this is a preview, the user writes in the actuals during the call. Aim for 8–15 rows; segment-rich names get more, narrow-business names get fewer.

2. **\`## The setup\`** — 2-3 sentences. Where does ${ctx.symbol} go into the print? Stock action over the past 30 days. Posture into the call.

3. **\`## Bull case / bear case\`** — concise. What sets up a beat-and-raise; what triggers a sell-off. Reference newsletter views by author when applicable.

4. **\`## What to watch on the call\`** — guidance change, segment commentary, capex, any specific issue current sell-side notes are pushing for.

5. **\`## Position implications\`** — given the user's combined position (use the §Positions block verbatim), what's the asymmetry? Hedged or naked? If there are option positions in the data, mention assignment / IV-crush risk explicitly.

6. **\`## Sources\`** — a footer listing the newsletter article subjects + dates we cited, plus any web URLs.

**Number formatting (strict):** Quote large monetary values in compact form — \`$4.34B\` for billions (2dp), \`$245M\` for millions (1dp), \`$0.91\` for EPS-scale dollars (2dp), \`12.3M units\` for unit counts (1dp). Never write out full digits with commas like \`4,345,870,107\` or \`$11,000,000,000\` — they're hard to read on a phone and impossible to print legibly. Percentages stay as \`±N.N%\` (1dp). Apply this rule everywhere: tables, prose, scenarios.

Tone: analytical colleague, not coach. No "you should" prescriptions; offer scenarios and let the reader decide. Lead with numbers + tables; prose comes after. Aim for 600-1000 words of prose (the line-by-line table is in addition to that budget).`;
}

export function renderRecapPrompt(ctx: RecapContext): string {
  const consensusBlock = ctx.event.consensus_value || ctx.event.consensus_estimate
    ? `\n## Consensus going in\n${ctx.event.consensus_value ?? ctx.event.consensus_estimate}\n`
    : "";

  // Mirror the scoreboard's plausibility gate (renderHeadlineTable): when the
  // recorded actual is flagged implausible vs consensus, the deterministic
  // scoreboard blanks it with a ⚠ warning — feeding the same values into the
  // AI context makes the model's Line-by-line table restate exactly what the
  // scoreboard withheld, contradicting the warning directly above it.
  const recapCons = parseFinnhubFigure(
    ctx.event.consensus_value ?? ctx.event.consensus_estimate
  );
  const recapActual = parseFinnhubFigure(ctx.event.actual_value);
  const actualsPlausible = isPlausibleEarnings(
    recapCons.eps,
    recapActual.eps,
    recapCons.revenue,
    recapActual.revenue
  );

  const actualBlock = !ctx.event.actual_value
    ? `\n## Reported actual\nEnrichment hasn't captured the actual yet. Use web_search to find the press-release values: EPS, revenue, segment splits, full-year guidance change. Cite source URLs.\n`
    : actualsPlausible
      ? `\n## Reported actual (from enrichment runner)\n${ctx.event.actual_value}\n`
      : `\n## Reported actual\nOur database has a recorded actual for this print, but it was **flagged as implausible vs consensus** (likely a data-vendor scrape error) and has been withheld — the scoreboard above blanks it for the same reason. Do NOT state, infer, or reconstruct those withheld figures. Use web_search to find the actual reported EPS / revenue from the company's press release, cite source URLs, and use ONLY those verified figures in your Line-by-line table and prose.\n`;

  const reactionBlock = ctx.reactionSnapshotMarkdown
    ? `\n## Market reaction (T+2h, captured automatically)\n${ctx.reactionSnapshotMarkdown}\n`
    : `\n## Market reaction\nReaction snapshot not yet captured. If you can determine after-hours / immediate reaction from web_search, cite it; otherwise note the gap.\n`;

  const positionsBlock = renderPositionsBlock(ctx);
  const userNotesBlock = renderUserNotesBlock(ctx);
  const bogeysBlock = renderBogeysBlock(ctx);
  const newslettersBlock = renderNewslettersBlock(ctx, "recap");
  // Read-throughs: same data + helper as preview (RecapContext extends
  // PreviewContext, buildRecapContext inherits `readThroughs`). On the
  // recap side they anchor the print in the cluster context the reader
  // already saw at preview time — "the META/GOOGL prints we framed for
  // you earlier reported $X · reaction Y%; here's how this one stacks up."
  const readThroughsBlock = renderReadThroughsBlock(ctx);
  const analystBlock = renderAnalystBlock(ctx);
  const pressBlock = ctx.freshPressReleases
    ? `\n## Press releases since release\n${ctx.freshPressReleases}\n`
    : "";
  const priorCallBlock = renderPriorTranscriptBlock(ctx);

  return `You are a financial analyst writing a focused post-earnings recap for a single portfolio manager who holds ${ctx.symbol}. The release was approximately 2 hours ago. Goal: brief him as a colleague who just digested the print and the immediate market reaction.

## Event
- Symbol: **${ctx.symbol}**
- Family (siblings rolled up): ${ctx.family.join(", ")}
- Date: ${ctx.event.event_date}
- Release time: ${ctx.event.release_time ?? "(not specified)"}
- Source: ${ctx.event.source}
${userNotesBlock}
${renderCallNoteBlock(ctx.callNote)}
${bogeysBlock}
${consensusBlock}
${actualBlock}
${reactionBlock}
${positionsBlock}
${newslettersBlock}
${readThroughsBlock}
${analystBlock}
${pressBlock}
${priorCallBlock}

## Your task

Use the structured context above as the source of truth. **For anything missing — call commentary, post-print sell-side reactions, transcript quotes, guidance change details — use web_search** with focus on the last 4 hours of coverage. Cite source URLs inline. **When evaluating beat/miss, anchor against the bogeys block (especially whisper numbers) when present, not just the Finnhub consensus.**

**IMPORTANT — output structure.** A deterministic "scoreboard" table is rendered ABOVE your output by the system (it shows EPS / Revenue / expected-vs-realized move / avg historical move / stock + SPY + QQQ reactions). Do NOT repeat those headline metrics. Your output starts with the line-by-line table (same shape as the preview, but filled in), then prose. Specifically:

1. **\`## Line-by-line metrics\`** — a markdown table with EXACTLY these columns:

\`\`\`
| Metric | Consensus / Prior | Actual | Δ |
|---|---|---|---|
\`\`\`

Rows: every segment, KPI, and guidance line ${ctx.symbol} reported — fill from the press release (use web_search to find it if not in the press-release context above). Mirror the bogies the prior-quarter transcript called out so the recap visually overlays the preview. **Fill in the Actual + Δ columns** with the reported values; use \`—\` only when truly unavailable (e.g., a metric the company didn't break out this quarter). Aim for 8–15 rows.

2. **\`## The reaction\`** — stock move vs. SPY/QQQ/sector. If a transcript or call quotes are available via web_search, lead with the one or two quotes that explain the move. If not, note "transcript not yet posted — recap will update if a follow-up runs."

3. **\`## Guidance\`** — **MANDATORY section.** Public companies almost always update guidance with their print: full-year (FY26) revenue, EPS, margin, capex; next-quarter (Q2) revenue and EPS; sometimes segment-level guides (e.g., "Cloud revenue growth"). **Use web_search aggressively** if the press release context above doesn't contain it — search for \`"${ctx.symbol}" guidance Q2\` or \`"${ctx.symbol}" full year outlook ${new Date().getFullYear()}\`. Structure the section as:
   - **Full year:** prior guide → new guide, change in $ or pp, what it implies (raise/maintain/cut)
   - **Next quarter:** new guide vs Street consensus
   - **Segment / KPI guides:** anything specific the company called out (e.g., "Cloud revenue growth low-20s%", "GMV +12-14%")
   - If guidance was NOT updated (rare), explicitly say "No updated guidance issued — prior guide stands" and quote the still-active prior guide. Never silently omit this section.

4. **\`## Sell-side first takes\`** — web_search for analyst notes published in the last few hours. Quote the headline, flag price-target changes, name the firm. If nothing is out yet, say so.

5. **\`## Position implications\`** — given the user's combined position (use §Positions verbatim), what does the print mean for each disclosed direction at the reaction-snapshot price? Reason qualitatively and in percentage terms only — never estimate or invent share counts, contract counts, or dollar exposure. Any hedging / IV-crush dynamics for option holdings? Should the thesis change?

6. **\`## Sources\`** — newsletter articles cited + web URLs.

**Number formatting (strict):** Quote large monetary values in compact form — \`$4.34B\` for billions (2dp), \`$245M\` for millions (1dp), \`$0.91\` for EPS-scale dollars (2dp), \`12.3M units\` for unit counts (1dp). Never write out full digits with commas like \`4,345,870,107\` or \`$11,000,000,000\` — they're hard to read on a phone and impossible to print legibly. Percentages stay as \`±N.N%\` (1dp). Apply this rule everywhere: tables, prose, quoted figures.

Tone: analytical colleague. Numbers and direct quotes over adjectives. Lead with tables; prose after. Aim for 500-800 words of prose (the line-by-line table is in addition).`;
}

function renderPositionsBlock(ctx: PreviewContext): string {
  if (ctx.positions.length === 0) {
    return `\n## Positions\nThe user does NOT currently hold ${ctx.family.join("/")} (or any sibling). Treat this as a watchlist note — explain the relevance assuming pure observer interest.\n`;
  }
  const lines = ctx.positions.map((p) => formatPositionLine(p));
  const summary = formatPositionSummary(ctx);
  return `\n## Positions (cross-account, stock + options + sibling classes rolled up)\n${lines.join("\n")}\n\n${summary}\n`;
}

function formatPositionLine(p: PositionEntry): string {
  // Presence-only: direction + account + option terms, nothing else. Since
  // 2026-08-02 share/contract counts AND return % are both omitted (count ×
  // public price reconstructs exact $ exposure). Strike + expiry stay
  // visible — they're public market data.
  const presence = formatPositionPresence({
    symbol: p.symbol,
    accountName: p.account_name,
    quantity: p.quantity,
    securityType: p.security_type,
    optionMeta:
      p.security_type.toLowerCase() === "option"
        ? {
            underlyingSymbol: p.underlying_symbol,
            strikePrice: p.strike_price,
            expirationDate: p.expiration_date,
            optionType: p.option_type,
          }
        : null,
  });
  return `- ${presence}`;
}

function formatPositionSummary(ctx: PreviewContext): string {
  const exposure = formatCombinedExposurePresence({
    positionCount: ctx.positions.length,
    longShares: ctx.longShares,
    shortShares: ctx.shortShares,
    longContracts: ctx.longContracts,
    shortContracts: ctx.shortContracts,
  });
  return `**Combined exposure:** ${exposure}. Position sizes are deliberately not disclosed — reason about asymmetry and direction qualitatively and in percentage terms; never estimate or invent share counts, contract counts, or dollar exposure.`;
}

export function renderNewslettersBlock(
  ctx: PreviewContext,
  phase: "preview" | "recap",
): string {
  if (ctx.recentArticles.length === 0) {
    return `\n## Newsletter coverage\nNo recent newsletter articles mention ${ctx.symbol}. Use web_search to gather sell-side / buy-side commentary instead.\n`;
  }
  const seenNoteSources = new Set<number>();
  const blocks = ctx.recentArticles.map((a) => {
    const sentSuffix = a.sentiment_score != null
      ? ` (sentiment score: ${a.sentiment_score.toFixed(2)})`
      : "";
    let noteLine = "";
    if (a.earnings_note && !seenNoteSources.has(a.source_id)) {
      seenNoteSources.add(a.source_id);
      noteLine = `\n> How to read this source: ${a.earnings_note}`;
    }
    return `### [${a.received_at.slice(0, 16).replace("T", " ")}] ${a.source_name} — ${a.subject}${sentSuffix}${noteLine}\n${a.body}`;
  });
  const phaseFraming = phase === "preview"
    ? `Treat these as **bogies + buy-side / sell-side commentary** — quote authors by name, surface where they disagree, and note any specific numbers (EPS, revenue, segment splits, price targets) they mention.`
    : `These frame how the position was being read *into* the print. Reference them only where they're directly relevant to interpreting the actual.`;
  const framing = `Sources below appear in the user's trust order — when sources conflict, weight the earlier-listed source's framing more heavily, but always surface the disagreement. ${phaseFraming} Where multiple sources make the same factual claim (a bogey, a price target, a sell-side note), collapse it into one statement with multi-source attribution ("VK and TMT Breakout both flag the same whisper") rather than repeating it per source.`;
  return `\n## Newsletter coverage (user's trust-ordered sources)\n${framing}\n\n${blocks.join("\n\n---\n\n")}\n`;
}

function renderAnalystBlock(ctx: PreviewContext): string {
  const parts: string[] = [];
  if (ctx.recommendationTrend) {
    parts.push(`### Recommendation trend (last 6 months)\n${ctx.recommendationTrend}`);
  }
  if (ctx.priceTarget) {
    parts.push(`### Price target consensus\n${ctx.priceTarget}`);
  }
  if (ctx.ratingChanges) {
    parts.push(`### Recent rating changes (last 8)\n${ctx.ratingChanges}`);
  }
  if (parts.length === 0) {
    return `\n## Analyst coverage\nNo cached analyst data for ${ctx.symbol}. If relevant, use web_search to fill in price-target consensus and recent upgrade/downgrade activity.\n`;
  }
  return `\n## Analyst coverage (cached, Finnhub)\n${parts.join("\n\n")}\n`;
}

// User's own notes — placed FIRST in the prompt (before consensus / positions /
// newsletters) so the AI frames the briefing as a conversation with the user's
// prior thesis rather than synthesizing from external sources alone. Cap each
// note's content to keep the total contribution bounded; truncated notes are
// suffixed with "…" so the AI knows there's more (and can ask the user to
// elaborate via web_search if needed).
const NOTE_CHAR_CAP = 1500;

// Narrow input — only the two fields the block needs. Lets tests pass a
// minimal object instead of constructing a full PreviewContext.
export function renderReadThroughsBlock(ctx: {
  symbol: string;
  readThroughs: ReadThroughEntry[];
}): string {
  if (ctx.readThroughs.length === 0) return "";
  const lines = ctx.readThroughs.map((rt) => {
    const consensusBits: string[] = [];
    if (rt.consensusEps != null) consensusBits.push(`EPS $${rt.consensusEps.toFixed(2)}`);
    if (rt.consensusRev != null) consensusBits.push(`Rev ${formatLargeUSD(rt.consensusRev)}`);

    const actualBits: string[] = [];
    if (rt.actualEps != null) actualBits.push(`EPS $${rt.actualEps.toFixed(2)}`);
    if (rt.actualRev != null) actualBits.push(`Rev ${formatLargeUSD(rt.actualRev)}`);

    const beats: string[] = [];
    const epsDelta = beatEpsText(rt.consensusEps, rt.actualEps);
    if (epsDelta) beats.push(`EPS ${epsDelta}`);
    const revDelta = beatRevPctText(rt.consensusRev, rt.actualRev);
    if (revDelta) beats.push(`Rev ${revDelta}`);

    const reactionBits: string[] = [];
    if (rt.reactionStockPct != null) {
      reactionBits.push(`${rt.reporter} ${signedPct1dp(rt.reactionStockPct)}`);
    }
    if (rt.reactionSpyPct != null) reactionBits.push(`SPY ${signedPct1dp(rt.reactionSpyPct)}`);
    if (rt.reactionQqqPct != null) reactionBits.push(`QQQ ${signedPct1dp(rt.reactionQqqPct)}`);

    const segments: string[] = [];
    if (consensusBits.length > 0) segments.push(`Consensus: ${consensusBits.join(" · ")}.`);
    if (actualBits.length > 0) {
      const tail = beats.length > 0 ? ` (${beats.join(", ")})` : "";
      segments.push(`Actual: ${actualBits.join(" · ")}${tail}.`);
    }
    if (reactionBits.length > 0) {
      segments.push(`Reaction @ T+2h: ${reactionBits.join(" · ")}.`);
    }

    const hypothesisLine = rt.hypothesis ? `\n  *Hypothesis:* ${rt.hypothesis}` : "";

    return `- **${rt.reporter}** reported ${rt.reporterEventDate}. ${segments.join(" ")}${hypothesisLine}`;
  });

  return `\n## Read-throughs from this earnings season\n\nReporters from your tracked read-through pairs that already printed in the last 14 days. Each bullet pairs the reporter's beat/miss with the post-print market reaction so you can ground ${ctx.symbol}'s upcoming bull/bear case in *what actually happened* in the cluster — not a generic claim that "peers are setting up well." Don't over-extrapolate; one cluster member's surprise doesn't guarantee another's.\n\n${lines.join("\n\n")}\n`;
}

function signedPct1dp(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

// EPS dollar-delta — percentage math is misleading at small/zero/negative
// scale ("+25%" of $0.04 reads as a giant beat when it's a penny). Penny
// delta is what every trader actually quotes pre-/post-print.
function beatEpsText(consensus: number | null, actual: number | null): string | null {
  if (consensus == null || actual == null) return null;
  const delta = actual - consensus;
  const sign = delta >= 0 ? "+" : "";
  return `${sign}$${delta.toFixed(2)}`;
}

// Revenue beat as a percentage — both values are large positives, so pct
// math is well-defined and what the Street quotes ("rev beat by 1.1%").
function beatRevPctText(consensus: number | null, actual: number | null): string | null {
  if (consensus == null || actual == null || consensus <= 0) return null;
  const pct = ((actual - consensus) / consensus) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

// Moved to lib/earnings/plausibility.ts (zero-import single source with a
// byte-parity Worker mirror). Re-exported so existing importers are untouched.
export { isPlausibleEarnings } from "@/lib/earnings/plausibility";

function renderUserNotesBlock(ctx: PreviewContext): string {
  if (ctx.userNotes.length === 0) return "";
  const lines = ctx.userNotes.map((n) => {
    const content = n.content.length > NOTE_CHAR_CAP
      ? n.content.slice(0, NOTE_CHAR_CAP) + "…"
      : n.content;
    const sym = n.symbol ?? ctx.symbol;
    const sentSuffix = n.sentiment ? ` · sentiment: ${n.sentiment}` : "";
    const tagsSuffix = n.tags ? ` · tags: ${n.tags}` : "";
    return `### [${n.event_date}] ${n.note_type} on ${sym}${sentSuffix}${tagsSuffix}\n${content}`;
  });
  return `\n## Your prior notes on ${ctx.symbol} — read these FIRST and frame the briefing in conversation with the prior thesis\n\nThese are the user's own journal / earnings / trade-thesis notes attached to ${ctx.symbol} or any sibling-class security in the family. Treat them as the **primary lens** through which the briefing should be written — quote dates, refer to the user's prior view directly, and flag where the new event either confirms, evolves, or contradicts what the user already wrote. Do NOT paraphrase these as if they were newsletter content; they're the user's own words.\n\n${lines.join("\n\n---\n\n")}\n`;
}

const GUIDANCE_LABELS: Record<string, string> = {
  raised: "RAISED",
  inline: "IN LINE",
  lowered: "LOWERED",
  not_given: "NOT GIVEN",
};

function callNoteLines(note: EarningsCallNote): string[] {
  const lines: string[] = [];
  const label = note.guidance ? GUIDANCE_LABELS[note.guidance] : null;
  if (label) lines.push(`- You marked guidance: **${label}**`);
  if (note.tone) lines.push(`- Management tone: ${note.tone}`);
  if (note.surprises) lines.push(`- Surprises: ${note.surprises}`);
  if (note.follow_ups) lines.push(`- Follow-ups: ${note.follow_ups}`);
  return lines;
}

/** Recap: the user's own structured capture from during/after the call. */
export function renderCallNoteBlock(note: EarningsCallNote | null): string {
  if (!note) return "";
  const lines = callNoteLines(note);
  if (lines.length === 0) return "";
  return `\n## Your call notes (captured during/after the call)\n${lines.join("\n")}\n`;
}

/** Preview: prior quarter's capture — continuity with the user's own read. */
export function renderPriorCallNoteBlock(note: EarningsCallNote | null): string {
  if (!note) return "";
  const lines = callNoteLines(note);
  if (lines.length === 0) return "";
  return `\n## Last quarter's call, in your words\n${lines.join("\n")}\n`;
}

function renderBogeysBlock(ctx: PreviewContext): string {
  if (ctx.bogeys.length === 0) return "";
  const lines = ctx.bogeys.map((b, i) => {
    const sourceLabel = b.source_label ?? `${b.source} (no label)`;
    const fields: string[] = [];
    if (b.eps_consensus != null) fields.push(`EPS consensus ${b.eps_consensus.toFixed(2)}`);
    if (b.eps_whisper != null) fields.push(`EPS **whisper ${b.eps_whisper.toFixed(2)}**`);
    if (b.revenue_consensus_usd != null) fields.push(`revenue consensus ${formatLargeUSD(b.revenue_consensus_usd)}`);
    if (b.revenue_whisper_usd != null) fields.push(`revenue **whisper ${formatLargeUSD(b.revenue_whisper_usd)}**`);
    const head = fields.length > 0 ? `\n${fields.join(" · ")}` : "";
    let segs = "";
    if (b.segment_breakdown_json) {
      try {
        const parsed = JSON.parse(b.segment_breakdown_json) as Record<
          string,
          { consensus?: number; whisper?: number }
        >;
        const segLines = Object.entries(parsed).map(([name, vals]) => {
          const segFields: string[] = [];
          if (vals.consensus != null) segFields.push(`consensus ${formatLargeUSD(vals.consensus)}`);
          if (vals.whisper != null) segFields.push(`whisper ${formatLargeUSD(vals.whisper)}`);
          return `  - ${name}: ${segFields.join(", ")}`;
        });
        if (segLines.length > 0) {
          segs = `\nSegment splits:\n${segLines.join("\n")}`;
        }
      } catch {
        // Stored JSON malformed — skip silently.
      }
    }
    const guidance = b.guidance_notes ? `\nGuidance: ${b.guidance_notes}` : "";
    const notes = b.notes ? `\nNotes: ${b.notes}` : "";
    return `### [${i + 1}] ${sourceLabel} (uploaded ${b.uploaded_at})${head}${segs}${guidance}${notes}`;
  });
  return `\n## Bogeys (user-curated — preferred over Finnhub consensus, most recent first)

These are bogeys the user pulled from preferred sources (TMT Breakout, sell-side notes) and uploaded for THIS event. **Treat the most recent entry as the primary consensus reference.** Whisper numbers, when present, are the directional bar that matters — beat-the-whisper is the meaningful event, not beat-consensus. Cite the source label inline when discussing them.

${lines.join("\n\n---\n\n")}
`;
}

function renderPriorTranscriptBlock(ctx: PreviewContext): string {
  if (!ctx.priorTranscript) return "";
  const t = ctx.priorTranscript;
  const summary = t.summary && t.summary.length > 4000
    ? t.summary.slice(0, 4000) + "…"
    : t.summary;
  const guidance = t.guidance && t.guidance.length > 1500
    ? t.guidance.slice(0, 1500) + "…"
    : t.guidance;
  const parts: string[] = [];
  parts.push(`*Cached call: ${t.year}-Q${t.quarter} (source: ${t.source}${t.sentiment_label ? `, sentiment: ${t.sentiment_label}` : ""})*`);
  if (summary) parts.push(`**Summary:**\n${summary}`);
  if (guidance) parts.push(`**Guidance:**\n${guidance}`);
  return `\n## Prior call (most recent cached)\n${parts.join("\n\n")}\n`;
}

// ── Anthropic call with web_search ─────────────────────────────────

// B17/B17b: with the server-side web_search tool, max_tokens covers the WHOLE
// agentic loop — the model's interstitial text between searches plus the final
// briefing — so a heavily-covered mega-cap can overflow caps its final markdown
// alone never approaches (GOOG 7/22 blew 8192 and the preview fell back to the
// cloud compact email). Escalate through the ladder; if the TOP rung still
// truncates, fail the send — better no email than a cut-off one (the sweep's
// claim-release path preserves the retry).
export const OUTPUT_TOKEN_LADDER: readonly number[] = [4096, 8192, 16384];

export async function createWithTokenLadder<
  T extends { stop_reason: string | null },
>(
  create: (maxTokens: number) => Promise<T>,
  phase: "preview" | "recap",
  ladder: readonly number[] = OUTPUT_TOKEN_LADDER,
): Promise<T> {
  let response = await create(ladder[0]);
  for (let i = 1; i < ladder.length && response.stop_reason === "max_tokens"; i++) {
    console.warn(
      `[earnings-email] ${phase} output truncated at ${ladder[i - 1]} tokens — retrying at ${ladder[i]}`,
    );
    response = await create(ladder[i]);
  }
  if (response.stop_reason === "max_tokens") {
    throw new EarningsEmailError(
      `Claude output for ${phase} truncated even at ${ladder[ladder.length - 1]} tokens — refusing to send a cut-off email.`,
      500,
    );
  }
  return response;
}

async function callClaude(
  prompt: string,
  phase: "preview" | "recap",
): Promise<string> {
  const featureKey = phase === "preview" ? "earningsPreview" : "earningsRecap";
  const { provider, modelId } = resolveFeatureModel(featureKey);
  if (provider !== "anthropic") {
    throw new EarningsEmailError(
      `Earnings ${phase} requires the Anthropic provider for native web_search; FEATURE_MODELS["${featureKey}"] resolves to ${provider}/${modelId}. Update lib/ai/models.ts.`,
      500,
    );
  }
  const client = getRawAnthropicClient(featureKey);
  const response = await createWithTokenLadder(
    (maxTokens) =>
      client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        messages: [{ role: "user", content: prompt }],
      }),
    phase,
  );
  // Guard against Fable-style refusals (stop_reason === "refusal" means the
  // content array is empty — reading content[0] blindly would throw).
  if (response.stop_reason === "refusal") {
    throw new Error("Claude refused the earnings email request");
  }
  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  const text = textBlocks.map((b) => b.text).join("\n").trim();
  if (!text) {
    throw new EarningsEmailError(
      `Claude returned empty content for ${phase}.`,
      500,
    );
  }
  return stripModelPreamble(text);
}

// System prompt — anchors output discipline. Lives outside the per-phase
// user prompt because (1) it's identical for preview and recap, (2) it's
// the right Anthropic-API place for "how to behave" instructions, and (3)
// it survives prompt-cache better than re-injecting these rules each call.
const SYSTEM_PROMPT = `You produce structured earnings briefings for a single portfolio manager. Your output is rendered directly into an HTML email — there is no editor between you and the recipient.

OUTPUT DISCIPLINE — strict rules:

1. **Start immediately with the first \`## Section header\` the user prompt requests.** Do not preamble. Never write "Good", "Now I have enough", "Let me synthesize", "Here is the briefing", "Based on the context above", or any meta-commentary describing what you are about to do. The first character of your output must be \`#\` (the start of a markdown header).

2. **Do not narrate your process.** Do not say "I'll start by analyzing…" or "Looking at the data…". Just produce the briefing.

3. **Do not write closing commentary.** Do not end with "Hope this helps" or "Let me know if you want more detail". Stop after the \`## Sources\` section.

4. **Em-dash continuations stay on the same line.** Never break a sentence with a blank line followed by "— …". The HTML renderer treats blank lines as paragraph separators, so a leading-em-dash line becomes a fragmented paragraph that reads broken. Either keep the continuation on the same line or rewrite as a complete sentence.

5. **If the data is genuinely missing — actuals not captured, no consensus available, no analyst notes — say so explicitly in the prose.** Do not fabricate numbers. Do not infer actuals from consensus. The user reads this as ground truth and acts on it.`;

// Strip residual self-talk from the model output even when the system prompt
// is followed. Belt-and-suspenders: the system prompt is the primary defense,
// this is the failsafe for when Sonnet leaks a "Good, now I have enough…"
// line despite instructions. We trim leading lines that don't start with a
// markdown structure marker (#, |, -, *, >) and aren't blank, until we hit
// one that does.

// ── Date helpers ───────────────────────────────────────────────────

export function formatDateLong(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Re-export the types so tests can import the contract.
export type {
  PositionEntry as EarningsPositionEntry,
  NewsletterEntry as EarningsNewsletterEntry,
  PreviewContext as EarningsPreviewContext,
  RecapContext as EarningsRecapContext,
};
