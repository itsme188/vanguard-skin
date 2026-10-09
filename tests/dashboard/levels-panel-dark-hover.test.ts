import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";
import { darkModuleRatio } from "../helpers/dark-module-scan";
import {
  DARK_MODULE_DIM_TEXT,
  DARK_MODULE_HOVER_TEXT,
} from "@/app/dashboard/components/dark-module-text";

// Browser pass 2026-10-09: on the chart panel (always dark, in both page
// themes) the "Edit" button on a level row and the "N Suggested ·
// Auto-detected" toggle are inline-styled grey and gave no sign of being
// under the pointer. They now brighten on hover. The panel is always dark,
// so the hover colour is a hex with a measured ratio, never a theme token.
const src = readFileSync(
  join(process.cwd(), "app/dashboard/components/LevelsPanel.tsx"),
  "utf8",
);

const FLOOR = 4.5;

describe("hover feedback on the always-dark levels panel", () => {
  it("the hover text colour clears 4.5:1 on every dark-module surface and is brighter than the dim grey", () => {
    const hover = darkModuleRatio(DARK_MODULE_HOVER_TEXT.slice(1));
    expect(hover).toBeGreaterThanOrEqual(FLOOR);
    expect(hover).toBeGreaterThan(darkModuleRatio(DARK_MODULE_DIM_TEXT.slice(1)));
  });

  it("the rest colours of the two controls clear 4.5:1 too", () => {
    expect(darkModuleRatio("999999")).toBeGreaterThanOrEqual(FLOOR);
    expect(darkModuleRatio("888888")).toBeGreaterThanOrEqual(FLOOR);
  });

  it("the Suggested · Auto-detected toggle brightens under the pointer", () => {
    const start = anchorIndex(src, "onClick={() => setExpanded((v) => !v)}");
    const toggle = src.slice(start, anchorIndex(src, "Suggested · Auto-detected", start));
    expect(toggle).toContain('{...darkModuleHover({ color: "#999" })}');
    expect(toggle).toContain('color: "#999"');
    expect(toggle).not.toMatch(/hover:text-ink/);
  });

  it("the embedded Edit button brightens its text and border under the pointer", () => {
    // The first "Edit this level" is the inline-styled button on the dark panel.
    const start = anchorIndex(src, 'title="Edit this level"');
    const button = src.slice(start, anchorIndex(src, "</button>", start));
    expect(button).toContain('border: "1px solid #333"');
    expect(button).toMatch(
      /\{\.\.\.darkModuleHover\(\{\s*color: "#888",\s*borderColor: "#333",\s*\}\)\}/,
    );
    expect(button).not.toMatch(/hover:text-ink/);
  });

  it("the helper sets the shared hover colour and puts the rest colours back", () => {
    const start = anchorIndex(src, "function darkModuleHover(");
    const helper = src.slice(start, anchorIndex(src, "\n}\n", start));
    expect(helper).toContain("style.color = DARK_MODULE_HOVER_TEXT");
    expect(helper).toContain("style.color = rest.color");
    expect(helper).toContain("style.borderColor = rest.borderColor");
    expect(helper).toContain("onMouseEnter");
    expect(helper).toContain("onMouseLeave");
  });
});
