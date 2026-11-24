/**
 * QA finding: on a 390px phone the app confirm dialog was exactly as wide as
 * the screen (`max-w-sm w-full` is 384px), so its border and rounded corners
 * sat on the physical edges. Every page panel keeps a 16px inset.
 *
 * Fix: the width cap is the smaller of the old 24rem and the viewport minus
 * a 1rem gutter on each side.
 *
 * No DOM harness in this repo: pinned with a source scan.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ConfirmDialog.tsx"),
  "utf8",
);

describe("ConfirmDialog keeps a side gutter on a phone", () => {
  const tag = src.slice(anchorIndex(src, "<dialog"));
  const cls = tag.slice(0, tag.indexOf(">"));

  it("caps the width at the viewport minus a gutter, and at 24rem on a wide screen", () => {
    expect(cls).toContain("max-w-[min(24rem,calc(100vw-2rem))]");
    expect(cls).not.toMatch(/\bmax-w-sm\b/);
  });

  it("stays centred and full-width inside that cap", () => {
    expect(cls).toContain("m-auto");
    expect(cls).toContain("w-full");
  });
});
