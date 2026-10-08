/**
 * Guard: a horizontally scrollable table under app/dashboard must be wrapped in
 * the shared <ScrollFade>, not a bare `overflow-x-auto` div, so a clipped column
 * is discoverable. Source-scan test (no DOM harness).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// file -> justification
// Empty since 2026-10-07: the chat markdown table (MarkdownMessage.tsx) was the
// one entry, and a wide answer table clipped its last column with no cue
// (qa: mobile-chat--answer-table-clips-last-column-no-scrollfade-regression-1).
// It now uses <ScrollFade> like every other table.
const ALLOWLIST: Record<string, string> = {};

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
