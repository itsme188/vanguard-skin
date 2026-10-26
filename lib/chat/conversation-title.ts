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

// Privacy-first: mask every standalone number. A digit run is left alone only
// when glued to letters inside one token (450C, Q3, FY26, 10-K) or when it
// is an ISO date. Over-masking is acceptable; leaking a figure is not.
const FIGURE_RE = new RegExp(
  [
    "(\\d{4}-\\d{2}-\\d{2})|", // 1: ISO date, kept
    "(?<![A-Za-z0-9])[+-]?(?:[$\u20ac\u00a3\u00a5]\\s?)?", // sign, currency sign
    "(\\d(?:[\\d,]*\\d)?)(\\.\\d+)?", // 2: integer part, 3: decimals
    "(?:\\s?(?:thousand|million|billion|bn|mm|k|b|m|percent|shares?|sh|contracts?)|%)?",
    "(?:\\s?(?:USD|EUR))?",
    "(?![A-Za-z0-9])(?!-[A-Za-z])",
  ].join(""),
  "gi",
);

/** Mask currency amounts, percentages, share counts and bare numbers; keep ticker-like tokens. */
export function maskTitleFigures(title: string): string {
  return title.replace(FIGURE_RE, (match, isoDate: string | undefined, _int: string) => {
    if (isoDate) return match;
    return MASK;
  });
}

/** Title as shown on screen: figures masked only while privacy mode is on. */
export function displayConversationTitle(title: string | null | undefined, isPrivate: boolean): string | null {
  if (title == null) return null;
  return isPrivate ? maskTitleFigures(title) : title;
}
