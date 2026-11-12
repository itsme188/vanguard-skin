/**
 * scripts/preprocess-to-canonical.ts converts a whole statement to CSV in one
 * reply. On the 5.5 generation thinking is on by default and counts against
 * max_tokens, so the old 16,384 non-streaming cap could cut a long statement
 * off (2026-11-12). Source pin: the script runs its loop on import, so it is
 * read, not executed.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

const src = fs.readFileSync(path.join(process.cwd(), "scripts/preprocess-to-canonical.ts"), "utf8");

describe("preprocess-to-canonical output limit", () => {
  const call = src.slice(anchorIndex(src, "client.messages"), anchorIndex(src, "const outputText"));

  it("streams the reply (a cap this large is refused without streaming)", () => {
    expect(call).toMatch(/client\.messages\s*\.stream\(/);
    expect(call).toContain(".finalMessage()");
  });

  it("leaves room for thinking plus a long CSV", () => {
    const m = /max_tokens:\s*([\d_]+)/.exec(call);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ""))).toBeGreaterThanOrEqual(64_000);
  });

  it("refuses a reply that still hit the cap instead of writing a cut-off CSV", () => {
    expect(call).toMatch(/stop_reason === "max_tokens"[\s\S]*throw new Error/);
  });
});
