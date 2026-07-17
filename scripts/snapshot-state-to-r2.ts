#!/usr/bin/env tsx
/**
 * Nightly state snapshot — Mac SQLite → Cloudflare R2.
 *
 * Writes a compressed JSON blob to `state/vanguard-state-YYYY-MM-DD.json.gz`
 * containing everything the Worker fallback (Phase 4 Session C) needs to
 * generate a briefing or digest when the Mac is unreachable:
 *
 *   - held stock symbols (for earnings/event filtering)
 *   - calendar_events within the next 7 days
 *   - research_sources (sender_email + processing_prompt)
 *   - recent article metadata (14 days, no raw_text — keeps payload small)
 *   - deep-read bodies for Vital Knowledge + 3 other preferred sources
 *     (last 72h, raw_text truncated to 30k chars each)
 *   - last_digest_sent_at / last_briefing_sent_at timestamps
 *
 * After upload, prunes snapshots older than 7 days. Idempotent — re-running
 * same day overwrites the same key.
 *
 * Run: `npx tsx scripts/snapshot-state-to-r2.ts`
 * Scheduled: com.vanguard-skin.state-snapshot.plist at 2:00 AM local daily.
 */

import Database from "better-sqlite3";
import path from "node:path";
import {
  putGzippedJson,
  listObjects,
  deleteObject,
  isR2Configured,
} from "@/lib/storage/r2";
import { getModelCatalog } from "@/lib/ai/model-catalog";
import { getBriefingHoldings } from "@/lib/calendar/briefing";
import { getReportHistoryForFamily } from "@/lib/queries/earnings-intel";
import { summarizeHistory } from "@/lib/earnings/report-history";

const DEEP_READ_SOURCE_IDS = [1, 18, 19, 28]; // VK, Eliant, Purple Drink, Meisler
const DEEP_READ_HOURS = 72;
const MAX_DEEP_READ_CHARS = 30_000;
const RECENT_META_DAYS = 14;
const CALENDAR_LOOKAHEAD_DAYS = 7;
const SNAPSHOT_RETENTION_DAYS = 7;

