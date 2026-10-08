/**
 * Escape closes only the topmost overlay: the chat drawer leaves an Escape
 * alone when another overlay has claimed it or a native dialog is open.
 *
 * The conversation-delete confirmation inside the chat is a native <dialog>.
 * One Escape cancelled it AND closed the drawer underneath. No DOM harness in
 * this repo, so the guard is pinned by source scan (anchorIndex throws on a
 * vanished anchor).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const drawer = readFileSync("app/dashboard/components/ChatDrawer.tsx", "utf8");
const handler = sliceBetween(
  drawer,
  "function handleKeyDown(e: KeyboardEvent) {",
  'window.addEventListener("keydown", handleKeyDown);',
);
const escapeAt = anchorIndex(handler, 'if (e.key === "Escape" && open && !isLargeDesktop) {');
const escapeBranch = handler.slice(escapeAt);
const closeAt = anchorIndex(escapeBranch, "closeDrawer();");
const beforeClose = escapeBranch.slice(0, closeAt);

describe("the chat drawer's Escape guard", () => {
  it("ignores an Escape another overlay already claimed", () => {
    expect(beforeClose).toMatch(/if \(e\.defaultPrevented\) return;/);
  });

  it("ignores Escape while a native dialog is open", () => {
    expect(beforeClose).toContain('document.querySelector("dialog[open]")');
    expect(beforeClose).toMatch(/document\.querySelector\("dialog\[open\]"\)\) return;/);
  });

  it("ignores an Escape whose target sits inside an open dialog", () => {
    expect(beforeClose).toContain('e.target.closest("dialog[open]")');
  });

  it("every guard comes before the close, and the close is the only one", () => {
    expect(escapeBranch.split("closeDrawer();").length - 1).toBe(1);
    expect(beforeClose.match(/return;/g)?.length).toBe(3);
  });

  it("Cmd+J still toggles, and the listener stays a bubble-phase window listener", () => {
    expect(handler).toMatch(/\(e\.metaKey \|\| e\.ctrlKey\) && e\.key === "j"/);
    // The palette claims Escape in the capture phase and stops it; a
    // capture-phase listener here would run before that claim.
    expect(drawer).toContain('window.addEventListener("keydown", handleKeyDown);');
    expect(drawer).not.toContain('window.addEventListener("keydown", handleKeyDown, true)');
  });
});
