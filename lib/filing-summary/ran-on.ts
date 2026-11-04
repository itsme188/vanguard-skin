/**
 * Which model actually wrote a filing-summary section (provider-failover,
 * 2026-11-03). Normally the run's pinned Anthropic model; after a classified
 * ACCOUNT-level failure of that model (credit, key) the runner may have served
 * the section from the feature's fallback leg, and the sheet must say so.
 *
 * The runner stores `{ failover: { provider, modelId, kind } }` inside the
 * section's `versions_json`. These helpers are pure and import-free so the
 * view, the panel text and the share page all read the one record.
 */

export interface SectionFailover {
  provider: string;
  modelId: string;
  /** The primary's failure: billing | auth | config. */
  kind: string;
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "workers-ai": "Cloudflare Workers AI",
};

/** The failover record in a section's versions JSON, or null. */
export function readSectionFailover(versionsJson: string | null): SectionFailover | null {
  if (!versionsJson) return null;
  try {
    const f = (JSON.parse(versionsJson) as { failover?: Partial<SectionFailover> } | null)?.failover;
    if (f && typeof f.provider === "string" && typeof f.modelId === "string" && typeof f.kind === "string") {
      return { provider: f.provider, modelId: f.modelId, kind: f.kind };
    }
  } catch {
    // unreadable versions: no record
  }
  return null;
}

/** "OpenAI gpt-6-astra". */
export function failoverLabel(f: SectionFailover): string {
  return `${PROVIDER_NAMES[f.provider] ?? f.provider} ${f.modelId}`;
}

const KIND_WORDS: Record<string, string> = {
  billing: "credit or spend limit",
  auth: "key rejected",
  config: "key missing",
};

/**
 * The banner line for a run with fallback-written sections. `labels` is one
 * entry per fallback-written section; `doneSections` is the run's count of
 * finished sections, so the sentence says whether the fallback wrote the
 * whole run ("every section"), its only section, or a part ("1 of 3").
 */
export function failoverBanner(labels: string[], kind: string, doneSections: number): string {
  const who = [...new Set(labels)].join(" and ");
  const why = KIND_WORDS[kind] ?? "account problem";
  const total = Math.max(doneSections, labels.length);
  const which =
    total === 1
      ? "the section was"
      : labels.length >= total
        ? "every section was"
        : `${labels.length} of ${total} sections were`;
  return `Anthropic was unavailable (${why}) — ${which} written by ${who} instead, with no effort setting. Every figure was still checked against the filing.`;
}

/** The "model effort" phrase every header uses; a fallback-written run names that model and no effort. */
export function modelEffortText(run: { modelLabel: string; effort: string; ranOn?: string | null }): string {
  return run.ranOn ? run.ranOn : `${run.modelLabel} ${run.effort}`;
}

/** "Written by …" line for the panel and the share page footer. */
export function writtenByText(run: { modelLabel: string; effort: string; ranOn?: string | null }): string {
  return run.ranOn ? `${run.ranOn} (Anthropic was unavailable)` : `${run.modelLabel} at ${run.effort} effort`;
}
