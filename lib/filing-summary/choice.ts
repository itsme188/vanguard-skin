/**
 * The five model choices the filing-summary picker offers, the default, and
 * the label each one shows. Storage is `{family, effort}`; nothing here names
 * a model id (the family resolver maps a family to a live id at run time).
 */
import type { SummaryChoice } from "./types";

export const DEFAULT_SUMMARY_CHOICE: SummaryChoice = { family: "opus", effort: "high" };

/** Picker order. Only these five pairs are valid choices. */
export const SUMMARY_CHOICES: SummaryChoice[] = [
  { family: "sonnet", effort: "medium" },
  { family: "opus", effort: "medium" },
  { family: "opus", effort: "high" },
  { family: "fable", effort: "medium" },
  { family: "fable", effort: "high" },
];

export function isSummaryChoice(x: unknown): x is SummaryChoice {
  if (typeof x !== "object" || x === null) return false;
  const { family, effort } = x as { family?: unknown; effort?: unknown };
  return SUMMARY_CHOICES.some((c) => c.family === family && c.effort === effort);
}

/** "Opus · high": capitalised family, a middle dot, the effort. */
export function choiceLabel(c: SummaryChoice): string {
  return `${c.family.charAt(0).toUpperCase()}${c.family.slice(1)} · ${c.effort}`;
}
