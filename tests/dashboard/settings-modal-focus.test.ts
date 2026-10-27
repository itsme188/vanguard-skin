/**
 * QA 2026-10-25: the Settings modal had no dialog role and never took focus,
 * so Tab kept walking the page behind the backdrop. The panel is now a modal
 * dialog named by its heading and uses the shared focus hook
 * (useModalFocus.ts, whose ring and effect are pinned in
 * giving-lot-drawer-focus.test.ts).
 *
 * There is no DOM harness in this repo; these are source pins.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const SRC = readFileSync("app/dashboard/components/SettingsModal.tsx", "utf8");

describe("SettingsModal is a real modal dialog", () => {
  const panel = sliceBetween(SRC, "ref={panelRef}", ">\n");

  it("the panel carries the dialog role, aria-modal, aria-labelledby and tabIndex -1", () => {
    expect(panel).toContain('role="dialog"');
    expect(panel).toContain('aria-modal="true"');
    expect(panel).toContain('aria-labelledby="settings-modal-title"');
    expect(panel).toContain("tabIndex={-1}");
    expect(panel).toContain("max-w-lg");
  });

  it("the Settings heading carries the id the panel points at", () => {
    expect(SRC).toContain('<h2 id="settings-modal-title"');
    expect(anchorIndex(SRC, '<h2 id="settings-modal-title"')).toBeGreaterThan(anchorIndex(SRC, "ref={panelRef}"));
  });

  it("calls the shared focus hook with the open state", () => {
    expect(SRC).toContain("useModalFocus(open, panelRef)");
  });

  it("keeps its own Escape handler, portal and backdrop click", () => {
    expect(SRC).toContain('if (e.key === "Escape") setOpen(false);');
    expect(SRC).toContain("createPortal(");
    expect(SRC).toContain("if (e.target === e.currentTarget) setOpen(false);");
  });
});
