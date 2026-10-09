/**
 * The "N stale holdings (>90 days)" line on Data Health reaches 4.5:1 at rest
 * in both themes.
 *
 * Browser finding 2026-10-09: the line is 14px orange (`#f97316`) and measured
 * 2.52:1 on the light theme's surface. It now takes the same treatment as the
 * orange band of the days-stale badge in this file
 * (tests/dashboard/data-health-stale-badge-contrast.test.ts): the orange mixed
 * 60% toward black on a light page, the plain orange on a dark one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import { contrast, hex, mix, token } from "@/tests/helpers/tint-pair-scan";

const src = readFileSync("app/dashboard/components/DataHealthView.tsx", "utf8");
const at = anchorIndex(src, "stale holdings (&gt;90 days)");
const summaryStart = src.lastIndexOf("<summary", at);
const summary = src.slice(summaryStart, at);

const SURFACES = ["canvas", "panel", "raised"] as const;
const FLOOR = 4.5;

describe("Data Health: the stale-holdings line", () => {
  it("the old colour really was under the floor on a light page", () => {
    expect(contrast(hex("f97316"), token("light", "panel"))).toBeLessThan(3);
  });

  it("is small text with the darkened orange on light and the plain orange on dark", () => {
    expect(summary).toContain("text-sm");
    const m = summary.match(
      /text-\[color:color-mix\(in_srgb,#([0-9a-f]{6})_(\d+)%,black\)\] \[\[data-theme=dark\]_&\]:text-\[#([0-9a-f]{6})\]/,
    );
    if (!m) throw new Error("orange treatment not found on the stale-holdings summary");
    const [, lightHex, lightPct, darkHex] = m;
    const lightText = mix(hex(lightHex), [0, 0, 0], Number(lightPct) / 100);
    for (const surface of SURFACES) {
      expect(contrast(lightText, token("light", surface)), `light ${surface}`).toBeGreaterThanOrEqual(FLOOR);
      expect(contrast(hex(darkHex), token("dark", surface)), `dark ${surface}`).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it("no bare orange text class is left in the file", () => {
    expect(src).not.toMatch(/(^|[\s"'`])text-\[#f97316\]/);
  });

  it("the hover is an underline, not a colour change", () => {
    expect(summary).toContain("hover:underline");
    expect(summary).not.toMatch(/hover:text-/);
  });
});