interface Snapshot {
  schemaVersion: 10;
  snapshotDate: string;
  generatedAt: string;
  heldSymbols: string[];
  settings: {
    last_digest_sent_at: string | null;
    last_briefing_sent_at: string | null;
    // v3 additions — recipient overrides (null until Phase 6 UI surfaces them)
    evening_email_recipients: string | null;
    digest_email_recipients: string | null;
    briefing_email_recipients: string | null;
    // v3 additions — observability ring buffer for synthesis fallbacks
    synthesis_fallbacks_last_30d: string | null;
  };
  calendarEvents: Record<string, unknown>[];
  researchSources: Record<string, unknown>[];
  recentArticlesMeta: Record<string, unknown>[];
  deepReadArticles: Record<string, unknown>[];
  // Phase 4 — Worker cloud fallback for earnings emails. Worker reads
  // these to compose a compact preview/recap when the Mac primary cron
  // is unreachable. Holdings + securities give cross-account positions
  // (incl. options via underlying_symbol), accounts maps id→name, and
  // earnings_emails lets the Worker skip events Mac already audited.
  // Snapshot bumped to schemaVersion 2; Workers reading older snapshots
  // gracefully degrade (these fields default to []).
  holdings: Record<string, unknown>[];
  securities: Record<string, unknown>[];
  accounts: Record<string, unknown>[];
  earningsEmails: Record<string, unknown>[];
  earningsSettings: {
    enabled: boolean;
    mutedSymbols: string[];
  };
  // v3 additions
  // Vanguard (non-Roth) stock/ETF/mutual-fund holdings for the evening-email
  // fallback. Restricted to security types the evening digest cares about
  // (excludes options, bonds, etc).
  vanguardHoldings: Array<{ symbol: string; securityId: number; accountId: number }>;
  // Cached beta coefficients. Worker reads these to rank holdings by
  // systematic risk without running a full regression in the cloud.
  securityBetas: Array<{ securityId: number; lookbackDays: number; beta: number; residualStd: number | null; computedAt: string }>;
  // v4 addition — active static price levels for cloud-side scan + Pushover
  // fan-out when Mac is asleep. MA-based levels (sma_*, ema_*) are excluded
  // because they require OHLCV bars to resolve effective_price; those stay
  // Mac-only.
  securityLevels: Array<{
    id: number;
    security_id: number;
    symbol: string;
    level_type: string;
    price: number;
    direction: string | null;
    source: string;
    source_author: string | null;
    expires_at: string | null;
  }>;
  // v5 additions — user thesis notes (security-linked, last 90d) + curated
  // earnings bogeys (consensus + whisper) so the cloud earnings email carries
  // the cheaply-mirrorable parts of the Mac composer's rich context. Worker
  // reads these in fallback-earnings.ts; older Workers ignore the fields.
  notes: Array<{
    id: number;
    note_type: string;
    content: string;
    event_date: string;
    sentiment: string | null;
    tags: string | null;
    symbol: string | null;
    underlying_symbol: string | null;
  }>;
  earningsBogeys: Array<{
    id: number;
    event_id: number;
    source: string;
    source_label: string | null;
    eps_consensus: number | null;
    eps_whisper: number | null;
    revenue_consensus_usd: number | null;
    revenue_whisper_usd: number | null;
    segment_breakdown_json: string | null;
    guidance_notes: string | null;
    notes: string | null;
    uploaded_at: string;
  }>;
  // v6 — available Anthropic model ids (from /v1/models, cached in settings).
  // Worker fallbacks use this for tier-aware model selection + reactive failover.
  // [] when never refreshed — graceful: falls back to TIER_STATIC_FALLBACK.
  modelCatalog: string[];
  // v7 — Vanguard-only briefing holdings (IBKR excluded via the Mac
  // single-source getBriefingHoldings / BRIEFING_EXCLUDE_IBKR_SQL). The cloud
  // briefing fallback renders these instead of the cross-account heldSymbols
  // list so it never surfaces the IBKR trading book as research holdings
  // (mirrors the U4 Mac-side exclusion, 2026-06-15).
  briefingHoldings: Array<{
    symbol: string;
    name: string | null;
    sector: string | null;
    netQty: number;
  }>;
  // v8 — active watchlist stock symbols (Wave 1 §2 push-at-print). Lets the
  // Worker's cloud-enrich push hook cover watchlist names, not just held
  // ones (workers/cron/src/state.ts::watchlistSymbols is the optional/
  // back-compat mirror the Worker reads).
  watchlistSymbols: string[];
  // v9 — earnings intelligence (audit §4C #9/#10, Task 9). Implied-move
  // intel per upcoming event (event_date >= daysAgo(1), so a same-day-earlier
  // release stays visible to the Worker like the rest of the calendar
  // window) + per-symbol surprise/reaction history for symbols reporting in
  // the next 14 days. Lets the cloud scoreboard render the same "Expected
  // move (options)" / "Avg move last 8 prints" rows as the Mac composer
  // (workers/cron/src/fallback-earnings.ts::renderScoreboard), with an
  // as-of label since `computed_at` can be hours stale by cloud-send time.
  // Both optional on the Worker side for back-compat with pre-v9 snapshots.
  earningsIntel: Array<{
    eventId: number;
    sourceKey: string;
    impliedMovePct: number | null;
    impliedMethod: "straddle" | "iv_approx" | null;
    expiryUsed: string | null;
    computedAt: string;
  }>;
  earningsHistory: Record<
    string,
    {
      rows: Array<{
        reportedDate: string;
        epsActual: number | null;
        epsEstimate: number | null;
        surprisePct: number | null;
        postPrintMovePct: number | null;
      }>;
      summary: { avgAbsMovePct: number | null; beatCount: number; missCount: number; quarterCount: number };
    }
  >;
  // v10 — read-through pairs for the Worker's widened push-at-print gate (#13)
  readThroughPairs: Array<{
    reporter: string;
    target: string;
    weight: number;
    hypothesis: string | null;
  }>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

function daysAhead(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
}

function openReadOnly(): Database.Database {
  const dataDir = process.env.VANGUARD_DB_DIR || path.join(process.cwd(), "data");
  const dbPath = path.join(dataDir, "vanguard.db");
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function getHeldStockSymbolsRO(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.symbol
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE h.quantity > 0
         AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock')
         AND s.symbol IS NOT NULL
         AND s.symbol != ''
         AND h.as_of_date = (
           SELECT MAX(h2.as_of_date) FROM holdings h2
           WHERE h2.account_id = h.account_id
         )
       ORDER BY s.symbol`
    )
    .all() as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

/**
 * Active watchlist stock symbols (v8, Wave 1 §2 push-at-print). Lets the
 * Worker's cloud-enrich push hook cover watchlist names in addition to held
 * ones — a print push on a not-yet-owned symbol the user is tracking is
 * still useful, and pre-v8 the hook could only see `heldSymbols`.
 */
function getActiveWatchlistStockSymbolsRO(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.symbol) AS symbol
         FROM watchlist w
         JOIN securities s ON s.id = w.security_id
        WHERE w.is_active = 1
          AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock')
          AND s.symbol IS NOT NULL AND s.symbol != ''
        ORDER BY symbol`,
    )
    .all() as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

/**
 * Vanguard-only briefing holdings for the cloud briefing fallback. Reuses the
 * Mac single source (getBriefingHoldings → BRIEFING_EXCLUDE_IBKR_SQL) so the
 * IBKR-exclusion rule lives in exactly one place and the Worker never
 * re-implements it. Maps the DB row's snake_case net_qty to camelCase netQty.
 */
function getBriefingHoldingsForSnapshot(
  db: Database.Database,
): Array<{ symbol: string; name: string | null; sector: string | null; netQty: number }> {
  return getBriefingHoldings(db).map((h) => ({
    symbol: h.symbol,
    name: h.name,
    sector: h.sector,
    netQty: h.net_qty,
  }));
}

function getSettingValue(db: Database.Database, key: string): string | null {
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Returns all Vanguard (non-Roth) held securities of type Stock / ETF /
 * Mutual Fund — the set the evening digest cares about. Uses latest
 * as_of_date per (account, security) to avoid stale holdings surfacing.
 */
function getVanguardHoldingsForSnapshot(
  db: Database.Database
): Array<{ symbol: string; securityId: number; accountId: number }> {
  const rows = db
    .prepare(
      `SELECT s.symbol, h.security_id AS securityId, h.account_id AS accountId
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         JOIN accounts a ON a.id = h.account_id
        WHERE h.quantity > 0
          AND LOWER(a.name) LIKE '%vanguard%'
          AND LOWER(a.name) NOT LIKE '%roth%'
          AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock', 'etf', 'mutual fund')
          AND s.symbol IS NOT NULL
          AND s.symbol != ''
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date)
              FROM holdings h2
             WHERE h2.account_id = h.account_id
               AND h2.security_id = h.security_id
          )
        ORDER BY s.symbol`
    )
    .all() as Array<{ symbol: string; securityId: number; accountId: number }>;
  return rows;
}

/**
 * Returns all cached beta rows from security_betas.
 * The Worker uses these to rank holdings by systematic risk without
 * running a full regression in the cloud.
 */
function getSecurityBetas(
  db: Database.Database
): Array<{ securityId: number; lookbackDays: number; beta: number; residualStd: number | null; computedAt: string }> {
  const rows = db
    .prepare(
      `SELECT security_id AS securityId,
              lookback_days AS lookbackDays,
              beta,
              residual_std AS residualStd,
              computed_at AS computedAt
         FROM security_betas
        ORDER BY security_id, lookback_days`
    )
    .all() as Array<{ securityId: number; lookbackDays: number; beta: number; residualStd: number | null; computedAt: string }>;
  return rows;
}

const NOTE_CONTENT_CAP = 2_000;

/**
 * Security-linked user notes from the last 90 days. The Worker matches these
 * to an earnings event's issuer family via symbol / underlying_symbol. Notes
 * with no security_id (pure journal/macro) are excluded — they don't belong to
 * any one earnings family. Content capped to keep the snapshot small.
 */
function getNotesForSnapshot(db: Database.Database): Snapshot["notes"] {
  const rows = db
    .prepare(
      `SELECT n.id, n.note_type, n.content, n.event_date, n.sentiment, n.tags,
              s.symbol, s.underlying_symbol
         FROM notes n
         JOIN securities s ON s.id = n.security_id
        WHERE n.security_id IS NOT NULL
          AND datetime(n.event_date) >= datetime('now', '-90 days')
        ORDER BY n.event_date DESC, n.created_at DESC`,
    )
    .all() as Snapshot["notes"];
  return rows.map((n) => ({
    ...n,
    content:
      n.content && n.content.length > NOTE_CONTENT_CAP
        ? n.content.slice(0, NOTE_CONTENT_CAP) + "…"
        : n.content,
  }));
}

/**
 * Curated earnings bogeys for events inside the snapshot's calendar window, so
 * each bogey's event_id matches a calendarEvents row the Worker already has.
 */
function getEarningsBogeysForSnapshot(
  db: Database.Database,
  startDate: string,
  endDate: string,
): Snapshot["earningsBogeys"] {
  return db
    .prepare(
      `SELECT b.id, b.event_id, b.source, b.source_label, b.eps_consensus,
              b.eps_whisper, b.revenue_consensus_usd, b.revenue_whisper_usd,
              b.segment_breakdown_json, b.guidance_notes, b.notes, b.uploaded_at
         FROM earnings_bogeys b
         JOIN calendar_events e ON e.id = b.event_id
        WHERE e.event_date >= ? AND e.event_date <= ?
        ORDER BY b.uploaded_at DESC`,
    )
    .all(startDate, endDate) as Snapshot["earningsBogeys"];
}

/**
 * v9 — cached implied-move intel (earnings_intel, migration 065) for events
 * inside the snapshot's calendar window, so each row's eventId matches a
 * calendarEvents row the Worker already has (same join-key convention as
 * getEarningsBogeysForSnapshot above).
 */
function getEarningsIntelForSnapshot(
  db: Database.Database,
  startDate: string,
): Snapshot["earningsIntel"] {
  return db
    .prepare(
      `SELECT ei.event_id AS eventId, ce.source_key AS sourceKey,
              ei.implied_move_pct AS impliedMovePct, ei.implied_method AS impliedMethod,
              ei.expiry_used AS expiryUsed, ei.computed_at AS computedAt
         FROM earnings_intel ei
         JOIN calendar_events ce ON ce.id = ei.event_id
        WHERE ce.event_date >= ?`,
    )
    .all(startDate) as Snapshot["earningsIntel"];
}

/**
 * v9 — distinct upcoming-reporter symbols (earnings-type or Finnhub-sourced
 * calendar rows) in [startDate, endDate], mirroring how the script already
 * scopes earnings-adjacent queries by event_date window. Uppercased +
 * de-duped so it's a direct key set for getEarningsHistoryForSnapshot below.
 */
function getUpcomingEarningsSymbols(
  db: Database.Database,
  startDate: string,
  endDate: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT UPPER(ce.symbol) AS symbol
         FROM calendar_events ce
        WHERE (ce.event_type = 'earnings' OR ce.source = 'finnhub')
          AND ce.symbol IS NOT NULL AND ce.symbol != ''
          AND ce.event_date BETWEEN ? AND ?`,
    )
    .all(startDate, endDate) as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

/**
 * v9 — per-symbol surprise/reaction history (earnings_report_history) for
 * every upcoming reporter, capped at 8 rows each (matches the Mac composer's
 * `loadIntelView` cap). `summary` is computed HERE (Mac-side, via the same
 * `summarizeHistory` the composer uses) — the Worker never recomputes it,
 * it only renders the cached fields. Symbols with zero cached history are
 * omitted entirely (not an empty entry) so the Worker's `history ?? null`
 * fallback path is exercised identically to "never fetched".
 */
function getEarningsHistoryForSnapshot(
  db: Database.Database,
  symbols: string[],
): Snapshot["earningsHistory"] {
  const out: Snapshot["earningsHistory"] = {};
  for (const sym of symbols) {
    const rows = getReportHistoryForFamily(db, sym, 8);
    if (rows.length === 0) continue;
    out[sym] = {
      rows: rows.map((r) => ({
        reportedDate: r.reportedDate,
        epsActual: r.epsActual,
        epsEstimate: r.epsEstimate,
        surprisePct: r.surprisePct,
        postPrintMovePct: r.postPrintMovePct,
      })),
      summary: summarizeHistory(rows),
    };
  }
  return out;
}

function buildSnapshot(db: Database.Database): Snapshot {
  // Includes trailing-1-day so the Worker's cloud-enrich fallback can find
  // same-day-before-midnight releases that still need enrichment when the
  // Mac was unreachable during the [release, release+2h] window. SELECT *
  // already pulls release_time / actual_value / enriched_at / reaction_snapshot
  // so Phase 9b parity needs no column additions here.
  const calendarEvents = db
    .prepare(
      `SELECT * FROM calendar_events
         WHERE event_date >= ? AND event_date <= ?
         ORDER BY event_date, event_time`
    )
    .all(daysAgo(1), daysAhead(CALENDAR_LOOKAHEAD_DAYS)) as Record<string, unknown>[];

  const researchSources = db
    .prepare(
      `SELECT id, name, sender_email, sender_pattern, subject_pattern,
              is_active, fetch_frequency, max_age_days, processing_prompt,
              website_url
         FROM research_sources
         ORDER BY id`
    )
    .all() as Record<string, unknown>[];

  const recentArticlesMeta = db
    .prepare(
      `SELECT a.id, a.source_id, s.name AS source_name, a.gmail_message_id,
              a.received_at, a.subject, a.sender, a.summary, a.key_themes,
              a.sentiment, a.sentiment_score, a.mentioned_symbols,
              a.portfolio_relevance, a.source_url, s.website_url,
              a.processed_at, a.ai_model
         FROM research_articles a
         JOIN research_sources s ON s.id = a.source_id
         WHERE a.received_at >= ?
         ORDER BY a.received_at DESC`
    )
    .all(daysAgo(RECENT_META_DAYS)) as Record<string, unknown>[];

  const deepCutoff = new Date(Date.now() - DEEP_READ_HOURS * 3600_000).toISOString();
  const placeholders = DEEP_READ_SOURCE_IDS.map(() => "?").join(",");
  const deepRaw = db
    .prepare(
      `SELECT a.id, a.source_id, s.name AS source_name, a.received_at,
              a.subject, a.raw_text, a.raw_html, a.source_url
         FROM research_articles a
         JOIN research_sources s ON s.id = a.source_id
         WHERE a.source_id IN (${placeholders})
           AND a.received_at >= ?
         ORDER BY a.received_at DESC`
    )
    .all(...DEEP_READ_SOURCE_IDS, deepCutoff) as {
      id: number;
      source_id: number;
      source_name: string;
      received_at: string;
      subject: string;
      raw_text: string | null;
      raw_html: string | null;
      source_url: string | null;
    }[];

  const deepReadArticles = deepRaw.map((a) => ({
    ...a,
    raw_text: a.raw_text?.slice(0, MAX_DEEP_READ_CHARS) ?? null,
    raw_html: null, // drop HTML — body is already in raw_text
  }));

  // Phase 4 — earnings cloud-fallback context. Cross-account latest holdings
  // (matches per-account MAX(as_of_date) per CLAUDE.md), full securities table
  // (Worker needs underlying_symbol to roll options into family positions),
  // accounts (id → name for the position block), audit rows (so Worker can
  // skip events Mac already fired), and earnings settings (master toggle +
  // muted symbols). Anything else the Mac composer reads (newsletters,
  // analyst recs, transcripts, notes) is intentionally NOT in the fallback —
  // the cloud email is a leaner "actuals + reaction + positions" version
  // with a footer disclosing limited context.
  // Cost basis fallback: Plaid sync writes cost_basis = NULL on holdings
  // rows. Statement imports write the same (account, security) pair with
  // cost_basis populated on the period-end date. Without this COALESCE,
  // the first Plaid sync would blank out return-% disclosures in every
  // Worker cloud-fallback earnings email — mirrors
  // lib/digest/send-earnings-email.ts::getCrossAccountPositions and
  // lib/queries/holdings.ts::getAllHoldings/getHoldingsByAccount.
  const holdings = db
    .prepare(
      `SELECT h.id, h.account_id, h.security_id, h.quantity,
              COALESCE(
                h.cost_basis,
                (SELECT h3.cost_basis FROM holdings h3
                  WHERE h3.account_id = h.account_id
                    AND h3.security_id = h.security_id
                    AND h3.cost_basis IS NOT NULL
                  ORDER BY h3.as_of_date DESC LIMIT 1)
              ) AS cost_basis,
              h.as_of_date
         FROM holdings h
        WHERE h.quantity != 0
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id
               AND h2.security_id = h.security_id
          )`,
    )
    .all() as Record<string, unknown>[];

  const securities = db
    .prepare(
      `SELECT id, symbol, name, security_type, asset_class, sector,
              underlying_symbol, option_type, strike_price, expiration_date, multiplier
         FROM securities`,
    )
    .all() as Record<string, unknown>[];

  const accounts = db
    .prepare(`SELECT id, name FROM accounts`)
    .all() as Record<string, unknown>[];

  const earningsEmails = db
    .prepare(
      `SELECT id, event_id, phase, recipient, sent_at, error
         FROM earnings_emails
        WHERE datetime(sent_at) >= datetime('now', '-3 days')
        ORDER BY sent_at DESC`,
    )
    .all() as Record<string, unknown>[];

  const earningsEnabledRow = db
    .prepare(`SELECT value FROM settings WHERE key = 'earnings_emails_enabled'`)
    .get() as { value: string } | undefined;
  const earningsMutedRow = db
    .prepare(`SELECT value FROM settings WHERE key = 'earnings_emails_muted_symbols'`)
    .get() as { value: string } | undefined;

  const securityLevels = db
    .prepare(
      `SELECT sl.id, sl.security_id, s.symbol, sl.level_type, sl.price,
              sl.direction, sl.source, sl.source_author, sl.expires_at
         FROM security_levels sl
         JOIN securities s ON s.id = sl.security_id
         WHERE sl.is_active = 1
           AND sl.review_status = 'auto_approved'
           AND sl.price_source = 'static'
           AND (sl.expires_at IS NULL OR sl.expires_at >= date('now'))`,
    )
    .all() as Array<{
      id: number;
      security_id: number;
      symbol: string;
      level_type: string;
      price: number;
      direction: string | null;
      source: string;
      source_author: string | null;
      expires_at: string | null;
    }>;

  // v9 — earnings intelligence. `earningsIntelStartDate` mirrors the
  // trailing-1-day convention used everywhere else in this function (same-day
  // releases stay visible); the history window looks 14 days ahead, matching
  // how far out a "next print" is worth caching surprise/reaction context for.
  const earningsIntelStartDate = daysAgo(1);
  const upcomingEarningsSymbols = getUpcomingEarningsSymbols(
    db,
    earningsIntelStartDate,
    daysAhead(14),
  );

  return {
    schemaVersion: 10,
    snapshotDate: today(),
    generatedAt: new Date().toISOString(),
    heldSymbols: getHeldStockSymbolsRO(db),
    settings: {
      last_digest_sent_at: getSettingValue(db, "last_digest_sent_at"),
      last_briefing_sent_at: getSettingValue(db, "last_briefing_sent_at"),
      // v3 additions — recipient overrides (null until Phase 6 UI surfaces them)
      evening_email_recipients: getSettingValue(db, "evening_email_recipients"),
      digest_email_recipients: getSettingValue(db, "digest_email_recipients"),
      briefing_email_recipients: getSettingValue(db, "briefing_email_recipients"),
      // v3 additions — observability ring buffer for synthesis fallbacks
      synthesis_fallbacks_last_30d: getSettingValue(db, "synthesis_fallbacks_last_30d"),
    },
    calendarEvents,
    researchSources,
    recentArticlesMeta,
    deepReadArticles,
    holdings,
    securities,
    accounts,
    earningsEmails,
    earningsSettings: {
      enabled: earningsEnabledRow ? earningsEnabledRow.value === "1" || earningsEnabledRow.value.toLowerCase() === "true" : true,
      mutedSymbols: earningsMutedRow
        ? earningsMutedRow.value.split(",").map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0)
        : [],
    },
    // v3 additions
    vanguardHoldings: getVanguardHoldingsForSnapshot(db),
    securityBetas: getSecurityBetas(db),
    // v4 — static price levels for cloud-side scan
    securityLevels,
    // v5 — earnings-email enrichment context
    notes: getNotesForSnapshot(db),
    earningsBogeys: getEarningsBogeysForSnapshot(
      db,
      daysAgo(1),
      daysAhead(CALENDAR_LOOKAHEAD_DAYS),
    ),
    // v6 — available Anthropic model ids for Worker tier resolution + failover.
    // Returns [] when the Mac has never run a catalog refresh (travel, fresh install).
    modelCatalog: getModelCatalog(db),
    // v7 — Vanguard-only briefing holdings (IBKR excluded). Single-sourced from
    // the Mac's getBriefingHoldings so the cloud briefing matches the real one.
    briefingHoldings: getBriefingHoldingsForSnapshot(db),
    // v8 — active watchlist stock symbols for the Worker's push-at-print hook.
    watchlistSymbols: getActiveWatchlistStockSymbolsRO(db),
    // v9 — earnings intelligence: implied move per upcoming event + per-symbol
    // surprise/reaction history. Lets the Worker's scoreboard render the
    // "Expected move (options)" / "Avg move last 8 prints" rows.
    earningsIntel: getEarningsIntelForSnapshot(db, earningsIntelStartDate),
    earningsHistory: getEarningsHistoryForSnapshot(db, upcomingEarningsSymbols),
    // v10 — read-through pairs (#13). The Worker's push-at-print hook widens
    // its gate to non-held reporters with a live read-through target. Whole
    // table shipped — it's small and user-curated.
    readThroughPairs: db
      .prepare(
        `SELECT reporter_symbol AS reporter, target_symbol AS target, weight, hypothesis
           FROM read_through_pairs ORDER BY weight DESC, reporter_symbol ASC`,
      )
      .all() as Snapshot["readThroughPairs"],
  };
}

async function pruneOldSnapshots(keepFromDate: string): Promise<number> {
  const keys = await listObjects("state/vanguard-state-");
  let deleted = 0;
  for (const key of keys) {
    const m = key.match(/vanguard-state-(\d{4}-\d{2}-\d{2})\.json\.gz$/);
    if (!m) continue;
    if (m[1] < keepFromDate) {
      await deleteObject(key);
      deleted++;
    }
  }
  return deleted;
}

async function main() {
  if (!isR2Configured()) {
    console.error("R2 not configured. Set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.");
    process.exit(1);
  }

  const db = openReadOnly();
  const snapshot = buildSnapshot(db);
  db.close();

  const key = `state/vanguard-state-${snapshot.snapshotDate}.json.gz`;
  const t0 = Date.now();
  await putGzippedJson(key, snapshot);
  const uploadMs = Date.now() - t0;

  console.log(
    `[snapshot] uploaded ${key} (v${snapshot.schemaVersion}) in ${uploadMs}ms — ` +
      `${snapshot.heldSymbols.length} symbols, ` +
      `${snapshot.calendarEvents.length} events, ` +
      `${snapshot.researchSources.length} sources, ` +
      `${snapshot.recentArticlesMeta.length} article-meta, ` +
      `${snapshot.deepReadArticles.length} deep-read, ` +
      `${snapshot.holdings.length} holdings, ` +
      `${snapshot.securities.length} securities, ` +
      `${snapshot.earningsEmails.length} audit rows, ` +
      `${snapshot.vanguardHoldings.length} vanguard-holdings, ` +
      `${snapshot.briefingHoldings.length} briefing-holdings, ` +
      `${snapshot.securityBetas.length} betas, ` +
      `${snapshot.notes.length} notes, ` +
      `${snapshot.earningsBogeys.length} bogeys, ` +
      `${snapshot.modelCatalog.length} model-catalog, ` +
      `${snapshot.watchlistSymbols.length} watchlist-symbols, ` +
      `${snapshot.earningsIntel.length} earnings-intel, ` +
      `${Object.keys(snapshot.earningsHistory).length} earnings-history-symbols`
  );

  const keepFromDate = daysAgo(SNAPSHOT_RETENTION_DAYS);
  const pruned = await pruneOldSnapshots(keepFromDate);
  if (pruned > 0) {
    console.log(`[snapshot] pruned ${pruned} snapshots older than ${keepFromDate}`);
  }
}

main().catch((err) => {
  console.error("[snapshot] fatal:", err);
  process.exit(1);
});
