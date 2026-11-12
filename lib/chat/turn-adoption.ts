import { parseDbTimestamp } from "@/lib/calendar/date-utils";
import { networkFailureMessage } from "@/lib/ui/mutation-result";
import { humanizeChatError } from "@/lib/chat/error-message";

/**
 * Pure decisions of the chat client's turn (Portfolio Assistant plan, Task 4).
 *
 * Client-safe: imports only plain, import-free helpers. `ChatInterface.tsx` calls these; the tests pin
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
 * - `stoppedNotice`, `toolIndicatorState`, `showThinking` (R4-3): a message
 *   that is no longer the streaming one renders settled (no pulsing).
 * - `shouldIgnoreStopClick` (R4-4): the second click of a double-click on
 *   Send lands on Stop, which takes Send's place; it is ignored.
 * - `shouldAutoContinue` (R4-10): caps the SDK's automatic resends per turn.
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
  /** Answered Save in an older message whose continuation never came back. */
  | { kind: "unconfirmed" }
  | { kind: "not-saved"; reason?: string };

/**
 * R4-2: the SDK updates only the LAST message, and the server treats an
 * unanswered draft in an earlier message as declined, so a card there gets
 * no buttons.
 */
export const SUPERSEDED_NOTE_REASON = "superseded by a later message";

export const CREATE_NOTE_PART_TYPE = "tool-create_note";

