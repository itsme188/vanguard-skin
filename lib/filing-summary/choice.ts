/**
 * The model choices the filing-summary picker offers, the default, and the
 * label each one shows. Storage is `{family, effort}`; nothing here names a
 * model id (the family resolver maps a family to a live id at run time).
 *
 * Policy (owner ruling 2026-11-07): the default is SONNET at HIGH effort.
 * High effort carries over from the old Opus · high default on purpose — the
 * summary's hard rules (R1: every on-screen number bound to a typed figure;
 * R9: Contradicted only from established operands) are careful-arithmetic
 * work, which the effort budget buys, so the family drops a rung and the
 * thinking budget does not. Opus stays in the list as the deliberate
 * escalation. Fable is no longer selectable.
 */
import type { SummaryChoice, StoredSummaryChoice } from "./types";

export const DEFAULT_SUMMARY_CHOICE: SummaryChoice = { family: "sonnet", effort: "high" };

/** Picker order, cheapest first. Only these four pairs are valid choices. */
export const SUMMARY_CHOICES: SummaryChoice[] = [
  { family: "sonnet", effort: "medium" },
  { family: "sonnet", effort: "high" },
  { family: "opus", effort: "medium" },
  { family: "opus", effort: "high" },
];

export function isSummaryChoice(x: unknown): x is SummaryChoice {
  if (typeof x !== "object" || x === null) return false;
  const { family, effort } = x as { family?: unknown; effort?: unknown };
  return SUMMARY_CHOICES.some((c) => c.family === family && c.effort === effort);
}

/**
 * A choice read from storage, resolved to one the picker still offers.
 *
 * A print whose choice was saved before 2026-11-07 may hold a retired family
 * (Fable). That row is OWNER DATA and is never rewritten — this is the read-
 * time resolution instead: a retired family resolves to the whole default
 * choice, so the run starts on Sonnet at the default effort rather than on a
 * family no ladder can reach. A still-valid stored choice is returned as is.
 */
export function normalizeStoredChoice(c: StoredSummaryChoice): {
  choice: SummaryChoice;
  retired: boolean;
} {
  return isSummaryChoice(c)
    ? { choice: { family: c.family, effort: c.effort }, retired: false }
    : { choice: { ...DEFAULT_SUMMARY_CHOICE }, retired: true };
}

/** "Opus · high": capitalised family, a middle dot, the effort. */
export function choiceLabel(c: SummaryChoice): string {
  return `${c.family.charAt(0).toUpperCase()}${c.family.slice(1)} · ${c.effort}`;
}
