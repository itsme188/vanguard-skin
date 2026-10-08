import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = fs.readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ManageSourcesModal.tsx"),
  "utf8"
);

describe("ManageSourcesModal accessibility and copy (B32)", () => {
  it("sender email cells carry the full address as a title", () => {
    expect(src).toContain("title={s.sender_email}");
    expect(src).toContain("title={sender.email}");
  });

  it("the active switch is labelled and exposes its state", () => {
    const at = anchorIndex(src, "onClick={() => handleToggle(s.id, s.is_active)}");
    const chunk = src.slice(at, at + 700);
    expect(chunk).toContain("aria-pressed={Boolean(s.is_active)}");
    expect(chunk).toContain("click to deactivate");
    expect(chunk).toContain("click to activate");
    expect(chunk).toMatch(/title=\{/);
  });

  it("the off-topic chip says blocked when the exemption is off", () => {
    expect(src).toContain('"off-topic OK" : "off-topic blocked"');
  });

  it("the delete icon has a touch extension and an accessible name", () => {
    const at = anchorIndex(src, "onClick={() => setPendingDeleteId(s.id)}");
    const chunk = src.slice(at, at + 900);
    expect(chunk).toContain("pointer-coarse:after:-inset-2");
    expect(chunk).toContain("aria-label={");
  });

  it("the delete confirmation names the source", () => {
    expect(src).toContain("pendingDeleteLabel");
    expect(src).toContain('Delete "${pendingDeleteSource.name}"?');
    expect(src).not.toContain("remove this newsletter source?");
  });

  it("the panel is a modal dialog that takes focus, traps Tab and restores focus", () => {
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain("panelRef.current?.focus()");
    expect(src).toContain('e.key !== "Tab"');
    expect(src).toContain("opener?.focus?.()");
  });
});
