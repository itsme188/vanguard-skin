/**
 * QA finding: a failed chat turn leaves useChat's `error` / status "error"
 * set. Starting a new conversation or loading a saved one only called
 * setMessages, so the stale error bubble (and a Retry that regenerates the
 * OTHER conversation's last answer) leaked across the switch. Every
 * conversation switch must call the hook's `clearError`.
 *
 * No DOM harness in this repo — source-scan pin, same precedent as
 * tests/dashboard/data-health-view-scrollfade.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ChatInterface.tsx"),
  "utf8",
);

function sliceFrom(marker: string, length = 900): string {
  const i = anchorIndex(src, marker);
  expect(i, `${marker} not found`).toBeGreaterThan(-1);
  return src.slice(i, i + length);
}

describe("ChatInterface conversation switches clear the stale chat error", () => {
  it("destructures clearError from useChat", () => {
    const m = src.match(/const\s*\{([^}]*)\}\s*=\s*useChat\(/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/\bclearError\b/);
  });

  it("handleNewConversation calls clearError", () => {
    const body = sliceFrom("function handleNewConversation()", 400).split("\n  }\n")[0];
    expect(body).toMatch(/clearError\(\)/);
  });

  it("loadConversation calls clearError", () => {
    const body = sliceFrom("const loadConversation = useCallback(", 900).split("[setMessages")[0];
    expect(body).toMatch(/clearError\(\)/);
  });

  it("deleting the open conversation calls clearError", () => {
    const body = sliceFrom("if (conv.id === conversationId) {", 300);
    expect(body).toMatch(/clearError\(\)/);
  });
});
