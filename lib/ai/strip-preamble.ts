/**
 * Removes leading AI model preamble text before the first markdown structure marker.
 *
 * Defense against Claude (and other models) leaking narration like "Good, now I have
 * enough to synthesize..." before structured markdown output. Walks lines until finding
 * a line that starts with a markdown marker (header, table, list, blockquote, etc.),
 * then returns everything from that point onwards.
 *
 * If no marker is found, returns empty string.
 */
export function stripModelPreamble(text: string): string {
  const lines = text.split("\n");
  let firstReal = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    // Markdown structure markers: header, table, list, blockquote, hr,
    // code fence. Anything else at the start is preamble.
    if (/^(#|\||[-*+]\s|>\s|---|```)/.test(trimmed)) {
      firstReal = i;
      break;
    }
  }
  return lines.slice(firstReal).join("\n").trim();
}
