/** Alert card: no Retry for an AI account or setup failure (source pin; no DOM harness). */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isFinalSuggestionFailure } from "@/lib/alerts/suggestion-failure";

const src = fs.readFileSync(path.join(process.cwd(), "app/dashboard/alerts/page.tsx"), "utf8");

describe("alert card suggestion failure", () => {
  it("final reasons are the two AI ones only", () => {
    expect(isFinalSuggestionFailure("ai_account")).toBe(true);
    expect(isFinalSuggestionFailure("ai_not_configured")).toBe(true);
    expect(isFinalSuggestionFailure("generation_failed")).toBe(false);
    expect(isFinalSuggestionFailure(undefined)).toBe(false);
  });

  it("the handler reads the server reason and the Retry button is withheld when not retryable", () => {
    expect(src).toContain("isFinalSuggestionFailure(reasonBody?.reason)");
    const btn = src.indexOf("onClick={askSuggestion}");
    expect(btn).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, btn - 200), btn);
    expect(before).toContain("suggestFailure?.retryable ?? true");
  });
});
