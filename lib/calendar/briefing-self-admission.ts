/**
 * Self-admission detection — A5 of the briefing-quality verification suite.
 *
 * Opus occasionally drafts briefings that admit data uncertainty in the
 * output ("data looks corrupted", "I can't verify", "without access to
 * current prices"). The data is correct and complete; these phrases are a
 * model-side hedge that produces misleading copy. This module is the
 * single source of truth for both:
 *
 *   - the post-gen scanner in `scripts/verify-briefing-content.ts` (manual,
 *     post-fact triage), AND
 *   - the inline auto-regen guard in `lib/calendar/briefing.ts`
 *     (pre-send: detect on first draft → regenerate once with a forcing
 *     addendum that names the matched phrases).
 *
 * The regex is intentionally narrow — we want zero false positives on
 * legitimate uses of "data" or "verify" elsewhere in financial prose
 * (e.g., "verify the print against consensus" is fine; "I cannot verify
 * the data" is not).
 */

/**
 * Self-admission pattern catalog. Returns a FRESH RegExp on every call
 * because `RegExp` with the `g` flag is stateful (`.lastIndex` advances
 * across calls); a module-level singleton would silently skip later
 * matches when shared across multiple briefings.
 */
export function buildSelfAdmissionRegex(): RegExp {
  return /(data\s+(looks\s+corrupted|appears\s+wrong|seems\s+off|isn['']?t\s+available|seems\s+(?:incomplete|missing))|brief\s+looks|i\s+(?:cannot|can'?t|don'?t|do\s+not)\s+have\s+(?:current|live|the\s+actual|access\s+to)|unable\s+to\s+(?:access|verify|confirm)|without\s+access\s+to|i\s+don'?t\s+have\s+access|cannot\s+verify)/gi;
}

/**
 * Scan a briefing draft for self-admission phrases. Returns the matched
 * substrings (deduplicated, case-normalized to the form the model wrote
 * them). Empty array means the draft is clean.
 *
 * Callers in the regen path use the returned phrases to build a forcing
 * addendum so the model knows which specific patterns to avoid on retry.
 */
export function findSelfAdmissions(text: string): string[] {
  if (!text) return [];
  const re = buildSelfAdmissionRegex();
  const matches = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.add(m[0]);
    // Defensive: advance lastIndex if the match was zero-width to avoid
    // infinite loops. The patterns above never produce zero-width matches,
    // but a future contributor might add one.
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return Array.from(matches);
}

/**
 * Build the addendum text added to the system prompt on retry. The list
 * of matched phrases is quoted so the model sees exactly what to avoid;
 * a generic "don't admit data issues" addendum is less effective than
 * pointing at the specific output to undo.
 */
export function buildSelfAdmissionAddendum(matches: string[]): string {
  if (matches.length === 0) return "";
  const quoted = matches.map((m) => `"${m}"`).join(", ");
  return `\n\nIMPORTANT — RETRY DUE TO SELF-ADMISSION. Your previous attempt contained phrases like ${quoted}. The data passed to you in this prompt is correct and complete. Do NOT admit data issues. Do NOT say you cannot access, verify, or confirm anything. Do NOT speculate about unavailable information. If a section has no data, skip it silently — do not narrate the absence. Reference data only when you have it.`;
}
