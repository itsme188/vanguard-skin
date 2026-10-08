import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

/**
 * Every level row has an Edit control that opens the add form prefilled and
 * saves with PATCH (action "edit") — never by delete-and-re-add, and never
 * through the plain PATCH body (which would reset the row's review status).
 */
describe("LevelsPanel edit control (source pin)", () => {
  const src = readFileSync("app/dashboard/components/LevelsPanel.tsx", "utf8");
  const panel = src.slice(anchorIndex(src, "export function LevelsPanel("));

  it("both row variants offer Edit on every row, with no condition around it", () => {
    expect(panel.split("onClick={() => startEdit(l)}").length - 1).toBe(2);
    expect(panel).not.toMatch(/&&\s*\(\s*<button\s+onClick=\{\(\) => startEdit\(l\)\}/);
  });

  it("Edit prefills every field the form takes", () => {
    const start = sliceBetween(panel, "function startEdit(l: EnrichedLevel)", "function closeEdit()");
    for (const setter of [
      "setEditing(l)",
      "setLevelType(l.level_type)",
      "setPriceSource(l.price_source)",
      "setPrice(",
      "setDirection(",
      "setActionHint(",
      "setSourceAuthor(",
      "setThesis(",
      "setTimeframe(",
      "setExpiresAt(",
      "setAdding(true)",
    ]) {
      expect(start).toContain(setter);
    }
  });

  it("saving PATCHes action edit through the shared result reader, and asks before an arm refusal is overridden", () => {
    const save = sliceBetween(panel, "async function saveLevelEdit(", "async function handleDeactivate(");
    expect(save).toMatch(/method: "PATCH"/);
    expect(save).toMatch(/action: "edit"/);
    expect(save).toMatch(/id: target\.id/);
    expect(save).not.toMatch(/review_status|security_id|is_active/);
    expect(save).toMatch(/readMutationResult\(res\)/);
    expect(save).toMatch(/networkFailureMessage\("save the level"\)/);
    expect(save).toContain("Couldn't save the level");
    expect(save.split("setConfirmPrompt(").length - 1).toBe(2);
    expect(save).toMatch(/onConfirm: \(\) => saveLevelEdit\(target, "would_fire_immediately"\)/);
    expect(save).toMatch(/onConfirm: \(\) => saveLevelEdit\(target, "beyond_scan_range"\)/);
    expect(save.split('onCancel: () => toast("Nothing was saved. The level is unchanged.", "info")').length - 1).toBe(2);
  });

  it("the form submits to the edit handler while a row is being edited", () => {
    const form = sliceBetween(panel, "{adding && (", "<SuggestedLevels");
    expect(form).toMatch(/if \(!editing\) return handleAdd\(e\);/);
    expect(form).toMatch(/return saveLevelEdit\(editing\);/);
    expect(form).toContain('editing ? "Save changes"');
  });
});
