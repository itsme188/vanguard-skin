import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FIRST_PASS_MAX_OUTPUT_TOKENS } from "@/lib/print-watch/read";

// Source pin (no DOM/AI harness): the first-pass read must pass an explicit
// output cap to generateObjectForFeature. The Anthropic provider defaults an
// unknown (5-generation) model id to 4,096 output tokens, and thinking counts
// against it on the frontier tier — an unset cap truncates the JSON silently.
describe("print-watch first-pass read output cap", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "lib/print-watch/read.ts"), "utf8");

  it("passes FIRST_PASS_MAX_OUTPUT_TOKENS to the printWatchFirstPass generateObject call", () => {
    const call = src.slice(src.indexOf('generateObjectForFeature("printWatchFirstPass"'));
    const body = call.slice(0, call.indexOf("} as never)"));
    expect(body).toContain("maxOutputTokens: FIRST_PASS_MAX_OUTPUT_TOKENS");
  });

  it("is comfortably above the provider's 4,096 default for unknown model ids", () => {
    expect(FIRST_PASS_MAX_OUTPUT_TOKENS).toBeGreaterThan(4096);
  });
});
