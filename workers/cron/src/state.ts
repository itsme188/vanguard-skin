/**
 * R2 state snapshot reader.
 *
 * The Mac writes `state/vanguard-state-{YYYY-MM-DD}.json.gz` nightly at 2am
 * (see scripts/snapshot-state-to-r2.ts). The Worker reads the latest-by-date
 * snapshot as the basis for cloud-fallback briefing/digest generation.
 *
 * Snapshot schema mirrors SnapshotV1 in the Mac script. Keeping the types in
 * sync with the script is manual — if the Mac adds fields, this file needs
 * updating. Low cost: 1 file, flat structure, snapshot format is versioned
 * so mismatches surface clearly.
 */

export interface ResearchSource {
  id: number;
  name: string;
  sender_email: string | null;
  sender_pattern: string | null;
  subject_pattern: string | null;
  is_active: number;
  fetch_frequency: string;
  max_age_days: number;
  processing_prompt: string | null;
  website_url: string | null;
}

export interface RecentArticleMeta {
  id: number;
  source_id: number;
  source_name: string;
  gmail_message_id: string | null;
  received_at: string;
  subject: string;
  sender: string;
  summary: string | null;
  key_themes: string | null;
  sentiment: string | null;
  sentiment_score: number | null;
  mentioned_symbols: string | null;
  portfolio_relevance: string | null;
  source_url: string | null;
  website_url: string | null;
  processed_at: string | null;
  ai_model: string | null;
}

export interface DeepReadArticle {
  id: number;
  source_id: number;
  source_name: string;
  received_at: string;
  subject: string;
  raw_text: string | null;
  raw_html: string | null;
  source_url: string | null;
}

export interface CalendarEventRow {
  id: number;
  source: string;
  event_type: string;
  event_date: string;
  event_time: string | null;
  title: string;
  description: string | null;
  security_id: number | null;
  symbol: string | null;
  expected_impact: string | null;
  consensus_estimate: string | null;
  previous_value: string | null;
  raw_json: string | null;
  [k: string]: unknown;
}

export interface HoldingRow {
  id: number;
  account_id: number;
  security_id: number;
  quantity: number;
  cost_basis: number | null;
  as_of_date: string;
}

export interface SecurityRow {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
  asset_class: string | null;
  sector: string | null;
  underlying_symbol: string | null;
  option_type: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  multiplier: number | null;
}

export interface AccountRow {
  id: number;
  name: string;
}

export interface EarningsEmailRow {
  id: number;
  event_id: number;
  phase: "preview" | "recap";
  recipient: string;
  sent_at: string;
  error: string | null;
}

/**
 * Active static price level — Worker-side cloud scan target.
 *
 * Only `price_source = 'static'` levels are mirrored to v4 snapshots; MA-based
 * levels (sma_*, ema_*) require OHLCV bars to resolve effective_price and stay
 * Mac-only for now. ~90% coverage of typical user levels at current volumes.
 */
export interface SecurityLevelRow {
  id: number;
  security_id: number;
  symbol: string;
  level_type: string;
  price: number;
  direction: string | null;
  source: string;
  source_author: string | null;
  expires_at: string | null;
  /**
   * Set when the level was force-armed on the Mac while already past its
   * threshold (approveLevelGuarded, force:true) — lets the cloud-side scan
   * disclose "was already past this level when armed" instead of presenting
   * it as a fresh cross. Optional so snapshots from before this field existed
   * still parse (undefined treated the same as null).
   */
  armed_crossed_at?: string | null;
}

/**
 * A user thesis/journal note attached to a security — mirrored so the cloud
 * earnings email can frame the briefing against the user's own prior view
 * instead of disclosing "limited context". `underlying_symbol` lets the Worker
 * match an option's note to its underlying's earnings family.
 */
export interface SnapshotNote {
  id: number;
  note_type: string;
  content: string;
  event_date: string;
  sentiment: string | null;
  tags: string | null;
  symbol: string | null;
  underlying_symbol: string | null;
}

/**
 * A user-curated earnings bogey (consensus + whisper) for a specific
 * calendar event — the only place whisper numbers reach the email (Finnhub
 * doesn't carry them). Matched to a candidate by `event_id`.
 */
