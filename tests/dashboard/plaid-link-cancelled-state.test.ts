/**
 * Closing Plaid Link without an error is a cancellation, not a failure.
 *
 * The page used to put "Link closed before connecting" in the error state,
 * so it rendered in the error colour. No DOM harness in this repo (and a
 * Next page file may not export helpers), so these are source pins located
 * with `anchorIndex`, which throws when an anchor vanishes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/plaid-link/page.tsx", "utf8");

describe("plaid-link: a closed Link is 'cancelled', a failed Link is 'error'", () => {
  it("the state union has a cancelled member carrying a message", () => {
    const union = sliceBetween(src, "type ConnectState =", "// Persisted across");
    expect(union).toContain('{ kind: "cancelled"; message: string }');
    expect(union).toContain('{ kind: "error"; message: string }');
  });

  it("handleExit with no error sets cancelled, never error", () => {
    const exit = sliceBetween(src, "function handleExit(", "async function run()");
    const noErr = sliceBetween(exit, "if (!err) {", "return;");
    expect(noErr).toContain('kind: "cancelled"');
    expect(noErr).not.toContain('kind: "error"');
    expect(noErr).toContain("nothing was changed");
  });

  it("handleExit with an error still sets error", () => {
    const exit = sliceBetween(src, "function handleExit(", "async function run()");
    const withErr = exit.slice(anchorIndex(exit, "return;", anchorIndex(exit, "if (!err) {")));
    expect(withErr).toContain('kind: "error"');
    expect(withErr).toContain("err.display_message || err.error_message");
    expect(withErr).not.toContain('kind: "cancelled"');
  });

  it("cancelled renders in neutral ink with the back link, not the error colour", () => {
    const block = sliceBetween(src, '{state.kind === "cancelled" && (', ")}");
    expect(block).toContain("text-ink-dim");
    expect(block).not.toContain("text-down");
    expect(block).toContain('href="/dashboard/today"');
    expect(block).toContain("Back to Portfolio Desk");
  });

  it("error still renders in the error colour", () => {
    const block = sliceBetween(src, '{state.kind === "error" && (', ")}");
    expect(block).toContain("text-down");
  });
});
