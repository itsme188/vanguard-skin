import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MENTION_CONTEXT_PLACEHOLDER,
  displayableMentionContext,
} from "@/lib/research/mention-context";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("displayableMentionContext", () => {
  it("returns null for null/undefined/blank", () => {
    expect(displayableMentionContext(null)).toBeNull();
    expect(displayableMentionContext(undefined)).toBeNull();
    expect(displayableMentionContext("  ")).toBeNull();
  });
  it("returns null for the placeholder", () => {
    expect(displayableMentionContext(MENTION_CONTEXT_PLACEHOLDER)).toBeNull();
    expect(displayableMentionContext(`  ${MENTION_CONTEXT_PLACEHOLDER} `)).toBeNull();
  });
  it("returns the trimmed sentence otherwise", () => {
    expect(displayableMentionContext("  Nvidia raised guidance.  ")).toBe("Nvidia raised guidance.");
  });
});

describe("source pins", () => {
  it("writer no longer stores the placeholder literal", () => {
    expect(read("lib/research/reconcile-cloud-fetched.ts")).not.toContain('"cloud-fetched mention"');
  });
  it("card gates the excerpt through the helper", () => {
    expect(read("app/dashboard/components/ResearchMentionsSection.tsx")).toContain("displayableMentionContext");
  });
});
