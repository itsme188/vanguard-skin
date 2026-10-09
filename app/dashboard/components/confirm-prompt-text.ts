/**
 * A prompt's text as paragraphs: split on blank lines, trimmed. Always at
 * least one entry, so the dialog always has a message line.
 */
export function splitPromptParagraphs(message: string): string[] {
  const parts = message
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length > 0 ? parts : [""];
}
