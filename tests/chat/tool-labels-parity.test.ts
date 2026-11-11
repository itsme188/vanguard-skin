/**
 * Contract F (Portfolio Assistant plan): every chat tool has a UI label in the
 * client-safe lib/chat/tool-labels.ts, and lib/chat/tools.ts re-exports that
 * one map as TOOL_LABELS (no second copy to drift).
 *
 * Protects: no tool shows a raw tool name in the chat UI.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CHAT_TOOLS, TOOL_LABELS } from "@/lib/chat/tools";
import { CHAT_TOOL_LABELS } from "@/lib/chat/tool-labels";

describe("tool labels", () => {
  it("every CHAT_TOOLS name has a label", () => {
    const missing = CHAT_TOOLS.map((t) => t.name).filter((n) => !CHAT_TOOL_LABELS[n]);
    expect(missing).toEqual([]);
  });

  it("TOOL_LABELS is the same map, re-exported", () => {
    expect(TOOL_LABELS).toBe(CHAT_TOOL_LABELS);
    const src = readFileSync("lib/chat/tools.ts", "utf8");
    expect(src).toContain('export { CHAT_TOOL_LABELS as TOOL_LABELS } from "./tool-labels"');
    expect(src).not.toMatch(/export const TOOL_LABELS/);
  });
});