function stringField(obj: unknown, key: string): string | null {
  if (obj === null || typeof obj !== "object") return null;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The card for a `create_note` tool part, or null when the part is not one. */
export function noteApprovalView(
  part: NoteToolPartView,
  opts: { inLastMessage?: boolean } = {},
): NoteApprovalView | null {
  if (part.type !== CREATE_NOTE_PART_TYPE) return null;
  const inLastMessage = opts.inLastMessage ?? true;
  switch (part.state) {
    case "approval-requested": {
      if (!part.approval || typeof part.approval.id !== "string") return null;
      if (!inLastMessage) return { kind: "not-saved", reason: SUPERSEDED_NOTE_REASON };
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
      if (part.approval?.approved !== true) return { kind: "not-saved" };
      return inLastMessage ? { kind: "saving" } : { kind: "unconfirmed" };
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

// ─── Settled rendering of a stopped reply (R4-3) ─────────────────

export const STOPPED_SENTENCE = "Stopped.";

/** Whether a reasoning part shows the pulsing Thinking line. */
export function showThinking(state: string | undefined, live: boolean): boolean {
  return live && state === "streaming";
}

/**
 * The indicator for a (non-note) tool part: "active" pulses its label,
 * "error" shows a static error, null shows nothing. Once its message is not
 * the live one, a call that never finished is settled and shows nothing.
 */
export function toolIndicatorState(
  state: string | undefined,
  live: boolean,
): "active" | "error" | null {
  if (state === "output-error") return "error";
  if (state === "output-available" || state === "output-denied") return null;
  return live ? "active" : null;
}

interface StoppedPart {
  type: string;
  text?: string;
  state?: string;
}

/**
 * "Stopped." for a settled assistant message that has nothing to show and
 * never received a finish reason (the stream was cut, by Stop or a switch).
 * A text with content, a tool error, or a note card counts as something to
 * show. Call it only for a message that is not live, and after the
 * turn-outcome sentence (which covers a finished turn).
 */
export function stoppedNotice(
  message: { parts: readonly StoppedPart[]; metadata?: unknown },
  opts: { endedInError?: boolean } = {},
): string | null {
  // An errored turn is not a stopped one: it shows the error and Retry only.
  if (opts.endedInError) return null;
  const metadata = message.metadata;
  if (
    metadata !== null &&
    typeof metadata === "object" &&
    typeof (metadata as { finishReason?: unknown }).finishReason === "string"
  ) {
    return null;
  }
  return hasVisibleContent(message.parts) ? null : STOPPED_SENTENCE;
}

/** A text with content, a tool error, or a note card is something to show. */
function hasVisibleContent(parts: readonly StoppedPart[]): boolean {
  return parts.some(
    (part) =>
      (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") ||
      part.type === CREATE_NOTE_PART_TYPE ||
      (part.type.startsWith("tool-") && part.state === "output-error"),
  );
}

// ─── Stop guard (R4-4) ───────────────────────────────────────────

export const STOP_CLICK_GUARD_MS = 400;

/** True when a Stop click comes within the guard window after a send began. */
export function shouldIgnoreStopClick(sendStartedAt: number | null, now: number): boolean {
  if (sendStartedAt === null) return false;
  return now - sendStartedAt < STOP_CLICK_GUARD_MS;
}

// ─── Automatic continuation cap (R4-10) ──────────────────────────

export const MAX_AUTO_CONTINUATIONS = 3;

/**
 * Wraps the SDK's own completeness check: resend only when it says the last
 * step's approvals are all answered AND this user turn has not already been
 * continued MAX_AUTO_CONTINUATIONS times (a continuation that never carries
 * the tool's result would otherwise resend forever).
 */
export function shouldAutoContinue(sdkSaysComplete: boolean, continuationsThisTurn: number): boolean {
  return sdkSaysComplete && continuationsThisTurn < MAX_AUTO_CONTINUATIONS;
}

export type SettledAssistantView =
  | { kind: "notice"; text: string }
  /** The parts; `trailingNotice` is a quieter line under the text (RF-7). */
  | { kind: "parts"; trailingNotice?: string }
  | { kind: "hidden" };

function writtenText(parts: readonly StoppedPart[]): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n\n")
    .trim();
}

/**
 * How a settled (not live) assistant message renders. `outcomeNotice` is
 * `turnOutcomeNotice(message)` (Contract B), passed in so this file stays
 * import-free. It may be non-null even when text exists (a turn that wrote
 * a line, then hit the step cap): the text shows, then the notice under it.
 * The notice is never shown on an errored turn or while an approval is
 * pending, and never twice (a reloaded row already ends with it). A turn
 * that ended in an error with nothing to show renders no bubble at all: the
 * error line and Retry below it say what happened.
 */
export function settledAssistantView(
  message: { parts: readonly StoppedPart[]; metadata?: unknown },
  opts: { endedInError: boolean; outcomeNotice: string | null },
): SettledAssistantView {
  const pendingApproval = message.parts.some(
    (p) => p.type.startsWith("tool-") && p.state === "approval-requested",
  );
  const notice = opts.endedInError || pendingApproval ? null : opts.outcomeNotice;
  const text = writtenText(message.parts);
  if (notice && text === "") return { kind: "notice", text: notice };
  const empty = !hasVisibleContent(message.parts);
  if (empty && opts.endedInError) return { kind: "hidden" };
  if (empty && !hasFinishReason(message.metadata)) return { kind: "notice", text: STOPPED_SENTENCE };
  if (notice && !text.endsWith(notice)) return { kind: "parts", trailingNotice: notice };
  return { kind: "parts" };
}

function hasFinishReason(metadata: unknown): boolean {
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    typeof (metadata as { finishReason?: unknown }).finishReason === "string"
  );
}

// ─── Conversation list date (browser pass, item 1) ───────────────

/**
 * The Eastern calendar day of a stored conversation timestamp, as M/D/YYYY.
 * SQLite stores `datetime('now')` in UTC with a space; `new Date()` would
 * read that as local time, so an evening row showed tomorrow's date.
 */
export function conversationDayLabel(raw: string): string {
  const d = parseDbTimestamp(raw);
  if (!d) return "";
  return d.toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

// ─── Failed send text (browser pass, item 2) ─────────────────────

const CHAT_FAILED = "The chat request failed. Try again.";
const NETWORK_TEXT = /^(failed to fetch|load failed|networkerror\b|network request failed)/i;
const BARE_STATUS_TEXT = /^(internal server error|bad gateway|service unavailable|gateway timeout)\.?$/i;

/**
 * The sentence shown for a failed chat send. A fetch that never reached the
 * server throws a TypeError whose text is the browser's own ("Failed to
 * fetch"), which `humanizeChatError` passes through as a plain message; it
 * reads as `networkFailureMessage` instead. An HTML or bare status body reads
 * as a plain failure; an envelope keeps the server's own sentence.
 */
export function chatErrorText(error: { name?: string; message?: string } | null | undefined): string {
  const message = (error?.message ?? "").trim();
  if ((error?.name === "TypeError" && NETWORK_TEXT.test(message)) || NETWORK_TEXT.test(message)) {
    return networkFailureMessage("send the message");
  }
  if (message === "" || message.startsWith("<") || BARE_STATUS_TEXT.test(message)) return CHAT_FAILED;
  return humanizeChatError(message);
}
