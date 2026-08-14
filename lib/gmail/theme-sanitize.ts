/**
 * Model-boundary guards for tagged-remnant summaries and theme lists.
 *
 * Zero-import, pure-function module (no better-sqlite3 / AI SDK / server-only
 * deps) — split out of lib/gmail/process.ts (2026-07-23) specifically so it's
 * safe to import from a "use client" component. lib/gmail/process.ts pulls in
 * @/lib/ai/generate → @/lib/ai/provider → @anthropic-ai/sdk transitively,
 * which is fine server-side but must never ship into a client bundle.
 *
 * Re-exported from lib/gmail/process.ts so every existing importer
 * (extractWithClaude, digest render sites, repair scripts, tests) keeps
 * working unchanged; new client-side callers (ResearchFeedsView's
 * ThemePills) import this module directly.
 */

// The model intermittently dumps its ENTIRE tagged response inside the
// `summary` string field ("...</summary>\n<key_themes">[...]<sentiment>...").
// jsonSchema() can't catch that — the field IS a valid string — so guard at
// the storage boundary (same family as the key_themes-as-string normalize
// below). Matches partial/malformed tags too (<key_themes"> was observed
// live). Worker mirror: workers/cron/src/fallback-digest.ts.
const SUMMARY_TAG_REMNANT =
  /<\/?(?:summary|key_themes|sentiment_score|sentiment|mentioned_symbols|portfolio_relevance|is_portfolio_relevant|parameter)\b/i;

// Sibling guard for a JSON-shaped variant of the same leak (2026-08-14,
// research_articles rows 71098/71094/68064, ALL via the cloud-fallback
// path): no XML tags at all this time — the model dumps the rest of the
// raw tool-call JSON envelope as literal text inside the `summary` string
// ("...ends here.", "key_themes": [...], "sentiment": "bullish",
// "sentiment_score": 0.55, "mentioned_symbols": [...]"). A quoted schema
// field name glued directly to a colon essentially never occurs in prose,
// so it's a safe cut signal — same family as SUMMARY_TAG_REMNANT above.
// Worker mirror: workers/cron/src/fallback-digest.ts.
const SUMMARY_JSON_ENVELOPE_REMNANT =
  /"(?:key_themes|sentiment_score|sentiment|mentioned_symbols|portfolio_relevance|is_portfolio_relevant)"\s*:/i;

export function sanitizeModelSummary(raw: string): string {
  if (!raw) return "";
  const s = raw.replace(/^\s*<summary[^>]*>\s*/i, "");
  const tagCut = s.search(SUMMARY_TAG_REMNANT);
  const jsonCut = s.search(SUMMARY_JSON_ENVELOPE_REMNANT);
  const cuts = [tagCut, jsonCut].filter((i) => i !== -1);
  if (cuts.length === 0) return s.trim();
  // Trim trailing separator debris left by the cut (e.g. the `", ` that
  // precedes the next JSON key) — same boundary-strip idea as
  // cleanThemeElement below, applied only when a remnant was actually found.
  return s.slice(0, Math.min(...cuts)).replace(/[",\s]+$/, "").trim();
}

/**
 * key_themes twin of sanitizeModelSummary: the model intermittently wraps a
 * theme element in structured-output tag debris (`<parameter
 * name="key_themes">["theme"` — the 2026-07-22 Research Desk leak, row
 * 55380) or leaves stray brackets/quotes from a JSON-in-string dump. Every
 * upstream guard only filtered NON-STRING elements, so contaminated strings
 * sailed through to the rendered italics line. Clean per element at the
 * storage boundary AND at render (old rows). Worker semantic mirror:
 * workers/cron/src/fallback-digest.ts::normalizeThemes.
 *
 * The boundary-strip class deliberately excludes a bare `'` — a trailing
 * single quote is legitimate content when a theme closes a scare-quoted
 * phrase or possessive ("...gone parabolic'", "banks' pricing power"); no
 * observed contamination relies on stripping it, only `<`/`>`/`"`/`[`/`]`
 * debris (2026-07-23 review finding — the pre-fix class clipped live rows).
 */
const THEME_TAG_STRIP = /<\/?(?:summary|key_themes|sentiment_score|sentiment|mentioned_symbols|portfolio_relevance|is_portfolio_relevant|parameter)\b[^>]*>?/gi;

function cleanThemeElement(raw: string): string {
  const cleaned = raw
    .replace(THEME_TAG_STRIP, " ")
    .replace(/^[\s"[\]]+|[\s"[\]]+$/g, "")
    .trim();
  // A leftover incomplete tag opening (e.g. "<par" from a truncated
  // "<parameter") is pure debris, not real theme content — drop it outright
  // rather than let a bare tag fragment survive as a garbage theme string.
  return /^<\/?[a-zA-Z_]*$/.test(cleaned) ? "" : cleaned;
}

export function sanitizeThemeList(v: unknown): string[] {
  const parts = Array.isArray(v)
    ? v.filter((t): t is string => typeof t === "string")
    : typeof v === "string"
      ? v.split(",")
      : [];
  return parts.map(cleanThemeElement).filter((t) => t.length > 0).slice(0, 5);
}
