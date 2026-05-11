import type { MacroTheme } from "@/lib/compute/macro-themes";

const DIRECTION_GLYPHS: Record<MacroTheme["direction"], string> = {
  "risk-on": "↑", "risk-off": "↓", neutral: "→",
};

/**
 * Renders cached macro themes as a markdown block for inclusion in the Sunday
 * briefing prompt. Returns null on empty input so the caller can omit the
 * section entirely rather than emitting a heading with no bullets.
 */
export function renderMacroThemesMarkdown(themes: MacroTheme[]): string | null {
  if (themes.length === 0) return null;
  const lines: string[] = ["## Macro context this week", ""];
  for (const t of themes) {
    const arrow = DIRECTION_GLYPHS[t.direction] ?? "·";
    const contribs = t.top_contributors.length > 0
      ? ` · top: ${t.top_contributors.map((c) => c.symbol).join(", ")}`
      : "";
    lines.push(`- **${t.name}** ${arrow} *${t.direction}* · your exposure: ${t.exposure_bucket}${contribs}`);
    lines.push(`  ${t.summary}`);
  }
  lines.push("");
  return lines.join("\n");
}
