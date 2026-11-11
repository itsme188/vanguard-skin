/**
 * Chat evaluation: read the route's `[chat-usage]` server-log lines (pure).
 *
 * The line format is owned by lib/chat/usage-log.ts (D6, P15): one JSON
 * object per step (`kind: "step"`) and one per turn (`kind: "turn"`) after
 * the fixed prefix. The prefix is imported, not copied, so a rename there
 * breaks this reader loudly in the type check rather than silently.
 */

import { USAGE_LINE_PREFIX } from "../../lib/chat/usage-log";
import type { TokenUsage } from "./pricing";

export interface UsageLine {
  kind: "step" | "turn";
  conversationId: number | null;
  scope: string | null;
  model: string | null;
  /** Zero-based step number (step lines). */
  step: number | null;
  /** Step count (turn lines). */
  steps: number | null;
  usage: TokenUsage;
  /** True when any of the four token fields was missing (null) in the line. */
  incomplete: boolean;
  finishReason: string | null;
}

function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function s(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Every well-formed usage line in a block of log text, in order. */
export function parseUsageLines(logText: string): UsageLine[] {
  const out: UsageLine[] = [];
  for (const rawLine of logText.split(/\r?\n/)) {
    const at = rawLine.indexOf(USAGE_LINE_PREFIX);
    if (at < 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(rawLine.slice(at + USAGE_LINE_PREFIX.length)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.kind !== "step" && obj.kind !== "turn") continue;
    const fields = [n(obj.noCache), n(obj.cacheWrite), n(obj.cacheRead), n(obj.output)];
    out.push({
      kind: obj.kind,
      conversationId: n(obj.conversationId),
      scope: s(obj.scope),
      model: s(obj.model),
      step: n(obj.step),
      steps: n(obj.steps),
      usage: {
        noCache: fields[0] ?? 0,
        cacheWrite: fields[1] ?? 0,
        cacheRead: fields[2] ?? 0,
        output: fields[3] ?? 0,
      },
      incomplete: fields.some((f) => f === null),
      finishReason: s(obj.finishReason),
    });
  }
  return out;
}

export interface ConversationUsage {
  steps: UsageLine[];
  /** Turn lines for the conversation, one per request, in order. */
  turns: UsageLine[];
}

export interface TurnUsage {
  steps: UsageLine[];
  /** The turn's summary line, or null when it has not been written (yet). */
  turn: UsageLine | null;
}

/**
 * One conversation's lines grouped per request: the step lines up to and
 * including each turn line. The eval sends one request at a time per
 * conversation, so log order is request order. A trailing group with no
 * turn line is a request still running (or one whose turn line was lost).
 */
export function splitTurns(lines: readonly UsageLine[], conversationId: number): TurnUsage[] {
  const groups: TurnUsage[] = [];
  let current: UsageLine[] = [];
  for (const l of lines) {
    if (l.conversationId !== conversationId) continue;
    if (l.kind === "step") current.push(l);
    else {
      groups.push({ steps: current, turn: l });
      current = [];
    }
  }
  if (current.length > 0) groups.push({ steps: current, turn: null });
  return groups;
}

/** The lines for one conversation id. */
export function usageForConversation(lines: readonly UsageLine[], conversationId: number): ConversationUsage {
  const mine = lines.filter((l) => l.conversationId === conversationId);
  return { steps: mine.filter((l) => l.kind === "step"), turns: mine.filter((l) => l.kind === "turn") };
}
