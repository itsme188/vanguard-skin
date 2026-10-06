/**
 * Guard: a horizontally scrollable table under app/dashboard must be wrapped in
 * the shared <ScrollFade>, not a bare `overflow-x-auto` div, so a clipped column
 * is discoverable. Source-scan test (no DOM harness).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// file -> justification
const ALLOWLIST: Record<string, string> = {
  // Chat markdown tables render inside the chat rail's own prose container;
  // the table element is spread from react-markdown props and ScrollFade's
  // fade overlay would not align with the bubble's rounded padding.
  "app/dashboard/components/MarkdownMessage.tsx": "chat bubble markdown table",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("no bare overflow-x-auto wrapper around a <table>", () => {
  const offenders = walk("app/dashboard").filter((f) => {
    if (f.endsWith("ScrollFade.tsx") || f in ALLOWLIST) return false;
    const src = readFileSync(f, "utf8");
    return /overflow-x-auto[^"'`]*["'`]\s*>\s*<table/.test(src);
  });
  it("uses <ScrollFade> for every wide table", () => {
    expect(offenders).toEqual([]);
  });
  it("allowlist entries still exist and still match (keep it honest)", () => {
    for (const f of Object.keys(ALLOWLIST)) {
      expect(readFileSync(f, "utf8")).toMatch(/overflow-x-auto[^"'`]*["'`]\s*>\s*<table/);
    }
  });
});
