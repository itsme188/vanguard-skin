/**
 * The chat's per-conversation model CLASS (owner-approved 2026-11-13).
 * Client-safe: constants, the validator and the label. Nothing here names a
 * model id; the class resolves to its newest current id on the server at
 * request time (lib/chat/model-resolve.ts).
 *
 * Policy:
 *   - The owner picks Haiku, Sonnet or Opus on the new-chat screen; Sonnet
 *     (the workhorse tier the chat ran on before) is preselected every time.
 *   - The choice is stored on the conversation row (migration 103) when the
 *     conversation is created and never changes: the prompt cache is per
 *     model, and one thread should not mix models.
 *   - Fable is not a choice (owner ruling 2026-11-07,
 *     tests/ai/no-fable-model-policy.test.ts scans this file).
 */
import { userFacingModelLabel } from "@/lib/ai/model-families";
import { isCurrentGeneration } from "@/lib/ai/model-tiers";

/** Picker order, cheapest first. Only these three names are valid. */
export const CHAT_MODEL_FAMILIES = ["haiku", "sonnet", "opus"] as const;
export type ChatModelFamily = (typeof CHAT_MODEL_FAMILIES)[number];

export const DEFAULT_CHAT_MODEL_FAMILY: ChatModelFamily = "sonnet";

/**
 * Capability order, highest first. An unavailable class walks DOWN this
 * ladder; the walk itself never picks an older version of a class. When it
 * finds nothing current from the class down (an unavailable Haiku, or a
 * catalog with no current-generation id at all), the turn runs on the chat's
 * default resolution (lib/chat/model-resolve.ts), and THAT may be an older
 * version: the tier resolver degrades rather than be down. The label then
 * says so ("Sonnet 4.6 (older version in use)").
 */
export const CHAT_FAMILY_LADDER = ["opus", "sonnet", "haiku"] as const satisfies readonly ChatModelFamily[];

export function isChatModelFamily(x: unknown): x is ChatModelFamily {
  return typeof x === "string" && (CHAT_MODEL_FAMILIES as readonly string[]).includes(x);
}

/** A stored `model_family` value, or null for "no class" (NULL, or a value no longer offered). */
export function readStoredChatFamily(x: unknown): ChatModelFamily | null {
  return isChatModelFamily(x) ? x : null;
}

/** "haiku" → "Haiku". */
export function chatFamilyName(family: ChatModelFamily): string {
  return family.charAt(0).toUpperCase() + family.slice(1);
}

/** The 400 sentence for a value that is not one of the three classes. */
export function invalidModelFamilyMessage(raw: unknown): string {
  const shown = typeof raw === "string" ? raw.slice(0, 40) : String(raw);
  return `Unknown model class: ${shown}. Valid: ${CHAT_MODEL_FAMILIES.join(", ")}.`;
}

/**
 * The quiet label a conversation shows: "Opus 5.5"; when a lower class
 * answered because the chosen one is not available, "Sonnet 5.5 (Opus not
 * available)"; when the model is an older version than its class's current
 * one, "Sonnet 4.6 (older version in use)"; both notes together when both
 * hold. An id that does not parse is never printed (it reads "the AI model").
 */
export function chatModelLabel(r: { modelId: string; fellBackFrom: ChatModelFamily | null }): string {
  const name = userFacingModelLabel(r.modelId);
  const notes: string[] = [];
  if (r.fellBackFrom) notes.push(`${chatFamilyName(r.fellBackFrom)} not available`);
  if (!isCurrentGeneration(r.modelId)) notes.push("older version in use");
  return notes.length > 0 ? `${name} (${notes.join("; ")})` : name;
}

/**
 * The label the OPEN conversation shows in its header. A conversation in the
 * list shows the label the server resolved for it (null for a conversation
 * with no class: it shows nothing extra). A brand-new conversation whose
 * first turn is still on its way (no row in the list yet) shows the class
 * name it was started on, until the list refresh brings its version.
 */
export function openConversationModelLabel(
  conversations: readonly { id: number; model_family?: string | null; model_label?: string | null }[],
  currentId: number | null,
  pendingFamily: ChatModelFamily,
  liveLabel: string | null,
): string | null {
  if (currentId !== null) {
    const row = conversations.find((c) => c.id === currentId);
    if (row) {
      if (row.model_label) return row.model_label;
      // A listed row with a class but no resolved label (the server could
      // not resolve it this time): the stream's label, else the class name,
      // so a conversation created with a class never shows an empty label.
      const family = readStoredChatFamily(row.model_family);
      return family === null ? null : (liveLabel ?? chatFamilyName(family));
    }
  }
  // Not listed yet (the first turn, or a list refresh that failed): what the
  // server said this turn resolved to, else the class that was picked.
  return liveLabel ?? chatFamilyName(pendingFamily);
}

/**
 * The resolved-model label the server put on this turn's stream (the `start`
 * part's metadata, `modelLabel`), newest assistant message first; null when
 * none carries one (a history reloaded from the database is text only).
 */
export function liveModelLabel(messages: readonly { role: string; metadata?: unknown }[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || m.metadata === null || typeof m.metadata !== "object") continue;
    const label = (m.metadata as { modelLabel?: unknown }).modelLabel;
    if (typeof label === "string" && label.length > 0) return label;
  }
  return null;
}

/**
 * The class a request carries: the open conversation's own stored class when
 * the list knows it (so a conversation deleted elsewhere is recreated on its
 * class, never on the default), none for a listed conversation with no
 * class, and the picker's value for a new chat or a conversation whose row
 * is not listed yet (its first turn was just adopted). The server uses it
 * only when it creates a row and ignores it for an existing one.
 */
export function requestModelFamily(
  conversations: readonly { id: number; model_family: string | null }[],
  openId: number | null,
  picked: ChatModelFamily,
): ChatModelFamily | null {
  if (openId === null) return picked;
  const row = conversations.find((c) => c.id === openId);
  return row ? readStoredChatFamily(row.model_family) : picked;
}
