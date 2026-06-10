/**
 * research-desk.ts — pure helpers for the essay half of the digest.
 *
 * Essays (Stratechery, The Diff, MBI, …) are timeless and near-zero-overlap;
 * they are NEVER merged or synthesized. Each gets its own Research Desk entry
 * rendered in code from the per-article ingest summary. When an essay covers a
 * held/watchlist name that has its own section in the AI synthesis output, a
 * deterministic pointer line is inserted under that section header
 * (post-processing — never a prompt instruction, which would be flaky).
 */

import { sourceKind } from "@/lib/digest/editions";
import { issuerSiblings } from "@/lib/securities/issuer-family";

export interface EssayLike {
  source_name: string;
  subject: string;
  summary: string | null;
  mentioned_symbols: string | null;
  key_themes: string | null;
  source_url: string | null;
  website_url: string | null;
}

export function splitEssays<T extends { source_name: string }>(
  articles: T[],
): { essays: T[]; commentary: T[] } {
  const essays: T[] = [];
  const commentary: T[] = [];
  for (const a of articles) {
    (sourceKind(a.source_name) === "essay" ? essays : commentary).push(a);
  }
  return { essays, commentary };
}

function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** "## Research Desk" markdown section; "" when there are no essays. */
export function renderResearchDesk(essays: EssayLike[]): string {
  if (essays.length === 0) return "";
  const lines: string[] = ["## Research Desk", ""];
  for (const e of essays) {
    const url = e.source_url || e.website_url;
    lines.push(
      url
        ? `**${e.source_name}** — [${e.subject}](${url})`
        : `**${e.source_name}** — ${e.subject}`,
    );
    lines.push("");
    if (e.summary) {
      lines.push(e.summary);
      lines.push("");
    }
    const themes = parseJsonArray(e.key_themes);
    if (themes.length > 0) {
      lines.push(`*${themes.join(" · ")}*`);
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * For each essay covering a held/watchlist symbol, insert a pointer line
 * directly under the matching `## SYM …` section header in the AI output.
 * Symbol matching expands issuer families on BOTH sides (a GOOGL essay
 * cross-files into a GOOG section). At most one pointer per (essay, section).
 */
export function insertCrossFilePointers(
  aiMarkdown: string,
  essays: EssayLike[],
  heldAndWatchlist: string[],
): string {
  if (essays.length === 0 || heldAndWatchlist.length === 0) return aiMarkdown;

  const relevant = new Set(
    heldAndWatchlist.flatMap((s) => issuerSiblings(s)).map((s) => s.toUpperCase()),
  );

  let lines = aiMarkdown.split("\n");
  for (const essay of essays) {
    const symbols = parseJsonArray(essay.mentioned_symbols)
      .map((s) => s.toUpperCase())
      .filter((s) => relevant.has(s));
    if (symbols.length === 0) continue;

    // All family variants this essay could file under.
    const fileUnder = new Set(symbols.flatMap((s) => issuerSiblings(s)).map((s) => s.toUpperCase()));

    const idx = lines.findIndex((line) => {
      const m = line.match(/^##\s+([A-Z][A-Z0-9.\-]*)\b/);
      return m !== null && fileUnder.has(m[1].toUpperCase());
    });
    if (idx === -1) continue;

    const pointer = `📄 *Deep dive today: **${essay.source_name}** — "${essay.subject}" (see Research Desk below)*`;
    lines = [...lines.slice(0, idx + 1), pointer, ...lines.slice(idx + 1)];
  }
  return lines.join("\n");
}
