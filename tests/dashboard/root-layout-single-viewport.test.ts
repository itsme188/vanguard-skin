import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * qa:global-head--duplicate-viewport-meta-second-tag-drops-viewport-fit-cover
 *
 * Next.js emits its own default `<meta name="viewport">` unless the root
 * layout exports `viewport`. A hand-written tag alongside it produces TWO
 * viewport metas, and WebKit honours the LAST one parsed — which drops the
 * `viewport-fit=cover` opt-in that `pb-safe` / env(safe-area-inset-*) need
 * on iPhone. Pin: exactly one declaration, via the `viewport` export, with
 * viewportFit "cover", and no hand-written meta tag in the layout.
 */
describe("root layout viewport declaration", () => {
  const src = readFileSync(path.join(process.cwd(), "app/layout.tsx"), "utf8");

  it("exports a Next viewport object carrying viewportFit: cover", () => {
    expect(src).toMatch(/export const viewport\s*:\s*Viewport\s*=/);
    expect(src).toMatch(/viewportFit:\s*["']cover["']/);
    expect(src).toMatch(/width:\s*["']device-width["']/);
    expect(src).toMatch(/initialScale:\s*1\b/);
  });

  it("has no hand-written viewport meta tag (Next would emit a second one)", () => {
    expect(src).not.toMatch(/<meta\s+name=["']viewport["']/);
  });
});
