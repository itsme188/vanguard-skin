/**
 * QA unit B27 — chat panel layout. Eight low-severity phone findings, all
 * layout, focus or class changes. No DOM harness in this repo, so each is a
 * source pin (anchors via anchorIndex so a vanished anchor fails loudly).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const read = (p: string) => readFileSync(p, "utf8");
const iface = read("app/dashboard/components/ChatInterface.tsx");
const drawer = read("app/dashboard/components/ChatDrawer.tsx");
const markdown = read("app/dashboard/components/MarkdownMessage.tsx");
const openButton = read("app/dashboard/components/OpenChatButton.tsx");

const TOUCH_EXTENSION = /\brelative\b[^"]*pointer-coarse:after:absolute[^"]*pointer-coarse:after:content-\[''\][^"]*pointer-coarse:after:-inset/;

// qa: mobile-chat--answer-table-clips-last-column-no-scrollfade-regression-1
describe("chat answer tables carry the ScrollFade cue", () => {
  it("the markdown table is wrapped in <ScrollFade>, not a bare overflow div", () => {
    expect(markdown).toMatch(/import \{ ScrollFade \} from "\.\/ScrollFade"/);
    const table = sliceBetween(markdown, "table({ node, ...props })", "thead({ node");
    expect(table).toMatch(/<ScrollFade className="mb-3">\s*<table /);
    expect(table).not.toContain("overflow-x-auto");
  });
});

// qa: mobile-chat--composer-and-send-edge-to-edge-no-inset
describe("the composer shares the drawer's 16px inset on a phone", () => {
  it("the input area is inset at phone width only", () => {
    const area = sliceBetween(iface, "{/* Input area", "<form onSubmit={handleSubmit}");
    expect(area).toMatch(/className="[^"]*\bmax-md:px-4\b[^"]*"/);
  });
});

// qa: mobile-chat--picker-new-conversation-copy-16px-targets-no-touch-extension
describe("small chat controls extend their touch target", () => {
  it("Copy message", () => {
    const btn = sliceBetween(iface, "onClick={handleCopy}", 'aria-label="Copy message"');
    expect(btn).toMatch(TOUCH_EXTENSION);
  });
  it("the conversation picker trigger, which must not clip its own extension", () => {
    const btn = sliceBetween(iface, "onClick={() => setOpen((v) => !v)}", "title={isPrivate ? \"Current conversation\"");
    expect(btn).toMatch(TOUCH_EXTENSION);
    const cls = btn.match(/className="([^"]*)"/)![1];
    // `truncate` sets overflow:hidden, which would clip the ::after box.
    expect(cls.split(/\s+/)).not.toContain("truncate");
    expect(cls.split(/\s+/)).not.toContain("overflow-hidden");
  });
  it("New Conversation", () => {
    const controls = sliceBetween(iface, "function ConversationControls(", "// ─── Main component");
    const btn = controls.slice(anchorIndex(controls, "onClick={onNew}"));
    expect(btn.slice(0, anchorIndex(btn, "New Conversation"))).toMatch(TOUCH_EXTENSION);
  });
});

// qa: mobile-chat-drawer--close-leaves-focus-inside-aria-hidden-no-inert-regression-1
describe("closing the drawer moves focus out before the panel hides", () => {
  const fn = sliceBetween(drawer, "const closeDrawer = useCallback(", "const toggle = useCallback(");
  it("closeDrawer releases focus, then closes", () => {
    const release = anchorIndex(fn, "releaseFocus()");
    expect(release).toBeLessThan(anchorIndex(fn, "setOpen(false)"));
  });
  it("releaseFocus only acts when focus is inside the panel, and hands it to a visible opener or main", () => {
    const rel = sliceBetween(drawer, "const releaseFocus = useCallback(", "const closeDrawer = useCallback(");
    expect(rel).toContain("panelRef.current");
    expect(rel).toContain(".contains(");
    expect(rel).toContain('button[aria-label="Open chat"]');
    expect(rel).toContain('button[aria-label="Toggle chat assistant"]');
    expect(rel).toContain('"main"');
    expect(rel).toContain("offsetParent !== null");
    expect(rel).toContain(".focus(");
  });
  it("every user-driven close goes through closeDrawer", () => {
    // Both Close buttons and the backdrop.
    expect(drawer.match(/onClick=\{closeDrawer\}/g)).toHaveLength(3);
    expect(drawer).not.toContain("onClick={() => setOpen(false)}");
    // Escape.
    const keys = sliceBetween(drawer, "function handleKeyDown(e: KeyboardEvent)", 'window.addEventListener("keydown"');
    expect(keys).toContain("closeDrawer()");
    expect(keys).not.toContain("setOpen(false)");
    // Cmd+J / the header toggle while open.
    const toggle = sliceBetween(drawer, "const toggle = useCallback(", "// open-chat: an OPEN-ONLY");
    expect(toggle).toContain("closeDrawer()");
  });
});

// qa: mobile-chat-drawer--open-leaves-focus-on-bottom-nav-button-behind-overlay
describe("opening the overlay moves focus into the dialog", () => {
  const toggle = sliceBetween(drawer, "const toggle = useCallback(", "// open-chat: an OPEN-ONLY");
  it("the toggle path focuses the panel on a phone (no keyboard pop) and the composer on the drawer", () => {
    expect(toggle).toContain("panelRef.current?.focus(");
    expect(toggle).toContain('new CustomEvent("focus-chat-input")');
    expect(toggle).toContain("isMobile");
  });
  it("the panel is focusable from script and is modal at phone width", () => {
    const panel = drawer.slice(anchorIndex(drawer, "{/* Chat panel."), anchorIndex(drawer, "{/* Header */}"));
    expect(panel).toContain("ref={panelRef}");
    expect(panel).toContain("tabIndex={-1}");
    expect(panel).toContain("aria-modal={isMobile ? true : undefined}");
  });
});

