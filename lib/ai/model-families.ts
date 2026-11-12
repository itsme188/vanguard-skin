/**
 * Family resolver for calls whose model is chosen per run by FAMILY
 * (sonnet / opus) rather than by capability tier — the armed-print filing
 * summary picker. Pure: (family, live catalog ids, excluded?) → id.
 *
 * Rules:
 *   - The newest catalog id of the chosen family wins, so a version bump
 *     inside the family is followed automatically. An OLDER generation of
 *     the family (below its entry in CURRENT_CLASS_MODELS) is never chosen
 *     (owner ruling 2026-11-12: always the latest version of a class): with
 *     the current id excluded or missing, the walk goes DOWN the ladder,
 *     not back a version.
 *   - When the family has no callable id, walk DOWN the ladder from it
 *     (opus → sonnet), never up: a cheaper choice never silently turns into
 *     a more expensive one. Fable was removed from the ladder on 2026-11-07
 *     (owner ruling): Opus is the top family the picker can reach.
 *   - Nothing callable → null (the caller reports it; there is no static
 *     fallback id here, so no model id is ever written in this file).
 */
import type { SummaryFamily } from "@/lib/filing-summary/types";
import { isCurrentGeneration, parseModelId, type ParsedModel } from "@/lib/ai/model-tiers";

/**
 * Compares two version tuples: [5,10] > [5,9] > [5]; a missing part counts as
 * 0, so [5] equals [5,0]. This file's own copy on purpose: `model-tiers.ts`
 * is kept byte-identical to the Worker's mirror (parity-pinned), so it does
 * not export its comparator for this feature.
 */
export function compareFamilyVersions(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Capability order, highest first. The resolver walks DOWN from the requested
 * rung, so this order must stay most-capable-first even though Sonnet is now
 * the DEFAULT choice (lib/filing-summary/choice.ts) — the default says where a
 * run starts, this ladder says where an unavailable family falls to.
 */
export const SUMMARY_FAMILY_LADDER = ["opus", "sonnet"] as const;

export interface ResolvedFamilyModel {
  modelId: string;
  family: SummaryFamily;
  /** The family the caller asked for, when a lower rung answered; else null. */
  fellBackFrom: SummaryFamily | null;
}

function newestOfFamily(
  family: string,
  catalogIds: string[],
  excluded: Set<string>,
): { id: string; parsed: ParsedModel } | null {
  const hits = catalogIds
    .filter((id) => !excluded.has(id) && isCurrentGeneration(id))
    .map((id) => ({ id, parsed: parseModelId(id) }))
    .filter((x): x is { id: string; parsed: ParsedModel } => x.parsed?.family === family);
  if (hits.length === 0) return null;
  hits.sort((a, b) => compareFamilyVersions(b.parsed.version, a.parsed.version));
  return hits[0];
}

/**
 * The walk itself, over any most-capable-first ladder: the newest current id
 * of `family`, else of each rung BELOW it in turn; null when nothing on the
 * ladder from `family` down is callable (or `family` is not on it). The
 * filing summary walks SUMMARY_FAMILY_LADDER; the chat walks its own, which
 * adds Haiku at the bottom (lib/chat/model-choice.ts). One walk, so the two
 * pickers can never disagree on what "the newest id of a class" means.
 */
export function resolveFamilyOnLadder<F extends string>(
  family: F,
  ladder: readonly F[],
  catalogIds: string[],
  excluded: Set<string> = new Set(),
): { modelId: string; family: F; fellBackFrom: F | null } | null {
  const start = ladder.indexOf(family);
  if (start === -1) return null;
  for (let i = start; i < ladder.length; i++) {
    const rung = ladder[i];
    const hit = newestOfFamily(rung, catalogIds, excluded);
    if (hit) {
      return { modelId: hit.id, family: rung, fellBackFrom: rung === family ? null : family };
    }
  }
  return null;
}

export function resolveFamilyModel(
  family: SummaryFamily,
  catalogIds: string[],
  excluded: Set<string> = new Set(),
): ResolvedFamilyModel | null {
  return resolveFamilyOnLadder<SummaryFamily>(family, SUMMARY_FAMILY_LADDER, catalogIds, excluded);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "claude-opus-5-5" → "Opus 5.5". An id that does not parse is shown as is. */
export function modelLabel(modelId: string): string {
  const parsed = parseModelId(modelId);
  if (!parsed) return modelId;
  return `${capitalise(parsed.family)} ${parsed.version.join(".")}`;
}

/**
 * A model named for a reader: "claude-sonnet-5-5" → "Sonnet 5.5". Unlike
 * `modelLabel`, an id that does not parse is NEVER echoed (CLAUDE.md: user
 * copy names no model id); it reads "the AI model" instead.
 */
export function userFacingModelLabel(modelId: string): string {
  return parseModelId(modelId) ? modelLabel(modelId) : "the AI model";
}

/**
 * "Opus · now 5.5": the version the family itself resolves to today, or
 * "Opus · not available" when the family has no id (no ladder fallback here:
 * the label describes the family, not what a run would fall back to).
 */
export function familyNowLabel(family: SummaryFamily, catalogIds: string[]): string {
  const hit = newestOfFamily(family, catalogIds, new Set());
  const name = capitalise(family);
  return hit ? `${name} · now ${hit.parsed.version.join(".")}` : `${name} · not available`;
}
