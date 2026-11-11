import type { ModelMessage, UIMessage } from "ai";

/**
 * The history check the chat route runs before every model call (Portfolio
 * Assistant plan, Task 3 item H).
 *
 * A request carrying a `tool_use` with no `tool_result` is rejected by the
 * API, so the history must never hold one. Two sources produce them:
 *  - an aborted turn leaves tool parts in `input-streaming` /
 *    `input-available` (no output);
 *  - an approval card the owner never answered stays `approval-requested`
 *    once a later message follows it.
 *
 * One state is valid with no result and must survive: a tool part in
 * `approval-responded` in the LAST assistant message. `convertToModelMessages`
 * turns it into a call, an approval request and an approval response, and
 * `streamText`'s `collectToolApprovals` then executes the approved call.
 *
 * Checked against ai@6.0.138 (`node_modules/ai/dist/index.mjs`,
 * `convertToModelMessages`): a part in `output-denied` with
 * `approval: { approved: false, reason }` is emitted as a
 * `tool-approval-response` plus a `tool-result` of type `error-text`
 * carrying the reason, so the stale card can be converted into a denial
 * that keeps the call paired.
 */

export const STALE_APPROVAL_REASON = "Not confirmed";

type UIPart = UIMessage["parts"][number];

interface ToolPartLike {
  type: string;
  state?: string;
  toolCallId?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
}

function isToolPart(part: UIPart): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

export function sanitizeUiHistory(messages: UIMessage[]): UIMessage[] {
  const lastIndex = messages.length - 1;
  let changedAny = false;
  const out = messages.map((message, index) => {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) return message;
    let changed = false;
    const parts: UIPart[] = [];
    for (const part of message.parts) {
      if (!isToolPart(part)) {
        parts.push(part);
        continue;
      }
      const tp = part as unknown as ToolPartLike;
      if (tp.state === "input-streaming" || tp.state === "input-available") {
        changed = true;
        continue;
      }
      if (tp.state === "approval-requested" && index !== lastIndex) {
        changed = true;
        if (tp.approval?.id) {
          parts.push({
            ...(part as object),
            state: "output-denied",
            approval: { id: tp.approval.id, approved: false, reason: STALE_APPROVAL_REASON },
          } as unknown as UIPart);
        }
        // No approval id: nothing can pair the call, so it is dropped.
        continue;
      }
      parts.push(part);
    }
    if (!changed) return message;
    changedAny = true;
    return { ...message, parts };
  });
  return changedAny ? out : messages;
}

type ContentPart = { type: string; toolCallId?: string };

function contentParts(message: ModelMessage): ContentPart[] {
  return Array.isArray(message.content) ? (message.content as ContentPart[]) : [];
}

/**
 * Every `tool-call` id in an assistant message that has no `tool-result` in
 * the tool message right after it (or in the same message, for a provider-run
 * tool). Exempt: a call in the LAST assistant message that carries an
 * approval request (pending, or answered by the tool message that follows).
 */
export function findOrphanToolCalls(messages: ModelMessage[]): string[] {
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistant = i;
  });

  const orphans: string[] = [];
  messages.forEach((message, i) => {
    if (message.role !== "assistant") return;
    const parts = contentParts(message);
    const resultIds = new Set<string>();
    for (const p of parts) if (p.type === "tool-result" && p.toolCallId) resultIds.add(p.toolCallId);
    const next = messages[i + 1];
    if (next?.role === "tool") {
      for (const p of contentParts(next)) if (p.type === "tool-result" && p.toolCallId) resultIds.add(p.toolCallId);
    }
    const approvalIds = new Set<string>();
    for (const p of parts) if (p.type === "tool-approval-request" && p.toolCallId) approvalIds.add(p.toolCallId);

    for (const p of parts) {
      if (p.type !== "tool-call" || !p.toolCallId) continue;
      if (resultIds.has(p.toolCallId)) continue;
      if (i === lastAssistant && approvalIds.has(p.toolCallId)) continue;
      orphans.push(p.toolCallId);
    }
  });
  return orphans;
}

/**
 * Remove the named tool calls (and their approval requests) from assistant
 * messages; an assistant message left with no content is removed.
 */
export function dropOrphanToolCalls(messages: ModelMessage[], toolCallIds: readonly string[]): ModelMessage[] {
  if (toolCallIds.length === 0) return messages;
  const drop = new Set(toolCallIds);
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      out.push(message);
      continue;
    }
    const content = (message.content as ContentPart[]).filter(
      (p) => !((p.type === "tool-call" || p.type === "tool-approval-request") && p.toolCallId && drop.has(p.toolCallId)),
    );
    if (content.length === 0) continue;
    out.push({ ...message, content } as ModelMessage);
  }
  return out;
}

/**
 * Fallback for Contract D item 6 (OPEN-2), tested but NOT wired: mark the
 * last message for caching, for a `prepareStep` to return if the top-level
 * automatic cache mark turns out to be ignored. Returns a copy; the input is
 * not changed.
 */
export function markLastMessageForCache(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const marked = {
    ...last,
    providerOptions: {
      ...(last.providerOptions ?? {}),
      anthropic: {
        ...((last.providerOptions?.anthropic as Record<string, unknown> | undefined) ?? {}),
        cacheControl: { type: "ephemeral" },
      },
    },
  } as ModelMessage;
  return [...messages.slice(0, -1), marked];
}

/** The model calls one turn may make (`stopWhen: stepCountIs(MAX_CHAT_STEPS)`). */
export const MAX_CHAT_STEPS = 8;

/**
 * Appended to the VOLATILE system block on the last allowed step (plan item
 * G, P4). The static block and its cache mark are untouched, so the cached
 * prefix holds; tools stay in the request (`toolChoice: "none"` would strip
 * them, which the API rejects with tool history and which breaks the cache).
 */
export const LAST_STEP_NOTE =
  "This is your last step: tools will not run again in this answer. Write the answer now from what you have, and say what you could not check.";
