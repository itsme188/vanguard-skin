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
}

/**
 * Snapshot schema is forward-compatible:
 *   v1 — briefing/digest only
 *   v2 — adds earnings cloud-fallback context (holdings, securities, etc.)
 *   v3 — adds vanguardHoldings + securityBetas for evening-email fallback
 *        + recipient override fields in settings
 *   v4 — adds securityLevels (static price levels) for cloud-side scan +
 *        Pushover fan-out when Mac is asleep
 *
 * All v2/v3/v4 fields are optional for back-compat with older snapshots; the
 * fallback gracefully degrades when these are missing.
 */
export interface Snapshot {
  schemaVersion: 1 | 2 | 3 | 4;
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
  securityBetas?: Array<{ securityId: number; lookbackDays: number; beta: number; computedAt: string }>;
  // v4 — cloud-side level scan. Static levels only; MA-based levels stay Mac-only.
  securityLevels?: SecurityLevelRow[];
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
