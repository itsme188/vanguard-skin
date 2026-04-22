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

export interface Snapshot {
  schemaVersion: 1;
  snapshotDate: string;
  generatedAt: string;
  heldSymbols: string[];
  settings: {
    last_digest_sent_at: string | null;
    last_briefing_sent_at: string | null;
  };
  calendarEvents: CalendarEventRow[];
  researchSources: ResearchSource[];
  recentArticlesMeta: RecentArticleMeta[];
  deepReadArticles: DeepReadArticle[];
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
