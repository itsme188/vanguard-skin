import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

/**
 * LevelsPanel asks for confirmation through the app's ConfirmDialog, never
 * the browser's native confirm() (unstyled, blocks the page, and suppressed
 * outright in some embedded webviews, where it answers "no" without asking).
 */
describe("LevelsPanel confirmations use ConfirmDialog (source pin)", () => {
  const src = readFileSync("app/dashboard/components/LevelsPanel.tsx", "utf8");

  it("no native confirm() / window.confirm is left", () => {
    expect(src).not.toMatch(/(^|[^.\w])confirm\(/m);
    expect(src).not.toMatch(/window\.confirm/);
  });

  it("renders one ConfirmDialog driven by the pending prompt", () => {
    expect(src).toMatch(/import \{ ConfirmDialog \} from "\.\/ConfirmDialog";/);
    expect(src.split("<ConfirmDialog").length - 1).toBe(1);
    const dialog = src.slice(anchorIndex(src, "<ConfirmDialog"));
    expect(dialog).toMatch(/open=\{confirmPrompt !== null\}/);
    // Both buttons close the dialog before running the stored action.
    expect(dialog.split("setConfirmPrompt(null);").length - 1).toBe(2);
    expect(dialog).toMatch(/prompt\?\.onConfirm\(\);/);
    expect(dialog).toMatch(/prompt\?\.onCancel\?\.\(\);/);
  });

  it("delete asks first and only the confirmed path calls the API", () => {
    const ask = sliceBetween(src, "function handleDelete(id: number)", "async function deleteConfirmedLevel(");
    expect(ask).toMatch(/setConfirmPrompt\(/);
    expect(ask).toContain("Delete this level permanently?");
    expect(ask).toMatch(/variant: "danger"/);
    expect(ask).toMatch(/onConfirm: \(\) => deleteConfirmedLevel\(id\)/);
    expect(ask).not.toMatch(/apiFetch\(/);
    const run = sliceBetween(src, "async function deleteConfirmedLevel(", "async function handleRequeue(");
    expect(run).toMatch(/method: "DELETE"/);
    expect(run).toMatch(/readMutationResult\(res\)/);
    expect(run).toMatch(/networkFailureMessage\("delete the level"\)/);
    expect(src.split('method: "DELETE"').length - 1).toBe(1);
  });

  it("both arm refusals ask through the dialog; declining says the level stays paused", () => {
    const handler = sliceBetween(src, "async function handleReactivate", "function handleDelete(id: number)");
    expect(handler.split("setConfirmPrompt(").length - 1).toBe(2);
    expect(handler.split('onCancel: () => toast("Level left paused", "info")').length - 1).toBe(2);
    expect(handler).toMatch(/onConfirm: \(\) => handleReactivate\(id, "would_fire_immediately"\)/);
    expect(handler).toMatch(/onConfirm: \(\) => handleReactivate\(id, "beyond_scan_range"\)/);
    expect(handler).toMatch(/readMutationResult\(res\)/);
    expect(handler).toMatch(/networkFailureMessage\("reactivate the level"\)/);
  });
});
