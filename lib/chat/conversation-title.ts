/**
 * Conversation titles (chat rail "Recent conversations").
 *
 * A title is the user's own first message, cut at a word boundary. The
 * assistant's opening sentence made every title look alike. A title is shown
 * as stored, privacy toggle on or off: inside the chat the owner is the only
 * reader (owner ruling 2026-11-12, superseding the 2026-11-07 figure mask).
 */

export const TITLE_MAX_CHARS = 60;
const ELLIPSIS = "…";

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