export interface SnapshotBogey {
  id: number;
  event_id: number;
  source: string;
  source_label: string | null;
  eps_consensus: number | null;
  eps_whisper: number | null;
  revenue_consensus_usd: number | null;
  revenue_whisper_usd: number | null;
  /** Absolute percent — sheet-stated expected move (feedback #5). Optional:
   * snapshots written before 2026-08-03 lack the field. */
  expected_move_pct?: number | null;
  segment_breakdown_json: string | null;
  guidance_notes: string | null;
  notes: string | null;
  uploaded_at: string;
}

/**
 * Snapshot schema is forward-compatible:
 *   v1 — briefing/digest only
 *   v2 — adds earnings cloud-fallback context (holdings, securities, etc.)
 *   v3 — adds vanguardHoldings + securityBetas for evening-email fallback
 *        + recipient override fields in settings
 *   v4 — adds securityLevels (static price levels) for cloud-side scan +
 *        Pushover fan-out when Mac is asleep
 *   v5 — adds notes + earningsBogeys so the cloud earnings email carries the
 *        user's own thesis notes + curated consensus/whisper (closes part of
 *        the "limited cloud context" gap)
 *   v6 — adds modelCatalog (available Anthropic model ids) for tier-aware
 *        model resolution + reactive failover in Worker fallbacks
 *   v7 — adds briefingHoldings (Vanguard-only, IBKR excluded) for the cloud
 *        briefing fallback
 *   v8 — adds watchlistSymbols for the push-at-print hook's watchlist coverage
 *   v10 — adds readThroughPairs (#13 read-through push at print)
 *   v9 — adds earningsIntel (implied move per upcoming event) + earningsHistory
 *        (per-symbol surprise/reaction history) so the cloud scoreboard can
 *        render the same "Expected move" / "Avg move last 8 prints"
 *        rows as the Mac composer, with an as-of label since the cloud copy
 *        can be hours stale
 *
 * All v2–v9 fields are optional for back-compat with older snapshots; the
 * fallback gracefully degrades when these are missing.
 */
/**
 * Vanguard-only briefing holding (IBKR excluded — see the Mac
 * BRIEFING_EXCLUDE_IBKR_SQL / getBriefingHoldings single source). The cloud
 * briefing renders this instead of the cross-account `heldSymbols` flat list so
 * it never surfaces the IBKR trading book as research holdings.
 */
export interface BriefingHoldingSnapshot {
  symbol: string;
  name: string | null;
  sector: string | null;
  /** Cross-account net quantity (positive = long, negative = short). */
  netQty: number;
}

/**
 * Cached implied-move intelligence for one upcoming earnings event, mirrored
 * from the Mac's `earnings_intel` table (migration 065). `sourceKey` is
 * carried for potential future audit joins but the Worker matches on
 * `eventId` (same as `snapshot.calendarEvents[].id`), same as the Mac.
 */
export interface EarningsIntelSnapshotRow {
  eventId: number;
  sourceKey: string;
  impliedMovePct: number | null;
  impliedMethod: "straddle" | "iv_approx" | null;
  expiryUsed: string | null;
  computedAt: string;
}

/** One past-print history row — mirrors Mac's `ReportHistoryRow` subset used downstream. */
export interface EarningsHistorySnapshotRow {
  reportedDate: string;
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
  postPrintMovePct: number | null;
}

/**
 * Per-symbol history entry — `summary` is computed Mac-side via
 * `summarizeHistory` (lib/earnings/report-history.ts) and carried verbatim;
 * the Worker never recomputes it from `rows`.
 */
export interface EarningsHistorySnapshotEntry {
  rows: EarningsHistorySnapshotRow[];
  summary: {
    avgAbsMovePct: number | null;
    beatCount: number;
    missCount: number;
    quarterCount: number;
  };
}

