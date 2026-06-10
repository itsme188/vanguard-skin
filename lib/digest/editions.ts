/**
 * editions.ts — Edition classifier + source-kind registry for the digest composer.
 *
 * Newsletter publication schedules are stable external facts; they live here as
 * tested constants (same philosophy as RELEASE_TIMES_ET / issuerSiblings), NOT
 * in the synthesis prompt.
 *
 * Worker mirror: workers/cron/src/editions.ts is a byte-parity hand-copy
 * (Next.js path-alias boundary, like presence-only-position.ts). Keep both in
 * sync; workers/cron/test/editions.test.ts enforces parity.
 */

export type SourceKind = "commentary" | "essay";

export type EditionId =
  | "dawn"
  | "bmo_news"
  | "midday"
  | "recap"
  | "amc_news"
  | "weekend"
  | "catalyst_watch"
  | "talking_points"
  | "one_off"
  | "morning_wrap"
  | "eod_wrap"
  | "note"
  | "standalone";

export interface EditionInfo {
  edition: EditionId;
  /** Earlier editions of the same daily cycle that this one supersedes. */
  supersedes: EditionId[];
}

/**
 * Source name → kind. Keyed by research_sources.name. Unknown sources default
 * to "essay" (safe: essays are listed individually, never merged).
 * Moving a source between kinds is a one-line edit here.
 */
export const SOURCE_KINDS: Record<string, SourceKind> = {
  // commentary — time-sensitive market narration; value is what's NEW today
  "Vital Knowledge": "commentary",
  "TMT Breakout": "commentary",
  "Purple Drink's Market Musings": "commentary",
  "Helene Meisler": "commentary",
  "Torsten Slok": "commentary",
  "TBPN": "commentary",
  "James Bulltard": "commentary",
  "FundaAI": "commentary",
  "JRo's Notes": "commentary",
  // essay — timeless research; value is the argument itself
  "Stratechery Updates": "essay",
  "The Diff": "essay",
  "MBI Deep Dives": "essay",
  "Semi Doped": "essay",
  "Eliant Capital": "essay",
  "Paul Kedrosky": "essay",
  "Sam Ro from TKer": "essay",
  "Liberty’s Highlights": "essay",
  "BEP Research": "essay",
  "Simon Willison": "essay",
  "Irrational Analysis": "essay",
  "Mobile Dev Memo": "essay",
  "Bloomberg Odd Lots": "essay",
  "Northbeam - The Media Buyer": "essay",
  "Consumer Ascent": "essay",
  "TickerTrends Research": "essay",
  "Sharp Text": "essay",
  "Emerging AI": "essay",
  "Investing With Martin": "essay",
};

export function sourceKind(sourceName: string): SourceKind {
  return SOURCE_KINDS[sourceName] ?? "essay";
}

interface EditionPattern {
  pattern: RegExp;
  edition: EditionId;
  supersedes: EditionId[];
}

/**
 * Ordered pattern tables — first match wins, so more specific patterns
 * (talking_points, whose subject contains the word "Recap") come before
 * broader ones.
 */
const VITAL_KNOWLEDGE_PATTERNS: EditionPattern[] = [
  { pattern: /Talking Points/i, edition: "talking_points", supersedes: [] },
  { pattern: /Catalyst Watch/i, edition: "catalyst_watch", supersedes: [] },
  { pattern: /Vital Weekend/i, edition: "weekend", supersedes: [] },
  { pattern: /Vital Dawn/i, edition: "dawn", supersedes: [] },
  { pattern: /Mid-Day Market Update/i, edition: "midday", supersedes: ["dawn"] },
  { pattern: /Vital Market Recap/i, edition: "recap", supersedes: ["midday", "dawn"] },
  { pattern: /Company-specific news.*\(BMO\)/i, edition: "bmo_news", supersedes: [] },
  { pattern: /Company-specific news.*\(AMC\)/i, edition: "amc_news", supersedes: [] },
];

const TMT_BREAKOUT_PATTERNS: EditionPattern[] = [
  { pattern: /Morning Wrap/i, edition: "morning_wrap", supersedes: [] },
  { pattern: /EOD Wrap/i, edition: "eod_wrap", supersedes: [] },
];

const PATTERN_TABLES: Record<string, { patterns: EditionPattern[]; fallback: EditionId }> = {
  "Vital Knowledge": { patterns: VITAL_KNOWLEDGE_PATTERNS, fallback: "one_off" },
  "TMT Breakout": { patterns: TMT_BREAKOUT_PATTERNS, fallback: "note" },
};

export function classifyEdition(sourceName: string, subject: string): EditionInfo {
  const table = PATTERN_TABLES[sourceName];
  if (!table) return { edition: "standalone", supersedes: [] };
  for (const { pattern, edition, supersedes } of table.patterns) {
    if (pattern.test(subject)) return { edition, supersedes };
  }
  return { edition: table.fallback, supersedes: [] };
}

/**
 * Bracketed tag appended to a source name in synthesis-prompt bucket lines,
 * e.g. " [recap]". Empty string for standalone sources; one-off VK notes and
 * TMTB notes get a human-readable tag.
 */
export function editionLabel(sourceName: string, subject: string): string {
  const { edition } = classifyEdition(sourceName, subject);
  if (edition === "standalone") return "";
  if (edition === "one_off" || edition === "note") return " [one-off note]";
  return ` [${edition}]`;
}
