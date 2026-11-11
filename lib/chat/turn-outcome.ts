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
