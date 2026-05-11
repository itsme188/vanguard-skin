import { describe, it, expect } from "vitest";
import { MacroThemesSchema, type MacroThemeAi } from "@/lib/compute/macro-themes";

describe("MacroThemesSchema", () => {
  it("accepts a well-formed 3-theme array", () => {
    const sample: MacroThemeAi[] = [
      { name: "Tariff escalation", factor_label: "tariff_exposure", direction: "risk-off", summary: "Trade-deal headlines pushed risk down all week." },
      { name: "AI mania cooling", factor_label: "ai_exposure", direction: "risk-off", summary: "Mega-caps gave back gains after weak Capex commentary." },
      { name: "Rate-cut hopes", factor_label: "interest_rate_sensitive", direction: "risk-on", summary: "Softer CPI revived September cut bets." },
    ];
    expect(() => MacroThemesSchema.parse(sample)).not.toThrow();
  });

  it("rejects an empty array (need at least one theme)", () => {
    expect(() => MacroThemesSchema.parse([])).toThrow();
  });

  it("rejects a 6-theme array (cap at 5)", () => {
    const six = Array.from({ length: 6 }).map((_, i) => ({
      name: `T${i}`, factor_label: "ai_exposure",
      direction: "risk-on" as const, summary: "x".repeat(20),
    }));
    expect(() => MacroThemesSchema.parse(six)).toThrow();
  });

  it("rejects an unknown direction value", () => {
    const bad = [{ name: "X", factor_label: "ai_exposure", direction: "sideways", summary: "x".repeat(20) }];
    expect(() => MacroThemesSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown factor_label", () => {
    const bad = [{ name: "X", factor_label: "weather_exposure", direction: "risk-on", summary: "x".repeat(20) }];
    expect(() => MacroThemesSchema.parse(bad)).toThrow();
  });
});
