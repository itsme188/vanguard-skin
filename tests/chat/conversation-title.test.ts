import { describe, it, expect } from "vitest";
import {
  titleFromUserText,
  conversationTitleFromMessages,
  maskTitleFigures,
} from "@/lib/chat/conversation-title";

describe("titleFromUserText", () => {
  it("keeps a short message whole", () => {
    expect(titleFromUserText("How is ZZA doing today?")).toBe("How is ZZA doing today?");
  });
  it("truncates at a word boundary with an ellipsis", () => {
    const t = titleFromUserText(
      "Please explain why the technology sector underperformed the broader market last quarter in detail",
    );
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(61);
    const body = t.slice(0, -1);
    expect(
      "Please explain why the technology sector underperformed the broader market last quarter in detail".startsWith(body),
    ).toBe(true);
    expect(body.endsWith(" ")).toBe(false);
    expect(body.endsWith("underperfor")).toBe(false);
  });
  it("hard-cuts one very long word", () => {
    const t = titleFromUserText("x".repeat(200));
    expect(t).toBe("x".repeat(60) + "…");
  });
  it("returns empty for empty or whitespace input", () => {
    expect(titleFromUserText("")).toBe("");
    expect(titleFromUserText("  \n\t ")).toBe("");
  });
  it("uses only the first non-empty line of a multi-line message", () => {
    expect(titleFromUserText("\n\nWhat is ZZB?\nSecond line here")).toBe("What is ZZB?");
  });
  it("strips markdown noise", () => {
    expect(titleFromUserText("## **Trim** `ZZA`")).toBe("Trim ZZA");
  });
});

describe("conversationTitleFromMessages", () => {
  it("reads the first user message text parts", () => {
    const msgs = [
      { role: "user", parts: [{ type: "text", text: "Compare ZZA " }, { type: "text", text: "and ZZB" }] },
      { role: "assistant", parts: [{ type: "text", text: "Sure." }] },
    ];
    expect(conversationTitleFromMessages(msgs)).toBe("Compare ZZA and ZZB");
  });
  it("returns empty when there is no user text", () => {
    expect(conversationTitleFromMessages([])).toBe("");
    expect(conversationTitleFromMessages([{ role: "user", parts: [{ type: "file" }] }])).toBe("");
  });
});

describe("maskTitleFigures", () => {
  const M = "•••";
  it("masks currency amounts", () => {
    expect(maskTitleFigures("Why did $12,500.50 change")).toBe(`Why did ${M} change`);
    expect(maskTitleFigures("Sell $2k of ZZA")).toBe(`Sell ${M} of ZZA`);
    expect(maskTitleFigures("worth 3.5M USD")).not.toMatch(/3\.5M/);
  });
  it("masks percentages", () => {
    expect(maskTitleFigures("ZZA is up 12.5% today")).toBe(`ZZA is up ${M} today`);
  });
  it("masks share counts", () => {
    expect(maskTitleFigures("I own 150 shares of ZZB")).toBe(`I own ${M} of ZZB`);
    expect(maskTitleFigures("sold 1,200 sh")).toBe(`sold ${M}`);
  });
  it("keeps tickers, words and dates", () => {
    const s = "Outlook for ZZA vs ZZB on 2026-07-15 and FY26";
    expect(maskTitleFigures(s)).toBe(s);
  });
});
