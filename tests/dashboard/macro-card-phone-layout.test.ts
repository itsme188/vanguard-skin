import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// No DOM harness in this repo: the JSX is pinned by a source scan.
// Phone layout: the exposure chip drops under the theme title below `sm`, and
// the cited-source link carries the touch extension.

const CARD = readFileSync("app/dashboard/components/analysis/MacroOverlayCard.tsx", "utf8");

describe("Macro card phone layout", () => {
  it("the theme header row wraps; the title and chip are phone-only rules reset at sm", () => {
    const nameAt = anchorIndex(CARD, "{t.name}</h4>", 0, "theme title");
    const slice = CARD.slice(Math.max(0, nameAt - 700), nameAt + 700);

    const rowAt = anchorIndex(slice, "items-baseline gap-2", 0, "header row");
    const rowStart = slice.lastIndexOf("<div", rowAt);
    const rowTag = slice.slice(rowStart, slice.indexOf(">", rowAt));
    expect(rowTag).toContain("flex-wrap");

    const h4Start = anchorIndex(slice, "<h4", 0, "h4");
    const h4Tag = slice.slice(h4Start, slice.indexOf(">", h4Start));
    expect(h4Tag).toContain("basis-[calc(100%-1.5rem)]");
    expect(h4Tag).toContain("sm:basis-0");
    expect(h4Tag).toContain("min-w-0");
    expect(h4Tag).toContain("flex-1");

    const chipAt = anchorIndex(slice, "your exposure", 0, "chip text");
    const chipStart = slice.lastIndexOf("<span", chipAt);
    const chipTag = slice.slice(chipStart, chipAt);
    expect(chipTag).toContain("ml-4");
    expect(chipTag).toContain("sm:ml-0");
  });

  it("the cited-source link carries the touch extension", () => {
    const hrefAt = anchorIndex(CARD, "href={citedSourceHref(t) ?? undefined}", 0, "cited link");
    const tagStart = CARD.lastIndexOf("<a", hrefAt);
    const tagEnd = CARD.indexOf(">", hrefAt);
    const tag = CARD.slice(tagStart, tagEnd);
    expect(tag).toContain("relative");
    expect(tag).toContain("pointer-coarse:after:absolute");
    expect(tag).toContain("pointer-coarse:after:content-['']");
    expect(tag).toContain("pointer-coarse:after:-inset-2");
  });
});