export interface Snapshot {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  snapshotDate: string;
  generatedAt: string;
  heldSymbols: string[];
  settings: {
    last_digest_sent_at: string | null;
    last_briefing_sent_at: string | null;
    // v3 additions — recipient overrides (null until Phase 6 UI surfaces them)
    evening_email_recipients?: string | null;
    digest_email_recipients?: string | null;
    briefing_email_recipients?: string | null;
    // v3 additions — synthesis-fallback observability
    synthesis_fallbacks_last_30d?: string | null;
  };
  calendarEvents: CalendarEventRow[];
  researchSources: ResearchSource[];
  recentArticlesMeta: RecentArticleMeta[];
  deepReadArticles: DeepReadArticle[];
  // Phase 4 — earnings cloud fallback. Optional for back-compat with v1
  // snapshots; the fallback gracefully degrades when these are missing.
  holdings?: HoldingRow[];
  securities?: SecurityRow[];
  accounts?: AccountRow[];
  earningsEmails?: EarningsEmailRow[];
  earningsSettings?: {
    enabled: boolean;
    mutedSymbols: string[];
  };
  // v3 — evening-email fallback fields. Optional for back-compat with v1/v2.
  vanguardHoldings?: Array<{ symbol: string; securityId: number; accountId: number }>;
  securityBetas?: Array<{ securityId: number; lookbackDays: number; beta: number; residualStd?: number | null; computedAt: string }>;
  // v4 — cloud-side level scan. Static levels only; MA-based levels stay Mac-only.
  securityLevels?: SecurityLevelRow[];
  // v5 — earnings-email enrichment. Optional for back-compat with v1–v4.
  notes?: SnapshotNote[];
  earningsBogeys?: SnapshotBogey[];
  // v6 — available Anthropic model ids (from /v1/models, cached in Mac `settings`).
  // Used by Worker fallbacks for tier-aware model resolution + reactive failover.
  // Optional for back-compat with v1–v5 snapshots; falls back to [] → TIER_STATIC_FALLBACK.
  modelCatalog?: string[];
  // v7 — Vanguard-only briefing holdings (IBKR excluded, mirrors the Mac's
  // BRIEFING_EXCLUDE_IBKR_SQL). The cloud briefing renders these so it never
  // re-surfaces the IBKR trading book. Optional for back-compat: pre-v7
  // snapshots fall back to the cross-account `heldSymbols` flat list.
  briefingHoldings?: BriefingHoldingSnapshot[];
  // v8 — active watchlist stock symbols (Wave 1 §2 push-at-print). Lets the
  // Worker's cloud-enrich push hook cover watchlist names, not just held
  // ones. Additive/optional for back-compat: snapshots ≤v7 lack this field
  // and the push hook gracefully degrades to held-only coverage.
  watchlistSymbols?: string[];
  // v9 — earnings intelligence: implied move per upcoming event (event_date
  // >= daysAgo(1)) + per-symbol surprise/reaction history for symbols
  // reporting in the next 14 days. Optional/additive: snapshots ≤v8 lack both
  // fields and `renderScoreboard`'s intelCtx param stays undefined, rendering
  // exactly the classic scoreboard (no "Expected move" / "Avg move" rows).
  earningsIntel?: EarningsIntelSnapshotRow[];
  earningsHistory?: Record<string, EarningsHistorySnapshotEntry>;
  // v10 — read-through pairs (#13): the push-at-print hook widens its gate
  // to non-held reporters with a live (held/watchlist) read-through target,
  // and carries "→ TARGET (status): hypothesis" lines. Optional/additive:
  // snapshots ≤v9 lack the field and the hook keeps held/watchlist-only.
  readThroughPairs?: ReadThroughPairSnapshotRow[];
}

export interface ReadThroughPairSnapshotRow {
  reporter: string;
  target: string;
  weight: number;
  hypothesis: string | null;
}

/** Fetch the most recent snapshot (within 7d). Returns null if none exist. */
export async function loadLatestSnapshot(bucket: R2Bucket): Promise<Snapshot | null> {
  const list = await bucket.list({ prefix: "state/vanguard-state-" });
  if (list.objects.length === 0) return null;

  // Keys sort lexicographically = chronologically for YYYY-MM-DD dates.
  const latest = list.objects.sort((a, b) => (a.key < b.key ? 1 : -1))[0];
  const obj = await bucket.get(latest.key);
  if (!obj) return null;

  // Decompress with Workers-native DecompressionStream.
  const decompressed = obj.body.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(decompressed).text();
  return JSON.parse(text) as Snapshot;
}
