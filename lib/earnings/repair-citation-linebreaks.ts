/**
 * Repairs citation-fragmented earnings preview/recap prose — DISPLAY-TIME
 * ONLY, scoped to `earnings_emails.ai_output_md`.
 *
 * When Claude's server-side web_search tool cites a source, Anthropic
 * splits the response's prose across multiple adjacent TextBlocks around
 * the cited span. `lib/digest/send-earnings-email.ts::callClaude` now joins
 * those blocks with "" (joinClaudeTextBlocks) instead of "\n", so FUTURE
 * sends never produce a bare mid-sentence newline in the first place. This
 * function exists only to repair ALREADY-STORED `ai_output_md` rows written
 * before that fix, at the point they're read for display or print — never
 * at send/compose time (composing already goes through the fixed join).
 *
 * Deliberately NOT part of the shared `briefingToHtml` renderer
 * (lib/calendar/briefing-html.ts): that renderer is used by all four email
 * composers (briefing, digest, earnings preview/recap), and several of
 * them deliberately rely on the "every non-blank line is its own paragraph"
 * behavior for correct visual structure — a `**Label**\nbody` bold-label
 * line (lib/digest/call-transcripts.ts, lib/earnings/debrief.ts) or a
 * trailing `**Holdings exposed:** SYM, SYM` cluster line
 * (lib/calendar/briefing.ts HARD RULE 3) must stay a DISTINCT line, not get
 * folded into the preceding prose. See
 * tests/calendar/briefing-html-continuation-lines.test.ts for the
 * regression pins on that renderer behavior. This function is applied only
 * where `ai_output_md` is read for the earnings viewer/worksheet, so it can
 * never reach those other composers' output.
 *
 * Pure markdown → markdown transform, no imports. Walks lines; a non-blank
 * line that (a) is not itself a structural marker (header / table row /
 * blockquote / hr / list marker / bold-label-only line) and (b) has no
 * blank line immediately before it, gets folded onto the END of the
 * previous OUTPUT line — but only when that previous line is itself
 * mergeable content (plain prose or a list item — never a header, table
 * row, blockquote, hr, or bold-label-only line). `continuationJoiner` skips
 * the space before a fragment that opens with sentence-hugging punctuation
 * (`, . ; : ! ? ) ] }`) so "...August 10, 2026" + ", with" reassembles as
 * "...2026, with", not "...2026 , with".
 */

const HEADER_RE = /^#{1,6}\s/;
const BLOCKQUOTE_RE = /^>\s/;
const HR_RE = /^-{3,}$/;
const TABLE_ROW_RE = /^\|.*\|\s*$/;
const LIST_MARKER_RE = /^([-*]\s+|\d+\.\s+)/;
// A line that is ENTIRELY a bold label ("**Guidance**" or "**Guidance**:")
// is also a structural marker, mirroring lib/ai/strip-preamble.ts's
// BOLD_LABEL_LINE_RE — defensive parity even though earnings prose doesn't
// currently produce this shape.
const BOLD_LABEL_LINE_RE = /^\*\*[^*]+\*\*:?\s*$/;

// A line matching any of these ALWAYS starts something new and must never
// be merged INTO the line above it (it can still be merged INTO, if it's a
// list item — see isMergeTarget).
function isNewBlockLine(trimmed: string): boolean {
  return (
    HEADER_RE.test(trimmed) ||
    BLOCKQUOTE_RE.test(trimmed) ||
    HR_RE.test(trimmed) ||
    TABLE_ROW_RE.test(trimmed) ||
    LIST_MARKER_RE.test(trimmed) ||
    BOLD_LABEL_LINE_RE.test(trimmed)
  );
}

// A line eligible to RECEIVE a continuation fragment appended to it: plain
// prose or a list item. Never a header, table row, blockquote, hr, or
// bold-label-only line.
function isMergeTarget(trimmed: string): boolean {
  if (trimmed === "") return false;
  if (
    HEADER_RE.test(trimmed) ||
    BLOCKQUOTE_RE.test(trimmed) ||
    HR_RE.test(trimmed) ||
    TABLE_ROW_RE.test(trimmed) ||
    BOLD_LABEL_LINE_RE.test(trimmed)
  ) {
    return false;
  }
  return true; // plain prose OR a list item
}

function continuationJoiner(text: string): string {
  return /^[,.;:!?)\]}]/.test(text) ? "" : " ";
}

export function repairCitationLineBreaks(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      out.push(line);
      continue;
    }

    const precededByBlank = i === 0 || lines[i - 1].trim() === "";

    if (!precededByBlank && !isNewBlockLine(trimmed) && out.length > 0) {
      const prevTrimmed = out[out.length - 1].trim();
      if (isMergeTarget(prevTrimmed)) {
        out[out.length - 1] = out[out.length - 1] + continuationJoiner(trimmed) + trimmed;
        continue;
      }
    }

    out.push(line);
  }

  return out.join("\n");
}
