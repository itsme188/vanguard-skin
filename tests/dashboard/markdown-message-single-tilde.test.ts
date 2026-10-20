/**
 * Chat answers often write approximate figures as "~$136" or "~3%". With
 * remark-gfm's default, a single tilde opens strikethrough, so two such
 * figures in one paragraph render struck through
 * (qa:dashboard-today-chat-rail-markdownmessage-chat-renders-two-approximate-figures-as-struck-through-text).
 * The GFM plugin is configured with singleTilde: false, so only "~~" strikes
 * and a lone "~" stays literal. Source-pin test; the parse behaviour itself is
 * checked below by running remark with the same option.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/MarkdownMessage.tsx", "utf8");

describe("MarkdownMessage GFM tilde handling", () => {
  it("passes singleTilde: false to remark-gfm", () => {
    const at = anchorIndex(src, "remarkPlugins=", 0, "remarkPlugins prop");
    const region = src.slice(at, at + 160);
    expect(region).toMatch(/\[remarkGfm,\s*\{\s*singleTilde:\s*false\s*\}\]/);
  });

  it("a lone tilde does not strike text while a double tilde still does", async () => {
    const { unified } = await import("unified");
    const remarkParse = (await import("remark-parse")).default;
    const remarkGfm = (await import("remark-gfm")).default;
    const tree = unified()
      .use(remarkParse)
      .use(remarkGfm, { singleTilde: false })
      .parse("Spent ~$136 and ~$140 on it, ~~not~~ really.");
    const json = JSON.stringify(tree);
    expect(json).toContain("~$136 and ~$140");
    expect((json.match(/"type":"delete"/g) ?? []).length).toBe(1);
  });
});
