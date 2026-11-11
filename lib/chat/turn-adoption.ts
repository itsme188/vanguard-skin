/**
 * Pure decisions of the chat client's turn (Portfolio Assistant plan, Task 4).
 *
 * Client-safe: no imports. `ChatInterface.tsx` calls these; the tests pin
 * them without a DOM harness.
 *
 * - `decideTurnAdoption` (B17): which conversation id the client adopts when
 *   a turn ends. The id comes only from the server's `X-Conversation-Id`
 *   header on THAT turn's response, and only while the turn's generation is
 *   still current: New Conversation, loading a conversation and deleting the
 *   open one bump the generation, so a late header never pulls the owner back
 *   into the thread they just left.
 * - `noteApprovalView` (B19, Contract C): what the `create_note` card shows
 *   for each SDK tool-part state. "Saved" only when the tool's output says
 *   `data.saved === true`.
 * - `isNearBottom` (B21): auto-scroll follows the stream only when the reader
 *   is already within 80 px of the bottom.
 */

export interface TurnAdoptionInput {
  /** The conversation the client has open now (state). */
  openConversationId: number | null;
  /** The id the server named on this turn's response, or null. */
  turnConversationId: number | null;
  /** The generation recorded when this turn's request was sent, or null. */
  turnGeneration: number | null;
  /** The client's generation now. */
  currentGeneration: number;
}

/** The id to adopt, or null to leave the open conversation as it is. */
export function decideTurnAdoption(input: TurnAdoptionInput): number | null {
  const { openConversationId, turnConversationId, turnGeneration, currentGeneration } = input;
  if (turnConversationId === null) return null;
  if (turnGeneration === null || turnGeneration !== currentGeneration) return null;
  if (turnConversationId === openConversationId) return null;
  return turnConversationId;
}

/** The parts of a UI tool part this card reads. */
export interface NoteToolPartView {
  type: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
}

export type NoteApprovalView =
  | {
      kind: "ask";
      approvalId: string;
      noteType: string | null;
      content: string;
      symbol: string | null;
      eventDate: string | null;
    }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "not-saved"; reason?: string };

export const CREATE_NOTE_PART_TYPE = "tool-create_note";

function stringField(obj: unknown, key: string): string | null {
  if (obj === null || typeof obj !== "object") return null;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The card for a `create_note` tool part, or null when the part is not one. */
export function noteApprovalView(part: NoteToolPartView): NoteApprovalView | null {
  if (part.type !== CREATE_NOTE_PART_TYPE) return null;
  switch (part.state) {
    case "approval-requested": {
      if (!part.approval || typeof part.approval.id !== "string") return null;
      return {
        kind: "ask",
        approvalId: part.approval.id,
        noteType: stringField(part.input, "note_type"),
        content: stringField(part.input, "content") ?? "",
        symbol: stringField(part.input, "symbol"),
        eventDate: stringField(part.input, "event_date"),
      };
    }
    case "approval-responded":
      return part.approval?.approved === true ? { kind: "saving" } : { kind: "not-saved" };
    case "output-denied":
      return { kind: "not-saved" };
    case "output-error":
      return part.errorText ? { kind: "not-saved", reason: part.errorText } : { kind: "not-saved" };
    case "output-available": {
      const output = part.output;
      const error = stringField(output, "error");
      if (error) return { kind: "not-saved", reason: error };
      const data =
        output !== null && typeof output === "object"
          ? (output as { data?: unknown }).data
          : undefined;
      const saved =
        data !== null && typeof data === "object" && (data as { saved?: unknown }).saved === true;
      return saved ? { kind: "saved" } : { kind: "not-saved" };
    }
    default:
      return null;
  }
}

export const AUTO_SCROLL_THRESHOLD_PX = 80;

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** True when the reader is within `threshold` px of the bottom of the list. */
export function isNearBottom(m: ScrollMetrics, threshold = AUTO_SCROLL_THRESHOLD_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}

/**
 * Whether auto-scroll keeps following after a scroll event. Near the bottom
 * it always follows; it stops only when the reader moved UP. A smooth
 * programmatic scroll toward the bottom fires events far from the bottom
 * mid-animation, but it moves down, so it never switches following off.
 */
export function nextFollowBottom(
  following: boolean,
  m: ScrollMetrics,
  previousScrollTop: number,
): boolean {
  if (isNearBottom(m)) return true;
  if (m.scrollTop < previousScrollTop) return false;
  return following;
}
