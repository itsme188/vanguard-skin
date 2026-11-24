import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

/**
 * Bug 15 (2026-11-24): the What-if table must always describe the legs on
 * screen. A failed run used to leave the previous Before/After table under
 * the error, and editing, adding or removing a leg left it beside legs it no
 * longer described. No DOM harness here: source-pin the handlers.
 */
const src = readFileSync("app/dashboard/components/analysis/WhatIfCalculator.tsx", "utf8");

function body(start: string, end: string): string {
  const from = anchorIndex(src, start);
  return src.slice(from, anchorIndex(src, end, from));
}

describe("What-if: a stale result never outlives the legs it described", () => {
  it("editing a leg clears the result", () => {
    expect(body("function updateLeg(", "function removeLeg(")).toContain("setDelta(null)");
  });

  it("removing a leg clears the result", () => {
    expect(body("function removeLeg(", "function addLeg(")).toContain("setDelta(null)");
  });

  it("adding a leg clears the result", () => {
    expect(body("function addLeg(", "async function run(")).toContain("setDelta(null)");
  });

  it("a server failure clears the result before showing the error", () => {
    const run = body("async function run(", "return (");
    const failure = run.slice(anchorIndex(run, "if (!result.ok"), anchorIndex(run, "setDelta(result.data.data)"));
    expect(failure).toContain("setDelta(null)");
  });

  it("a network failure clears the result", () => {
    const run = body("async function run(", "return (");
    const caught = run.slice(anchorIndex(run, "} catch {"), anchorIndex(run, "} finally {"));
    expect(caught).toContain("setDelta(null)");
    expect(caught).toContain('networkFailureMessage("work out the what-if")');
  });

  it("still reads the response through readMutationResult", () => {
    expect(body("async function run(", "return (")).toContain("await readMutationResult<");
  });
});
