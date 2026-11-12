/**
 * Owner ruling 2026-11-12: inside the chat the owner is the only reader, so
 * an assistant answer is no longer replaced by one whole-answer mask when the
 * app-wide privacy toggle is on. The chat takes no part in the toggle at all
 * (the toggle still masks figures everywhere else in the app).
 *
 * No DOM harness in this repo, so these are source pins.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("assistant answers render in full with privacy on (ruling 2026-11-12)", () => {
  it("a text part renders through MarkdownMessage directly", () => {
    const parts = sliceBetween(src, "function renderAssistantParts(", "function renderUserParts(");
    anchorIndex(parts, "<MarkdownMessage key={i} content={part.text} />");
  });

  it("the chat reads nothing from the privacy toggle", () => {
    expect(src).not.toMatch(/PrivateMarkdown|PrivateText|usePrivacy|isPrivate|@\/lib\/privacy\//);
  });
});
