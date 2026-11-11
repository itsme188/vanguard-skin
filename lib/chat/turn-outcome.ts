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

/**
 * The sentence to show for a finished assistant message with no written
 * reply, or null. Null while any text part has content or any tool part is
 * waiting for the owner's approval.
 */
export function turnOutcomeNotice(message: TurnOutcomeMessage): string | null {
  for (const part of message.parts) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
      return null;
    }
    if (isToolPart(part) && part.state === "approval-requested") {
      return null;
    }
  }
  const metadata = message.metadata;
  const finishReason =
    metadata !== null && typeof metadata === "object"
      ? (metadata as { finishReason?: unknown }).finishReason
      : undefined;
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

/** Structural view of a finished step that `assistantRowText` reads. */
export interface TurnOutcomeStep {
  text: string;
  content: readonly { type: string }[];
}

/**
 * The text to save as the assistant row for a finished turn (B11), or null
 * to save nothing. `onFinish.text` is the LAST step's text only, so the row
 * is built from every step: the non-empty step texts joined with a blank
 * line. A turn with no written text saves the sentence for its finish reason,
 * or nothing while an approval is pending (the continuation saves its own
 * row) or for a plain stop.
 */
export function assistantRowText(
  steps: readonly TurnOutcomeStep[],
  finishReason: string | undefined,
): string | null {
  const joined = joinStepTexts(steps.map((s) => s.text));
  if (joined) return joined;

  const last = steps[steps.length - 1];
  if (last?.content.some((p) => p.type === "tool-approval-request")) return null;

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
