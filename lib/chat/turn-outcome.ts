/**
 * The empty or cut-off turn signal (Portfolio Assistant plan, Contract B).
 *
 * Client-safe: no imports. The server saves one of these sentences when a
 * turn ends with no written reply; the client shows the same sentence in
 * place of an empty assistant bubble.
 */

export const CUT_OFF_SENTENCE =
  "The answer stopped after the step limit before a written reply. Ask again, or narrow the question.";

export const OUTPUT_LIMIT_SENTENCE =
  "The answer reached the output limit before a written reply.";

export const CONTENT_FILTER_SENTENCE =
  "The model declined to answer this request.";

/** Minimal structural view of a UI message part this check reads. */
export interface TurnOutcomePart {
  type: string;
  text?: string;
  state?: string;
}

export interface TurnOutcomeMessage {
  parts: readonly TurnOutcomePart[];
  metadata?: unknown;
}

function isToolPart(part: TurnOutcomePart): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

function finishSentence(finishReason: unknown): string | null {
  switch (finishReason) {
    case "tool-calls":
      return CUT_OFF_SENTENCE;
    case "length":
      return OUTPUT_LIMIT_SENTENCE;
    case "content-filter":
      return CONTENT_FILTER_SENTENCE;
    default:
      return null;
  }
}

/**
 * The sentence to show BELOW a finished assistant message that stopped early
 * (step limit, output limit, refusal), or null (review RF-7). It is returned
 * whether or not the message has text: interim narration before a tool call
 * ("Let me check your lots.") is the usual shape of a cut-off turn, and must
 * not hide the notice. Null while any tool part is waiting for the owner's
 * approval, and null for a normal finish.
 *
 * The reason comes from `metadata.finishReason`, which only a live stream
 * carries. A message reloaded from history is text-only and has no metadata,
 * so it returns null: its saved text already ends with the sentence (see
 * `assistantRowText`), and the notice is never shown twice.
 */
export function turnOutcomeNotice(message: TurnOutcomeMessage): string | null {
  for (const part of message.parts) {
    if (isToolPart(part) && part.state === "approval-requested") {
      return null;
    }
  }
  const metadata = message.metadata;
  const finishReason =
    metadata !== null && typeof metadata === "object"
      ? (metadata as { finishReason?: unknown }).finishReason
      : undefined;
  return finishSentence(finishReason);
}

/** Structural view of a finished step that `assistantRowText` reads. */
export interface TurnOutcomeStep {
  text: string;
  content: readonly { type: string }[];
}

/**
 * The text to save as the assistant row for a finished turn (B11), or null
 * to save nothing. `onFinish.text` is the LAST step's text only, so the row
 * is built from every step: the non-empty step texts joined with a blank
 * line. A turn that stopped early (step limit, output limit, refusal) ends
 * with the sentence for its finish reason after a blank line, or is that
 * sentence alone when no text was written (RF-7). While an approval is
 * pending the row is the text only, or nothing (the continuation saves its
 * own row); a plain stop saves the text only. Errored and aborted turns do
 * not come here (they save `joinStepTexts` alone).
 */
export function assistantRowText(
  steps: readonly TurnOutcomeStep[],
  finishReason: string | undefined,
): string | null {
  const joined = joinStepTexts(steps.map((s) => s.text));

  const last = steps[steps.length - 1];
  if (last?.content.some((p) => p.type === "tool-approval-request")) return joined || null;

  const sentence = finishSentence(finishReason);
  if (!sentence) return joined || null;
  return joined ? `${joined}\n\n${sentence}` : sentence;
}

/**
 * The non-empty step texts joined with a blank line ("" when there are none).
 * An errored or aborted turn saves exactly this, never a finish-reason
 * sentence (review R3-2, R3-4).
 */
export function joinStepTexts(texts: readonly (string | undefined | null)[]): string {
  return texts
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter((t) => t !== "")
    .join("\n\n");
}
