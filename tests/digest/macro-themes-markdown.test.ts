import { describe, it, expect } from "vitest";
import { renderMacroThemesMarkdown } from "@/lib/digest/macro-themes-markdown";

describe("renderMacroThemesMarkdown", () => {
  it("returns null when themes array is empty", () => {
    expect(renderMacroThemesMarkdown([])).toBeNull();
  });

  it("renders a heading and one bullet per theme", () => {
    const md = renderMacroThemesMarkdown([
      { name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off",
        summary: "Trade headlines pushed risk lower.", exposure_bucket: "high",
        top_contributors: [{ symbol: "AAPL", weight: 0.04 }] },
      { name: "Rate cut hopes", factor_label: "interest_rate_sensitive", direction: "risk-on",
        summary: "Softer CPI revived September cut bets.", exposure_bucket: "moderate",
        top_contributors: [] },
    ]);
    expect(md).toContain("## Macro context this week");
    expect(md).toContain("Tariff escalation");
    expect(md).toContain("risk-off");
    expect(md).toContain("your exposure: high");
    expect(md).toContain("Rate cut hopes");
  });
});
