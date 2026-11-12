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

/** Picker order, cheapest first. Only these three names are valid. */
export const CHAT_MODEL_FAMILIES = ["haiku", "sonnet", "opus"] as const;
export type ChatModelFamily = (typeof CHAT_MODEL_FAMILIES)[number];

export const DEFAULT_CHAT_MODEL_FAMILY: ChatModelFamily = "sonnet";

/**
 * Capability order, highest first. An unavailable class walks DOWN this
 * ladder (never up, never to an older version of the same class). Haiku is
 * the bottom rung: with nothing below it, an unavailable Haiku runs on the
 * chat's default resolution instead (lib/chat/model-resolve.ts).
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
 * The quiet label a conversation shows: "Opus 5.5", or, when a lower class
 * answered because the chosen one is not available, "Sonnet 5.5 (Opus not
 * available)". An id that does not parse is never printed (it reads "the AI
 * model").
 */
export function chatModelLabel(r: { modelId: string; fellBackFrom: ChatModelFamily | null }): string {
  const name = userFacingModelLabel(r.modelId);
  return r.fellBackFrom ? `${name} (${chatFamilyName(r.fellBackFrom)} not available)` : name;
}
