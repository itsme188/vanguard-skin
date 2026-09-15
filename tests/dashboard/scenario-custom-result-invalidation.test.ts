import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Source-pin tests only (no DOM harness in this repo) — see
// docs/reference (reference_no_dom_test_harness_source_pin). These pin
// BEHAVIOR (which branch a reset lives in, which effect it's attached to,
// whether a stale async response is dropped) rather than exact formatting,
// using balanced-brace extraction instead of naive greedy regexes so an
// unrelated edit elsewhere in the file can't silently widen or narrow a
// match.

function extractBalancedBody(text: string, openBraceIdx: number): string {
  if (text[openBraceIdx] !== "{") {
    throw new Error(
      `extractBalancedBody: expected '{' at index ${openBraceIdx}, got ${JSON.stringify(
        text[openBraceIdx]
      )}`
    );
  }
  let depth = 0;
  for (let i = openBraceIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(openBraceIdx + 1, i);
    }
  }
  throw new Error("extractBalancedBody: unbalanced braces");
}

// Finds the ONE useEffect whose dependency array is exactly `[scope]` by
// locating its distinctive closing `}, [scope]);` and walking backward to
// the nearest preceding `useEffect(` — robust to another effect (with a
// different dependency array) being added earlier in the file, which would
// defeat a naive "first useEffect in the file" match.
function extractScopeEffectBody(text: string): string {
  const closerRe = /\}\s*,\s*\[\s*scope\s*\]\s*\)\s*;/;
  const closerMatch = closerRe.exec(text);
  expect(closerMatch, "expected a useEffect closing with exactly [scope] deps").not.toBeNull();
  const closerIndex = closerMatch!.index;
  const useEffectIdx = text.lastIndexOf("useEffect(", closerIndex);
  expect(useEffectIdx).toBeGreaterThan(-1);
  const arrowIdx = text.indexOf("=>", useEffectIdx);
  expect(arrowIdx).toBeGreaterThan(useEffectIdx);
  const openBraceIdx = text.indexOf("{", arrowIdx);
  expect(openBraceIdx).toBeGreaterThan(arrowIdx);
  return extractBalancedBody(text, openBraceIdx);
}

function extractHandleComputeCustomBody(text: string): string {
  const marker = /const\s+handleComputeCustom\s*=\s*useCallback\(\s*async\s*\(\)\s*=>\s*\{/;
  const match = marker.exec(text);
  expect(match, "expected handleComputeCustom = useCallback(async () => { ... })").not.toBeNull();
  const openBraceIdx = match!.index + match![0].length - 1;
  return extractBalancedBody(text, openBraceIdx);
}

describe("Custom scenario result is invalidated on scope switch and Hide", () => {
  const src = () =>
    readFileSync("app/dashboard/components/ScenarioModeling.tsx", "utf8");

  it("the [scope] effect resets error, custom result/error, expanded state, and bumps a request token", () => {
    const body = extractScopeEffectBody(src());

    // Switching scope must clear the previous custom result/error — a card
    // computed for the OLD scope must not keep showing next to presets for
    // the NEW scope.
    expect(body).toContain("setCustomResult(null)");
    expect(body).toContain("setCustomError(null)");
    // The preset-fetch error is scope-specific too — otherwise a scope that
    // once failed pins the whole card to that stale message forever, even
    // after a later scope's fetch succeeds (the render guard reads `error`
    // unconditionally).
    expect(body).toContain("setError(null)");
    // Nothing should stay expanded across a scope switch — most obviously
    // the "custom" card, which no longer has a result to show.
    expect(body).toContain("setExpanded(null)");
    // A request token gets bumped so an in-flight custom-scenario request
    // from the OLD scope can recognize itself as stale when its response
    // lands.
    expect(body).toMatch(/\.current\s*(\+=\s*1|\+\+|=\s*\w+\.current\s*\+\s*1)/);
  });

  it("hiding the custom scenario builder clears result/error/expanded INSIDE the showBuilder branch; opening does not", () => {
    const text = src();
    const labelIdx = text.indexOf('Custom Scenario{" "}');
    expect(labelIdx).toBeGreaterThan(-1);
    const beforeLabel = text.slice(0, labelIdx);
    const btnStart = beforeLabel.lastIndexOf("<button");
    expect(btnStart).toBeGreaterThan(-1);
    const buttonBlock = text.slice(btnStart, labelIdx);

    const ifMatch = /if\s*\(\s*showBuilder\s*\)\s*\{/.exec(buttonBlock);
    expect(ifMatch, "expected an `if (showBuilder) { ... }` guard").not.toBeNull();
    const openBraceIdx = ifMatch!.index + ifMatch![0].length - 1;
    const ifBody = extractBalancedBody(buttonBlock, openBraceIdx);

    // The resets must live INSIDE the showBuilder branch (the transition
    // that HIDES the builder) — a version that clears unconditionally, or
    // only on the OPEN transition, must fail this.
    expect(ifBody).toContain("setCustomResult(null)");
    expect(ifBody).toContain("setCustomError(null)");
    expect(ifBody).toContain("setExpanded(null)");

    // Pin that each reset appears exactly once in the whole button block —
    // i.e. only inside the if-branch, never ALSO unconditionally elsewhere
    // in the same handler.
    for (const reset of ["setCustomResult(null)", "setCustomError(null)", "setExpanded(null)"]) {
      const occurrences = buttonBlock.split(reset).length - 1;
      expect(occurrences, `expected exactly one "${reset}" in the Build/Hide button handler`).toBe(1);
    }
  });

  it("handleComputeCustom captures a request token and drops a stale response before re-seating the result", () => {
    const body = extractHandleComputeCustomBody(src());

    // Captures the in-flight request's token (read once, up front) so a
    // later response can compare itself against whatever the [scope]
    // effect has since bumped it to.
    const captureMatch = /(const|let)\s+(\w+)\s*=\s*(\w+)\.current\s*;/.exec(body);
    expect(captureMatch, "expected the handler to capture requestTokenRef.current into a local variable").not.toBeNull();
    const [, , capturedVar, refName] = captureMatch!;

    // A mismatch against the captured token must be checked — and checked
    // BEFORE the success branch re-seats state — so a stale response
    // (computed for a scope the user has since switched away from) is
    // dropped instead of clobbering the new scope's (empty) result.
    const guardRe = new RegExp(
      `${refName}\\.current\\s*!==\\s*${capturedVar}\\s*\\)\\s*return`
    );
    const guardMatch = guardRe.exec(body);
    expect(guardMatch, "expected an early-return guard comparing the ref against the captured token").not.toBeNull();

    const resultIdx = body.indexOf("setCustomResult(json.data)");
    expect(resultIdx).toBeGreaterThan(-1);
    expect(guardMatch!.index).toBeLessThan(resultIdx);
  });

  it("still declares customResult and customError state", () => {
    const text = src();
    expect(text).toMatch(/const \[customResult, setCustomResult\]/);
    expect(text).toMatch(/const \[customError, setCustomError\]/);
  });
});
