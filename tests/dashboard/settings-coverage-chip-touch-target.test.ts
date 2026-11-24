/**
 * The remove button on a coverage-warning chip is a bare multiplication sign,
 * a few pixels wide. A mis-tap there silently switches a coverage warning back
 * on, so on a touch screen the button carries an invisible extension.
 *
 * No DOM harness in this repo: this is a source pin on the button's classes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "app/dashboard/components/settings/CoverageGapIgnoredSymbols.tsx"),
  "utf8",
);

describe("coverage-warning chip remove button (source pin)", () => {
  const at = source.indexOf("aria-label={`Stop ignoring ${sym}`}");
  const button = source.slice(source.lastIndexOf("<button", at), at);

  it("is found", () => {
    expect(at).toBeGreaterThan(-1);
  });

  it("carries a touch extension on coarse pointers", () => {
    expect(button).toMatch(/\brelative\b/);
    expect(button).toContain("pointer-coarse:after:absolute");
    expect(button).toContain("pointer-coarse:after:content-['']");
    expect(button).toMatch(/pointer-coarse:after:-inset-y-/);
    expect(button).toMatch(/pointer-coarse:after:-left-/);
    expect(button).toMatch(/pointer-coarse:after:-right-/);
  });
});
