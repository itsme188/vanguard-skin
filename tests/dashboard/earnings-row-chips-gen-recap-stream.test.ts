/**
 * "gen recap" client — the generate flow reads a Server-Sent Events stream,
 * can be cancelled, and never retries on its own (TODO 2026-08-28 pairing
 * follow-up (1), DECIDED Option 1 in full; server half pinned by
 * tests/api/earnings-recap-modal-sse.test.ts).
 *
 * Source-scan, not a render test: this repo has no jsdom/RTL harness.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/today/EarningsRowChips.tsx", "utf8");

function slice(from: string, to: string): string {
  const start = anchorIndex(src, from);
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(to, start + from.length);
  expect(end, `end anchor not found: ${to}`).toBeGreaterThan(-1);
  return src.slice(start, end);
}

describe("gen recap — reads the stream to its terminal event", () => {
  const reader = slice("async function readRecapStream", "\n}\n");

  it("reads the response body as a stream", () => {
    expect(reader).toMatch(/res\.body\?\.getReader\(\)/);
    expect(reader).toMatch(/line\.startsWith\("data: "\)/);
  });

  it("surfaces each phase message as it arrives", () => {
    expect(reader).toMatch(/onProgress\(event\.progress\.message\)/);
  });

  it("resolves only on a terminal complete or error event", () => {
    expect(reader).toMatch(/if \(event\.complete && event\.data\) return event\.data;/);
    expect(reader).toMatch(/return \{ success: false, error: event\.error \};/);
  });

  it("treats a stream that ends with no terminal event as a failure", () => {
    const tail = reader.slice(reader.lastIndexOf("return {"));
    expect(tail).toMatch(/success: false/);
    expect(tail).toMatch(/connection dropped/);
  });

  it("the handler decides on the terminal payload, not on res.ok alone", () => {
    const fn = slice("async function generateRecap", "\n  function cancelRecap");
    expect(fn).toMatch(/const json = await readRecapStream\(res,/);
    expect(fn).toMatch(/if \(!res\.ok \|\| !json\.success\)/);
  });
});

describe("gen recap — cancel", () => {
  const fn = slice("async function generateRecap", "\n  function cancelRecap");
  const cancel = slice("function cancelRecap", "\n  }\n");

  it("sends the request with an AbortSignal", () => {
    expect(fn).toMatch(/new AbortController\(\)/);
    expect(fn).toMatch(/signal: controller\.signal/);
  });

  it("the dialog offers a visible Cancel button while running", () => {
    const dialog = slice("function RecapGenerateDialog", "\n}\n");
    expect(dialog).toMatch(/onClick=\{onCancel\}[^]*?>\s*Cancel\s*<\/button>/);
    // No hover-revealed controls in the dialog.
    expect(dialog).not.toMatch(/opacity-0|group-hover/);
  });

  it("cancel aborts the request and says nothing was saved", () => {
    expect(cancel).toMatch(/controller\.abort\(\)/);
    expect(cancel).toMatch(/toast\("[^"]*cancelled[^"]*", "info"\)/);
  });

  it("an aborted run is never reported as a failure", () => {
    const catchBlock = fn.slice(fn.indexOf("} catch (err) {"), fn.indexOf("} finally {"));
    expect(catchBlock).toMatch(/if \(controller\.signal\.aborted\) return;\s*\n\s*failure =/);
  });

  it("one click is one generation: the in-flight guard is a ref, and nothing auto-retries", () => {
    expect(fn).toMatch(/if \(genAbortRef\.current\) return;/);
    // The only caller besides the button is the dialog's manual "Try again".
    const calls = src.match(/generateRecap\b/g) ?? [];
    expect(calls).toHaveLength(3); // declaration + button onClick + onRetry
    expect(src).toMatch(/onRetry=\{generateRecap\}/);
  });
});

describe("gen recap — failure dialog", () => {
  it("shows the plain message with a manual retry", () => {
    const dialog = slice("function RecapGenerateDialog", "\n}\n");
    expect(dialog).toMatch(/\{state\.message\}/);
    expect(dialog).toMatch(/onClick=\{onRetry\}[^]*?>\s*Try again\s*<\/button>/);
  });

  it("the dialog is a top-level component, not defined inside the row component", () => {
    const dialogAt = anchorIndex(src, "function RecapGenerateDialog");
    const rowAt = anchorIndex(src, "export function EarningsRowChips");
    expect(dialogAt).toBeGreaterThan(-1);
    expect(dialogAt).toBeLessThan(rowAt);
    expect(src.slice(dialogAt - 1, dialogAt)).toBe("\n");
  });

  it("the generated recap still renders only inside the sandboxed email viewer", () => {
    expect(src).toMatch(/fullHtml: json\.html!/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
