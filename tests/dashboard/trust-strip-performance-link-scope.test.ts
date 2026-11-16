import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// Review round 5 (2026-11-15), R8: the Trust Strip drawer's "Open
// Performance" link carried no scope, so from an IBKR or Roth workspace it
// landed on the Vanguard default (no ?scope= opens on Vanguard). The strip
// passes its scope down and the link always carries it.
const strip = readFileSync("app/dashboard/components/analysis/TrustStrip.tsx", "utf8");
const drawer = readFileSync("app/dashboard/components/analysis/TrustStripDrawer.tsx", "utf8");

describe("Trust Strip: Open Performance keeps the scope", () => {
  it("the strip hands its scope to the drawer, 'all' when it has none (as its own fetch reads it)", () => {
    const at = anchorIndex(strip, "<TrustStripDrawer");
    const end = strip.indexOf("/>", at);
    expect(strip.slice(at, end)).toContain('scope={scope ?? "all"}');
  });

  it("the drawer takes the scope and the link appends it, never a scope-less href", () => {
    anchorIndex(drawer, "scope: string;");
    anchorIndex(drawer, "<PerformanceContent state={state} scope={scope} />");
    anchorIndex(drawer, "href={`/dashboard/analysis?view=performance&scope=${encodeURIComponent(scope)}`}");
    expect(drawer).not.toContain('href="/dashboard/analysis?view=performance"');
  });
});
