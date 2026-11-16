import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// FX4-UI item 4 (browser pass 2026-11-16): at 375px the "basis verified"
// lot notes were squeezed into a ~110px Status column, making rows 300-560px
// tall. Below md the table scrolls sideways, so the lot notes get a readable
// width floor there; from md up the floor is removed (desktop unchanged).
// No DOM harness: a source pin. Browser check: Analysis > Giving at 375px.
const src = readFileSync("app/dashboard/components/giving/GivingYearSection.tsx", "utf8");

describe("Giving lot notes at phone width (FX4 item 4)", () => {
  it("the width floor applies below md only", () => {
    anchorIndex(src, 'const LOT_NOTES_NARROW_WIDTH = "min-w-[18rem] md:min-w-0";');
  });

  it("wraps the per-lot controls in the Status cell, after the status chip", () => {
    const chip = anchorIndex(src, "<Chip tone={STATUS_TONE[gd.status]}>{STATUS_LABEL[gd.status]}</Chip>");
    const wrapper = anchorIndex(src, "<div className={LOT_NOTES_NARROW_WIDTH}>", chip);
    const control = anchorIndex(src, "<LotBasisControl", wrapper);
    const close = anchorIndex(src, "</div>", control);
    const actionsCell = anchorIndex(src, '<td className="px-3 py-2.5 text-right whitespace-nowrap">', chip);
    expect(close).toBeLessThan(actionsCell);
    // Rendered once only (a second copy would duplicate the dialog's ids).
    expect(src.split("<LotBasisControl").length - 1).toBe(1);
  });
});
