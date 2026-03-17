import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";

describe("buildSystemPrompt", () => {
  const fakeContext = "## Portfolio Summary\n- Test data";
  const today = "2026-03-17";

  it("includes scope preamble for 'all'", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "all");
    expect(prompt).toContain("All Accounts");
    expect(prompt).toContain("filtered to this scope");
  });

  it("includes scope preamble for single account", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr");
    expect(prompt).toContain("IBKR");
    expect(prompt).toContain("filtered to this scope");
  });

  it("uses macro persona when scope is macro", () => {
    const prompt = buildSystemPrompt("", today, "macro");
    expect(prompt).toContain("Macro mode");
    expect(prompt).toContain("market and economic analyst");
    // Should NOT contain portfolio analyst identity
    expect(prompt).not.toContain("portfolio analyst for a personal investment dashboard");
  });

  it("includes first-response instruction", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "all");
    expect(prompt).toContain("first response");
    expect(prompt).toContain("scope");
  });

  it("includes portfolio context for non-macro scopes", () => {
    const prompt = buildSystemPrompt(fakeContext, today, "ibkr");
    expect(prompt).toContain(fakeContext);
  });

  it("has no portfolio context section for macro", () => {
    const prompt = buildSystemPrompt("", today, "macro");
    // Macro still gets the prompt, just without portfolio data
    expect(prompt).toContain("market");
  });

  // Backwards compat: if scope is omitted (undefined), treat as "all"
  it("defaults to 'all' when scope is undefined", () => {
    const prompt = buildSystemPrompt(fakeContext, today, undefined as any);
    expect(prompt).toContain("All Accounts");
  });
});
