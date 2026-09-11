/**
 * QA 2026-09-07 —
 * today-earningshub-gen-recap--pre-print-409-console-error-red-toast.
 *
 * Clicking "gen recap" on an armed row whose print window has not opened yet
 * is a routine, expected click. It used to come back 409 (red in the browser
 * console) and fall through the chip client's `throw` into a LOSS-coloured
 * error toast, even though the copy it carried was correct and helpful.
 *
 * The route now answers 200 with { success:false, prePrint:true } — the same
 * shape its own no-actuals-yet guard already used (`notReady`) — and this
 * client has to treat it as INFORMATION, ahead of the !res.ok / !success
 * failure branch.
 *
 * Source-scan, not a render test: this repo has no jsdom/RTL harness (see
 * tests/dashboard/narrative-block-refresh.test.ts for the same reasoning).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("app/dashboard/today/EarningsRowChips.tsx", "utf8");
const route = readFileSync("app/api/earnings/recap-modal/route.ts", "utf8");

describe("gen recap — a pre-print click reads as information, not failure", () => {
  it("reads the route's structured prePrint flag off the JSON body", () => {
    expect(src).toMatch(/prePrint\?:\s*boolean/);
  });

  it("routes prePrint (and notReady) to an info toast, never the error channel", () => {
    const guard = src.match(
      /if \(json\.(?:prePrint|notReady)[^]*?\n\s{6}\}/,
    )?.[0];
    expect(guard, "no prePrint/notReady guard found").toBeTruthy();
    expect(guard).toContain("prePrint");
    expect(guard).toContain("notReady");
    expect(guard).toMatch(/toast\([^]*"info",?\s*\);/);
    expect(guard).not.toMatch(/"error"/);
    expect(guard).toMatch(/\breturn;/);
  });

  it("handles the expected states BEFORE the generic failure branch that throws", () => {
    const expected = src.indexOf("json.prePrint");
    const failure = src.indexOf("if (!res.ok || !json.success)");
    expect(expected).toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(-1);
    expect(expected).toBeLessThan(failure);
  });

  it("keeps the honest-failure branch for real failures", () => {
    // The fix must not turn every failure into a friendly note: a genuine
    // non-OK response still reaches the error toast.
    expect(src).toMatch(/throw new Error\(json\.error \?\? `HTTP \$\{res\.status\}`\)/);
    expect(src).toMatch(/toast\(\s*err instanceof Error[^]*?"error"/);
  });

  it("the route no longer answers the pre-print floor with a 409", () => {
    const branch = route.slice(
      route.indexOf('r?.reason === "pre_print"'),
      route.indexOf("if (r) {"),
    );
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).not.toContain("status: 409");
    expect(branch).toContain("prePrint: true");
  });
});

// 2026-09 follow-up — the client's fetch-level failure toasted a raw
// err.message (the browser's own "Failed to fetch"), and the route's
// documented `opensAt` field ("the instant the caller is waiting for")
// was never read by this component at all — not even typed.
describe("gen recap — network failures and the opensAt contract field", () => {
  it("classifies a rejected fetch before the generic catch, with domain copy", () => {
    const fn = src.slice(
      src.indexOf("async function generateRecap"),
      src.indexOf("\n  return (", src.indexOf("async function generateRecap")),
    );
    expect(fn).toMatch(/apiFetch\([^]*?\)\.catch\(\(\) => null\)/);
    expect(fn).toMatch(/if \(!res\)\s*\{\s*\n\s*toast\("Couldn't reach the server[^"]*", "error"\);/);
  });

  it("still lets a genuine err.message through the generic catch (server-supplied text)", () => {
    expect(src).toMatch(/toast\(err instanceof Error \? err\.message : "Generate failed", "error"\)/);
  });

  it("types and reads json.opensAt instead of ignoring it", () => {
    const fn = src.slice(
      src.indexOf("async function generateRecap"),
      src.indexOf("\n  return (", src.indexOf("async function generateRecap")),
    );
    expect(fn).toMatch(/opensAt\?:\s*string \| null/);
    expect(fn).toMatch(/json\.opensAt/);
  });

  it("renders opensAt through the shared ET formatter, not a hand-rolled Date call", () => {
    expect(src).toMatch(
      /import \{ formatEnrichedAtET \} from "@\/lib\/format"/,
    );
    const fn = src.slice(
      src.indexOf("async function generateRecap"),
      src.indexOf("\n  return (", src.indexOf("async function generateRecap")),
    );
    expect(fn).toMatch(/formatEnrichedAtET\(json\.opensAt\)/);
  });
});
