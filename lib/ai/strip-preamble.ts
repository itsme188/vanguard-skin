/**
 * Removes leading AI model preamble text before the first markdown structure marker.
 *
 * Defense against Claude (and other models) leaking narration like "Good, now I have
 * enough to synthesize..." before structured markdown output. Walks lines until finding
 * a line that starts with a markdown marker (header, table, list, blockquote, etc.),
 * then returns everything from that point onwards.
 *
 * If no marker is found, returns the input unchanged (caller should validate
 * downstream — e.g., synthesize.ts checks the first non-empty line for `#`).
 */
// A line that is ENTIRELY a bold label ("**Guidance**" or "**Guidance**:",
// nothing else on the line) is also a structure marker — e.g. the desk-note
// summaries lib/transcripts/same-day.ts::summarizeTranscript stores, whose
// prompt asks for bare bold section labels with no leading `- `/`#`. This
// alternative is anchored with `$` (unlike the others below, which only
// check the line's start) so an inline bold phrase inside a real sentence of
// narration ("**Note:** I've reviewed everything and...") still correctly
// counts as preamble, not a marker. 2026-07-23: without this, a leading
// "**Guidance**" line was itself misidentified as preamble and stripped,
// decapitating an otherwise well-formed desk note (found via same-day.ts's
// store-time desk-note validator tests).
const BOLD_LABEL_LINE_RE = /^\*\*[^*]+\*\*:?\s*$/;

export function stripModelPreamble(text: string): string {
  const lines = text.split("\n");
  let firstReal = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    // Markdown structure markers: header, table, list, blockquote, hr,
    // code fence. Anything else at the start is preamble.
    if (/^(#|\||[-*+]\s|>\s|---|```)/.test(trimmed) || BOLD_LABEL_LINE_RE.test(trimmed)) {
      firstReal = i;
      break;
    }
  }
  return lines.slice(firstReal).join("\n").trim();
}