// qa: mobile-chat-drawer--closed-panel-sweeps-across-screen-on-every-load
describe("the panel does not animate a layout-mode swap", () => {
  it("the slide transition is armed only once the layout mode has settled", () => {
    expect(drawer).toContain("const slideArmed = settledMode === layoutMode;");
    const panel = drawer.slice(anchorIndex(drawer, "{/* Chat panel."), anchorIndex(drawer, "{/* Header */}"));
    // No unconditional transition class on the panel.
    expect(panel).not.toMatch(/className=\{`[^`$]*transition-transform/);
    expect(panel).toMatch(/slideArmed \? "transition-transform duration-300 ease-in-out" : ""/);
  });
  it("arming waits two frames after the mode change and is cancelled by the next change", () => {
    const eff = sliceBetween(drawer, "const [settledMode, setSettledMode]", "const slideArmed =");
    expect(eff.match(/requestAnimationFrame\(/g)).toHaveLength(2);
    expect(eff.match(/cancelAnimationFrame\(/g)).toHaveLength(2);
    expect(eff).toContain("[layoutMode]");
  });
});

// qa: mobile-chat-landscape--transcript-squeezed-while-space-below-composer-sits-empty
describe("the chat fills the drawer at md and up", () => {
  it("the root keeps the phone height and fills its container from md", () => {
    const root = iface.slice(anchorIndex(iface, '\n  return (\n    <div className="flex flex-col'));
    const cls = root.match(/className="([^"]*)"/)![1].split(/\s+/);
    expect(cls).toContain("h-[calc(100dvh-12rem)]");
    expect(cls).toContain("md:h-full");
  });
  it("the drawer gives it a definite height to fill", () => {
    expect(drawer).toContain('"h-[calc(100%-49px)]"');
  });
});

// qa: mobile-today--chat-cta-shows-cmd-j-keyboard-hint
describe("Today's chat button hides the keyboard hint on touch", () => {
  it("the Cmd+J hint is pointer-coarse:hidden", () => {
    const i = anchorIndex(openButton, ">Cmd+J</span>");
    const span = openButton.slice(openButton.lastIndexOf("<span", i), i);
    expect(span).toContain("pointer-coarse:hidden");
  });
});

// The event NotesAmbient listens for must keep its name and payload.
describe("chat-state-change broadcast is unchanged", () => {
  it("name and payload", () => {
    expect(drawer).toContain('new CustomEvent("chat-state-change", { detail: { open: railVisible } }),');
    expect(drawer.match(/chat-state-change/g)).toHaveLength(1);
  });
});
