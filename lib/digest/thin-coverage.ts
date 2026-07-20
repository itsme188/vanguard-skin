/**
 * thin-coverage.ts — deterministic handling for held names whose digest
 * coverage is too thin for a real `##` section (spec:
 * docs/superpowers/specs/2026-07-20-digest-thin-coverage-design.md).
 *
 * Two kinds of thin coverage, two compact lines:
 *   - Calendar-listing-only buckets (every article is a >=8-symbol roundup)
 *     are partitioned OUT of synthesis input before the model runs — the
 *     model can't write a section for them, and enforceHeldSections (which
 *     iterates the input buckets) naturally stops stubbing them. They render
 *     as one "On this week's calendar: …" roster line instead.
 *   - Essays that insertCrossFilePointers could not file (no matching
 *     `## SYM` section) render as one "📄 Deep dives: …" pointer line.
 *
 * Worker mirror: workers/cron/src/fallback-evening.ts carries a local
 * adaptation of the partition + roster (different bucket shape, no essay
 * split there). LISTING_BREADTH_MIN is parity-pinned by
 * workers/cron/test/editions.test.ts.
 */
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { parseSymbolList, type CompanyBucket } from "@/lib/digest/group-by-company";

export const LISTING_BREADTH_MIN = 8;

const NO_SYMBOL_BUCKET = "(no symbol)";

/**
 * An article mentioning >= LISTING_BREADTH_MIN symbols is a roundup/listing
 * for EVERY symbol it mentions. Null/unparseable mentioned_symbols parse to
 * [] — never a listing, so a parse failure can't silently waive a section.
 */
export function isListingArticle(a: { mentioned_symbols: string | null }): boolean {
  return parseSymbolList(a.mentioned_symbols).length >= LISTING_BREADTH_MIN;
}

/**
 * Split held listing-only buckets out of the synthesis input. A bucket moves
 * to the roster iff it is held (issuerSiblings-aware), non-macro, non-empty,
 * and EVERY article in it is a listing article.
 */
export function partitionListingOnlyHeldBuckets(
  buckets: CompanyBucket[],
  heldSymbols: string[],
): { active: CompanyBucket[]; rosterSymbols: string[] } {
  const heldSet = new Set(heldSymbols.map((s) => s.toUpperCase()));
  const active: CompanyBucket[] = [];
  const rosterSymbols: string[] = [];
  for (const bucket of buckets) {
    const isHeld =
      bucket.symbol !== NO_SYMBOL_BUCKET &&
      issuerSiblings(bucket.symbol).some((s) => heldSet.has(s.toUpperCase()));
    const allListing = bucket.articles.length > 0 && bucket.articles.every(isListingArticle);
    if (isHeld && allListing) rosterSymbols.push(bucket.symbol);
    else active.push(bucket);
  }
  rosterSymbols.sort();
  return { active, rosterSymbols };
}

/**
 * Render the two compact lines (deep-dives first, then the calendar roster).
 * Either line is omitted when its input is empty; both empty -> "".
 */
export function renderThinCoverageLines(
  rosterSymbols: string[],
  unfiledEssays: Array<{ symbols: string[]; source_name: string; subject: string }>,
): string {
  const lines: string[] = [];
  if (unfiledEssays.length > 0) {
    const entries = unfiledEssays.map(
      (e) => `${[...e.symbols].sort().join("/")} (${e.source_name} — "${e.subject}")`,
    );
    lines.push(`📄 Deep dives: ${entries.join("; ")} — see Research Desk below`);
  }
  if (rosterSymbols.length > 0) {
    lines.push(`On this week's calendar: ${[...rosterSymbols].sort().join(" · ")}`);
  }
  return lines.join("\n\n");
}

/**
 * Insert `block` immediately before the `## Also covered` closing section,
 * or append at the end when that section is absent. Single source for the
 * placement behavior shared by enforceHeldSections and the thin-coverage
 * lines.
 */
export function insertBeforeAlsoCovered(markdown: string, block: string): string {
  const alsoMatch = markdown.match(/^## Also covered\s*$/m);
  if (alsoMatch && alsoMatch.index !== undefined) {
    return markdown.slice(0, alsoMatch.index) + block + "\n\n" + markdown.slice(alsoMatch.index);
  }
  return `${markdown.trimEnd()}\n\n${block}`;
}
