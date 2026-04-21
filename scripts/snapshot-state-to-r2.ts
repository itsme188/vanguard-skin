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

const DEEP_READ_SOURCE_IDS = [1, 18, 19, 28]; // VK, Eliant, Purple Drink, Meisler
const DEEP_READ_HOURS = 72;
const MAX_DEEP_READ_CHARS = 30_000;
const RECENT_META_DAYS = 14;
const CALENDAR_LOOKAHEAD_DAYS = 7;
const SNAPSHOT_RETENTION_DAYS = 7;

interface Snapshot {
  schemaVersion: 1;
  snapshotDate: string;
  generatedAt: string;
  heldSymbols: string[];
  settings: {
    last_digest_sent_at: string | null;
    last_briefing_sent_at: string | null;
  };
  calendarEvents: Record<string, unknown>[];
  researchSources: Record<string, unknown>[];
  recentArticlesMeta: Record<string, unknown>[];
  deepReadArticles: Record<string, unknown>[];
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

function getSettingValue(db: Database.Database, key: string): string | null {
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function buildSnapshot(db: Database.Database): Snapshot {
  const calendarEvents = db
    .prepare(
      `SELECT * FROM calendar_events
         WHERE event_date >= ? AND event_date <= ?
         ORDER BY event_date, event_time`
    )
    .all(today(), daysAhead(CALENDAR_LOOKAHEAD_DAYS)) as Record<string, unknown>[];

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

  return {
    schemaVersion: 1,
    snapshotDate: today(),
    generatedAt: new Date().toISOString(),
    heldSymbols: getHeldStockSymbolsRO(db),
    settings: {
      last_digest_sent_at: getSettingValue(db, "last_digest_sent_at"),
      last_briefing_sent_at: getSettingValue(db, "last_briefing_sent_at"),
    },
    calendarEvents,
    researchSources,
    recentArticlesMeta,
    deepReadArticles,
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
    `[snapshot] uploaded ${key} in ${uploadMs}ms — ` +
      `${snapshot.heldSymbols.length} symbols, ` +
      `${snapshot.calendarEvents.length} events, ` +
      `${snapshot.researchSources.length} sources, ` +
      `${snapshot.recentArticlesMeta.length} article-meta, ` +
      `${snapshot.deepReadArticles.length} deep-read`
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
