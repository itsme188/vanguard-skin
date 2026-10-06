/**
 * Source pin: a first-turn failure before the server creates a conversation
 * must not adopt convs[0] (an unrelated old thread). Adoption is gated on the
 * conversation being created at/after the turn's send-start.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const src = readFileSync(
  join(__dirname, "../../app/dashboard/components/ChatInterface.tsx"),
  "utf8",
);

describe("chat failed-turn conversation adoption", () => {
  it("has no unconditional adoption of convs[0]", () => {
    expect(src).not.toMatch(/\{\s*\/\/[^\n]*\n\s*setConversationId\(convs\[0\]\.id\);\s*\}/);
    const idx = src.indexOf("setConversationId(convs[0].id)");
    expect(idx).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, idx - 200), idx);
    expect(before).toMatch(/createdMs\s*>=\s*startedAt/);
  });
  it("records send-start on submit and Retry and compares created_at", () => {
    expect(src).toContain("sendStartedAtRef");
    expect(src.match(/sendStartedAtRef\.current = Date\.now\(\)/g)?.length).toBe(2);
    expect(src).toContain("convs[0].created_at");
  });
});
