/**
 * Server side of the chat's per-conversation model class: class → concrete
 * (provider, model id), at request time. No resolver of its own: the class
 * walk is `resolveFamilyOnLadder` (lib/ai/model-families.ts, shared with the
 * filing summary), the empty-catalog id is the tier table's
 * CURRENT_CLASS_MODELS, and the default is `resolveFeatureModel("chat")`.
 *
 * Precedence (the filing-summary precedent: the per-print choice beats the
 * Settings AI-models override):
 *   1. A stored class resolves to the newest current id of that class, or of
 *      the next class DOWN the chat ladder; a Settings override for the chat
 *      feature is not consulted.
 *   2. With nothing callable from the class down (an unavailable Haiku), the
 *      turn runs on the chat default (step 3) and reports the fallback.
 *   3. No class (NULL: every conversation older than migration 103, or one
 *      created without a class): exactly today's path,
 *      `resolveFeatureModel("chat")`, Settings override included.
 */
import { resolveFamilyOnLadder } from "@/lib/ai/model-families";
import { CURRENT_CLASS_MODELS, parseModelId } from "@/lib/ai/model-tiers";
import { resolveFeatureModel, type ResolvedModel } from "@/lib/ai/models";
import { getCachedModelCatalog } from "@/lib/ai/catalog-source";
import { CHAT_FAMILY_LADDER, readStoredChatFamily, type ChatModelFamily } from "@/lib/chat/model-choice";

export interface ChatModelResolution {
  /** "family": the class picked the id; "default": the chat default did (build it with getModelForFeature). */
  source: "family" | "default";
  resolved: ResolvedModel;
  /** The class stored on the conversation, or null. */
  requested: ChatModelFamily | null;
  /** The class of the id that answers, when it is one of the three; else null. */
  family: ChatModelFamily | null;
  /** The requested class, when a different one answers; else null. */
  fellBackFrom: ChatModelFamily | null;
}

function familyOf(r: ResolvedModel): ChatModelFamily | null {
  return r.provider === "anthropic" ? readStoredChatFamily(parseModelId(r.modelId)?.family) : null;
}

/** Pure: the class, the live catalog and the default resolver in, the answer out. */
export function resolveChatModelFor(
  requested: ChatModelFamily | null,
  catalogIds: string[],
  resolveDefault: () => ResolvedModel,
): ChatModelResolution {
  if (requested !== null) {
    // A fresh database (no stored catalog): the class's current id, as the
    // tier resolver's static fallback does for a tier.
    if (catalogIds.length === 0) {
      return {
        source: "family",
        resolved: { provider: "anthropic", modelId: CURRENT_CLASS_MODELS[requested] },
        requested,
        family: requested,
        fellBackFrom: null,
      };
    }
    const hit = resolveFamilyOnLadder<ChatModelFamily>(requested, CHAT_FAMILY_LADDER, catalogIds);
    if (hit) {
      return {
        source: "family",
        resolved: { provider: "anthropic", modelId: hit.modelId },
        requested,
        family: hit.family,
        fellBackFrom: hit.fellBackFrom,
      };
    }
  }
  const resolved = resolveDefault();
  const family = familyOf(resolved);
  return {
    source: "default",
    resolved,
    requested,
    family,
    fellBackFrom: requested !== null && family !== requested ? requested : null,
  };
}

/** The live answer for a conversation's stored class. */
export function resolveChatModel(requested: ChatModelFamily | null): ChatModelResolution {
  return resolveChatModelFor(requested, getCachedModelCatalog(), () => resolveFeatureModel("chat"));
}
