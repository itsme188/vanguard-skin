/**
 * Conversation titles (chat rail "Recent conversations").
 *
 * A title is the user's own first message, cut at a word boundary. The
 * assistant's opening sentence made every title look alike. In privacy mode
 * only portfolio-figure tokens inside a title are masked (maskTitleFigures),
 * so titles stay distinguishable.
 */

export const TITLE_MAX_CHARS = 60;
const ELLIPSIS = "…";
const MASK = "•••";

/** First non-empty line, markdown noise removed, cut at a word boundary. */
export function titleFromUserText(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/[#*_`]/g, "").replace(/\s+/g, " ").trim())
      .find((l) => l.length > 0) ?? "";
  if (firstLine.length <= TITLE_MAX_CHARS) return firstLine;

  const window = firstLine.slice(0, TITLE_MAX_CHARS + 1);
  const lastSpace = window.lastIndexOf(" ");
  // A single very long word (no space to cut at): hard cut.
  const cut = lastSpace > 0 ? window.slice(0, lastSpace) : firstLine.slice(0, TITLE_MAX_CHARS);
  return cut.trimEnd() + ELLIPSIS;
}

interface TitleMessage {
  role?: string;
  parts?: Array<{ type?: string; text?: string }>;
}

/** Title from the first user message of an AI SDK UIMessage list. */
export function conversationTitleFromMessages(messages: ReadonlyArray<TitleMessage>): string {
  const first = messages.find((m) => m.role === "user");
  const text =
    first?.parts
      ?.filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("") ?? "";
  return titleFromUserText(text);
}

const FIGURE_PATTERNS: RegExp[] = [
  // currency: $1,234.56  $2k  $3.5M  (also trailing "USD" amounts like 3.5M USD)
  /\$\s?\d[\d,]*(?:\.\d+)?(?:[kKmMbB]\b)?/g,
  /\b\d[\d,]*(?:\.\d+)?[kKmMbB]?\s?USD\b/g,
  // percentages
  /[+-]?\d[\d,]*(?:\.\d+)?%/g,
  // share counts: "150 shares", "1,200 sh"
  /\b\d[\d,]*(?:\.\d+)?\s?(?:shares?|sh)\b/gi,
];

/** Mask currency amounts, percentages and share counts; keep everything else. */
export function maskTitleFigures(title: string): string {
  return FIGURE_PATTERNS.reduce((acc, re) => acc.replace(re, MASK), title);
}
