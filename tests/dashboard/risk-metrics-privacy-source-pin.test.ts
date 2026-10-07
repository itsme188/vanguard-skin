/**
 * RiskMetrics.tsx rendered three portfolio-derived items bare in privacy
 * mode while sibling tiles masked: the Sharpe value, every MetricCard's
 * interpretation sentence, and the Herfindahl interpretation sentence. The
 * concentration chart also used a percent height, which logs a Recharts
 * negative-size warning.
 *
 * No DOM harness: source pins, anchors located with anchorIndex.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/RiskMetrics.tsx", "utf8");

describe("RiskMetrics privacy masking", () => {
  it("masks the Sharpe value", () => {
    const card = sliceBetween(src, 'label="Sharpe Ratio"', "<WeekOverWeekBadge");
    expect(card).toMatch(/<PrivateText>\s*\{metrics\.sharpeRatio\.toFixed\(2\)\}\s*<\/PrivateText>/);
    expect(card.replace(/<PrivateText>[\s\S]*?<\/PrivateText>/g, "")).not.toContain("toFixed");
  });

  it("masks the MetricCard interpretation sentence", () => {
    const card = sliceBetween(src, "function MetricCard(", "// ─── Component");
    expect(card).toMatch(/<PrivateText>\s*\{interp\.text\}\s*<\/PrivateText>/);
    expect(card.replace(/<PrivateText>[\s\S]*?<\/PrivateText>/g, "")).not.toContain("interp.text");
  });

  it("masks the Herfindahl interpretation sentence", () => {
    expect(src).toMatch(
      /<PrivateText>\s*\{interpretHHI\(metrics\.herfindahl\)\.text\}\s*<\/PrivateText>/,
    );
    expect(src.replace(/<PrivateText>[\s\S]*?<\/PrivateText>/g, "")).not.toMatch(
      /interpretHHI\([^)]*\)\.text/,
    );
  });

  it("leaves the risk-free rate plain (a public figure)", () => {
    const at = anchorIndex(src, "Risk-free: ${(metrics.riskFreeRate * 100).toFixed(2)}%");
    expect(src.slice(at - 40, at)).not.toContain("PrivateText");
  });

  it("gives the concentration chart a fixed pixel height matching h-40", () => {
    const chart = sliceBetween(src, '<div className="h-40">', "<BarChart");
    expect(chart).toMatch(/<ResponsiveContainer\s+width="100%"\s+height=\{160\}>/);
    expect(src).not.toContain('height="100%"');
  });
});
