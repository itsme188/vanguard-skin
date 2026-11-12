import { describe, it, expect } from "vitest";
import * as titles from "@/lib/chat/conversation-title";
import {
  titleFromUserText,
  conversationTitleFromMessages,
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

describe("no display masking (owner ruling 2026-11-12)", () => {
  it("the module exports no title-masking helper", () => {
    // Inside the chat the owner is the only reader; a title is shown as
    // stored whatever the privacy toggle says.
    expect(Object.keys(titles).sort()).toEqual(
      ["TITLE_MAX_CHARS", "conversationTitleFromMessages", "titleFromUserText"].sort(),
    );
  });
});
