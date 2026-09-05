import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { formatUSD } from "@/lib/format";

describe("Equity curve tooltip shows full-precision dollars", () => {
  const src = () =>
    readFileSync("app/dashboard/components/EquityCurveChart.tsx", "utf8");

  it("imports formatUSD from lib/format", () => {
    expect(src()).toMatch(/import\s*\{[^}]*\bformatUSD\b[^}]*\}\s*from\s*"@\/lib\/format"/);
  });

  it("defines currencyTooltipFormatter via usePrivateFormatter(formatUSD)", () => {
    expect(src()).toMatch(
      /const currencyTooltipFormatter = usePrivateFormatter\(formatUSD\);/
    );
  });

  it("every Tooltip block's formatter in the account chart uses currencyTooltipFormatter, not the compact tick formatter", () => {
    const text = src();
    // Isolate the EquityCurveChart component body (per-account chart), which
    // starts after the PerformanceCurveChart (indexed-to-100) component.
    const accountChartStart = text.indexOf("export function EquityCurveChart");
    expect(accountChartStart).toBeGreaterThan(-1);
    const accountChartSrc = text.slice(accountChartStart);

    // Every <Tooltip ... formatter={...} block in the account chart must call
    // currencyTooltipFormatter — never currencyTickFormatter — inside its
    // formatter prop's returned array.
    const tooltipBlocks = accountChartSrc.match(/<Tooltip[\s\S]*?\/>/g) ?? [];
    expect(tooltipBlocks.length).toBeGreaterThanOrEqual(2);

    for (const block of tooltipBlocks) {
      const formatterIdx = block.indexOf("formatter={");
      expect(formatterIdx).toBeGreaterThan(-1);
      // `formatter=` is the last prop in these Tooltip elements, so slicing
      // from its start to the block's end captures the whole callback body.
      const formatterAndAfter = block.slice(formatterIdx);
      expect(formatterAndAfter).toContain("currencyTooltipFormatter");
      expect(formatterAndAfter).not.toContain("currencyTickFormatter");
    }
  });

  it("Y-axis ticks stay compact (tickFormatter={currencyTickFormatter} still present)", () => {
    expect(src()).toContain("tickFormatter={currencyTickFormatter}");
  });

  it("formatCurrency (compact) is still defined and used only for ticks, not reused as the tooltip formatter", () => {
    const text = src();
    expect(text).toMatch(/function formatCurrency\(/);
    expect(text).toContain("usePrivateFormatter(formatCurrency)");
  });

  it("formatUSD renders full dollars with thousands separators", () => {
    expect(formatUSD(1695041.96)).toBe("$1,695,042");
  });

  it("the compact tick formatter would have collapsed distinguishable values to the same string", () => {
    // Reproduces the regression: formatCurrency (compact, module-private in
    // EquityCurveChart.tsx) rounds anything >= $1M to one decimal in millions,
    // so a $46K range within the same million-dollar band is indistinguishable.
    const formatCurrency = (value: number): string => {
      if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
      if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
      return `$${value.toFixed(0)}`;
    };
    const a = 1_695_041.96;
    const b = 1_660_000;
    expect(formatCurrency(a)).toBe(formatCurrency(b)); // both "$1.7M" — collapsed
    expect(formatUSD(a)).not.toBe(formatUSD(b)); // full precision distinguishes them
  });
});
