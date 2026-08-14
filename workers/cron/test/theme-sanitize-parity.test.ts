/**
 * Parity pin for the shared theme-cleaning constants between the Mac
 * (zero-import) module and its Worker mirror — same pattern as
 * editions.test.ts's LISTING_BREADTH_MIN check: read both files with fs,
 * extract the shared bits by regex, assert byte-identical.
 *
 * Mac: lib/gmail/theme-sanitize.ts
 * Worker: workers/cron/src/fallback-digest.ts
 *
 * These two are semantic-parity by convention (see both files' header
 * comments) — this test makes a silent drift between them fail loudly
 * instead of only surfacing as a live-content difference between the local
 * digest and the cloud-fallback digest.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mac = readFileSync(resolve(__dirname, "../../../lib/gmail/theme-sanitize.ts"), "utf8");
const worker = readFileSync(resolve(__dirname, "../src/fallback-digest.ts"), "utf8");

function extractSummaryTagRemnant(src: string): string | null {
  const m = src.match(/const SUMMARY_TAG_REMNANT =\s*\n?\s*(\/[\s\S]*?\/[a-z]*);/);
  return m ? m[1] : null;
}

function extractSummaryJsonEnvelopeRemnant(src: string): string | null {
  const m = src.match(/const SUMMARY_JSON_ENVELOPE_REMNANT =\s*\n?\s*(\/[\s\S]*?\/[a-z]*);/);
  return m ? m[1] : null;
}

function extractCleanThemeElement(src: string): string | null {
  const m = src.match(/function cleanThemeElement\(raw: string\): string \{[\s\S]*?\n\}/);
  return m ? m[0] : null;
}

describe("theme-sanitize parity (Worker mirror of lib/gmail/theme-sanitize.ts)", () => {
  it("SUMMARY_TAG_REMNANT regex literal is byte-identical", () => {
    const macRegex = extractSummaryTagRemnant(mac);
    const workerRegex = extractSummaryTagRemnant(worker);
    expect(macRegex).not.toBeNull();
    expect(workerRegex).toBe(macRegex);
  });

  it("cleanThemeElement body is byte-identical", () => {
    const macFn = extractCleanThemeElement(mac);
    const workerFn = extractCleanThemeElement(worker);
    expect(macFn).not.toBeNull();
    expect(workerFn).toBe(macFn);
  });

  // 2026-08-14: SUMMARY_JSON_ENVELOPE_REMNANT added alongside SUMMARY_TAG_REMNANT
  // to catch the cloud-fallback JSON-envelope leak shape (no XML tags). Pin it
  // the same way so the two sides can't silently drift.
  it("SUMMARY_JSON_ENVELOPE_REMNANT regex literal is byte-identical", () => {
    const macRegex = extractSummaryJsonEnvelopeRemnant(mac);
    const workerRegex = extractSummaryJsonEnvelopeRemnant(worker);
    expect(macRegex).not.toBeNull();
    expect(workerRegex).toBe(macRegex);
  });
});
