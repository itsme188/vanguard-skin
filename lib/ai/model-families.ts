/**
 * Family resolver for calls whose model is chosen per run by FAMILY
 * (sonnet / opus / fable) rather than by capability tier — the armed-print
 * filing summary picker. Pure: (family, live catalog ids, excluded?) → id.
 *
 * Rules:
 *   - The newest catalog id of the chosen family wins, so a version bump
 *     inside the family is followed automatically.
 *   - When the family has no callable id, walk DOWN the ladder from it
 *     (fable → opus → sonnet), never up: a cheaper choice never silently
 *     turns into a more expensive one.
 *   - Nothing callable → null (the caller reports it; there is no static
 *     fallback id here, so no model id is ever written in this file).
 */
import type { SummaryFamily } from "@/lib/filing-summary/types";
import { parseModelId, type ParsedModel } from "@/lib/ai/model-tiers";

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

/** Capability order, highest first. */
export const SUMMARY_FAMILY_LADDER = ["fable", "opus", "sonnet"] as const;

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
    .filter((id) => !excluded.has(id))
    .map((id) => ({ id, parsed: parseModelId(id) }))
    .filter((x): x is { id: string; parsed: ParsedModel } => x.parsed?.family === family);
  if (hits.length === 0) return null;
  hits.sort((a, b) => compareFamilyVersions(b.parsed.version, a.parsed.version));
  return hits[0];
}

export function resolveFamilyModel(
  family: SummaryFamily,
  catalogIds: string[],
  excluded: Set<string> = new Set(),
): ResolvedFamilyModel | null {
  const start = SUMMARY_FAMILY_LADDER.indexOf(family);
  if (start === -1) return null;
  for (let i = start; i < SUMMARY_FAMILY_LADDER.length; i++) {
    const rung = SUMMARY_FAMILY_LADDER[i];
    const hit = newestOfFamily(rung, catalogIds, excluded);
    if (hit) {
      return { modelId: hit.id, family: rung, fellBackFrom: rung === family ? null : family };
    }
  }
  return null;
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
 * "Fable · now 5.1": the version the family itself resolves to today, or
 * "Fable · not available" when the family has no id (no ladder fallback here:
 * the label describes the family, not what a run would fall back to).
 */
export function familyNowLabel(family: SummaryFamily, catalogIds: string[]): string {
  const hit = newestOfFamily(family, catalogIds, new Set());
  const name = capitalise(family);
  return hit ? `${name} · now ${hit.parsed.version.join(".")}` : `${name} · not available`;
}
