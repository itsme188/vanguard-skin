/**
 * Deterministic subject-line linking backstop for newsletter article
 * processing.
 *
 * The extraction model (Claude, via extractWithClaude in lib/gmail/process.ts,
 * and its Worker mirror in workers/cron/src/newsletter-fetch.ts) occasionally
 * drops a short ticker from `mentioned_symbols` even though it's plainly in
 * the subject line. Live miss (2026-08): FundaAI article id 67770, subject
 * "Review|APP & U 2Q26: D28 IAA Is Now the Core Battleground", extracted only
 * ["APP"] — the model dropped the single-letter ticker "U" (Unity, a held
 * position, securities.id 1717), so the article never linked onto U's
 * security-detail page.
 *
 * This is a deterministic, non-AI safety net layered on top of (not instead
 * of) the existing two-layer verifyMentions gate: split the SUBJECT — never
 * the body, which would false-positive wildly on ordinary prose — into
 * tokens and keep any token that matches a held-or-watchlist symbol by exact
 * (case-sensitive) string equality. Callers union the result directly into
 * both the stored `mentioned_symbols` and the securities-linking step,
 * bypassing the AI verification layers entirely: Haiku would happily drop a
 * bare "U" as too ambiguous, which is exactly the failure mode this backstop
 * exists to catch.
 *
 * Bounded false-positive risk, by design: a bare "A" in ordinary prose would
 * match only if the user holds/watches ticker "A" — accepted, per spec, as
 * the cost of catching the "U" class of miss. Lowercase words ("up", "at")
 * never match even when the user holds "UP"/"AT", because `knownSymbols` is
 * uppercase and matching is case-sensitive — a subject token only counts if
 * it's written in caps as-is.
 */

/**
 * Tokens are split on whitespace, &, |, :, /, commas, and parens — the
 * separators that show up in real newsletter subject lines ("Review|APP & U
 * 2Q26: D28 IAA Is Now the Core Battleground").
 */
const SUBJECT_TOKEN_SPLIT = /[\s&|:,/()]+/;

/**
 * Returns the subset of `knownSymbols` that appear in `subject` as an exact,
 * case-sensitive whole token. Order follows first occurrence in the subject;
 * duplicates are collapsed.
 */
export function subjectSymbolBackstop(subject: string, knownSymbols: Set<string>): string[] {
  if (!subject || knownSymbols.size === 0) return [];

  const tokens = subject.split(SUBJECT_TOKEN_SPLIT).filter(Boolean);

  const seen = new Set<string>();
  const hits: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    if (knownSymbols.has(token)) {
      seen.add(token);
      hits.push(token);
    }
  }
  return hits;
}
