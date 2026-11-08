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

// Privacy-first: mask every standalone number, with two exemptions.
//
// Owner ruling 2026-11-07 (decision #52, Option 2, amending 2026-10-26):
// dates and percentages may show in a chat title; dollar amounts and share
// counts stay hidden. So DATE shapes (full and partial) and PERCENT /
// BASIS-POINT tokens render as written, and everything else a digit run can
// be — currency, share counts, bare numbers, k/M/bn magnitudes — is masked.
// A digit run is also left alone when glued to letters inside one token
// (450C, Q3, FY26, 10-K). Over-masking is acceptable; leaking a figure is not.
// Deliberately NOT exempt: a bare 4-digit year, which is indistinguishable
// from a 4-digit amount.

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?" +
  "|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?![A-Za-z])";
const ORDINAL = "(?:st|nd|rd|th)?";
const YEAR_TAIL = "(?:,?\\s\\d{4})?";

// Shapes that render as written. Order matters only in that each must be
// anchored; the alternation as a whole is tried before the figure pattern.
const KEEP_SHAPES = [
  // Percent / basis points: 3.2%, -1.75%, +25bp, 40 bps, 12 percent, 8 pct
  "[+-]?\\d+(?:[.,]\\d+)?\\s?(?:%|percent|pct|bps?)(?![A-Za-z0-9])",
  // ISO date: 2026-11-05
  "\\d{4}-\\d{2}-\\d{2}",
  // Numeric date, year first or last: 2026/11/05, 11/05/2026, 11/5
  "\\d{4}/\\d{1,2}/\\d{1,2}",
  "\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?",
  // Month-name date, either order: Nov 5, November 5th, Nov 5 2026, 5 Nov 2026
  `${MONTH}\\.?\\s\\d{1,2}${ORDINAL}${YEAR_TAIL}`,
  `\\d{1,2}${ORDINAL}\\s${MONTH}\\.?${YEAR_TAIL}`,
].join("|");

const FIGURE_RE = new RegExp(
  [
    // Alternation precedence: this lookbehind binds to the keep branch only,
    // so a kept shape is never read mid-token nor straight after a currency
    // sign. The figure branch keeps its own lookbehind below.
    "(?<![A-Za-z0-9$€£¥])",
    `(${KEEP_SHAPES})|`, // 1: kept as written
    "(?<![A-Za-z0-9])[+-]?(?:[$€£¥]\\s?)?", // sign, currency sign
    "(\\d(?:[\\d,]*\\d)?)(\\.\\d+)?", // 2: integer part, 3: decimals
    "(?:\\s?(?:thousand|million|billion|bn|mm|k|b|m|percent|shares?|sh|contracts?)|%)?",
    "(?:\\s?(?:USD|EUR))?",
    "(?![A-Za-z0-9])(?!-[A-Za-z])",
  ].join(""),
  "gi",
);

/**
 * Mask currency amounts, share counts and bare numbers; render date shapes,
 * percent / basis-point tokens and ticker-like tokens as written.
 */
export function maskTitleFigures(title: string): string {
  return title.replace(FIGURE_RE, (match, keep: string | undefined) => (keep ? match : MASK));
}

/** Title as shown on screen: figures masked only while privacy mode is on. */
export function displayConversationTitle(title: string | null | undefined, isPrivate: boolean): string | null {
  if (title == null) return null;
  return isPrivate ? maskTitleFigures(title) : title;
}
