/**
 * Source-pin tests for the Reconciliation checkpoints panel (no DOM harness
 * in this repo; see tests/dashboard/reconciliation-table-scrollfade.test.ts).
 *
 * - accounts-reconciliation--duplicate-date-checkpoint-silently-replaces:
 *   the replace id is sent only from the confirm dialog's Replace button.
 * - accounts-recon-checkpoints--note-truncated-150px-no-tooltip-regression-1
 * - accounts-recon-checkpoints--difference-chip-prefix-symbols-no-legend
 * - accounts-reconciliation--save-checkpoint-misleading-disabled-tooltip-regression-1
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const source = readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ReconciliationTable.tsx"),
  "utf8",
);

describe("ReconciliationTable replace prompt", () => {
  it("the form submit never sends a replace id", () => {
    const start = anchorIndex(source, "function handleSubmit(");
    const end = anchorIndex(source, "async function saveCheckpoint(", start);
    const body = source.slice(start, end);
    expect(body).toContain("saveCheckpoint()");
    expect(body).not.toContain("replaceTarget");
  });

  it("only the confirm dialog's onConfirm passes the saved checkpoint's id", () => {
    const calls = [...source.matchAll(/saveCheckpoint\(([^)]*)\)/g)]
      .map((m) => m[1].trim())
      .filter((arg) => !arg.startsWith("replaceCheckpointId?"));
    expect(calls.sort()).toEqual(["", "replaceTarget.id"]);
    const confirmIdx = anchorIndex(source, "saveCheckpoint(replaceTarget.id)");
    expect(source.lastIndexOf("onConfirm={", confirmIdx)).toBeGreaterThan(
      source.lastIndexOf("onCancel={", confirmIdx),
    );
  });

  it("the replace target is set only from a parsed 409 conflict", () => {
    const sets = [...source.matchAll(/setReplaceTarget\(([^)]*)\)/g)].map((m) => m[1]);
    expect(sets.filter((a) => a !== "null")).toEqual(["conflict"]);
    expect(source).toContain("res.status === 409");
    expect(source).toContain("parseCheckpointConflict(");
  });

  it("the dialog says nothing changed yet, what is lost, and shows the saved value and note", () => {
    const start = anchorIndex(source, 'title="Replace the saved checkpoint?"');
    const dialog = source.slice(start, anchorIndex(source, "</ConfirmDialog>", start));
    expect(dialog).toContain("Nothing has been changed yet");
    expect(dialog).toContain("overwrites its statement value and its note");
    expect(dialog).toContain("<Money value={replaceTarget.statement_value}");
    expect(dialog).toContain("replaceTarget.notes");
  });
});

describe("ReconciliationTable Save button", () => {
  it("no longer hardcodes the 'Fill in all required fields' tooltip", () => {
    expect(source).not.toContain("Fill in all required fields");
    expect(source).toContain("title={formBlocker ?? undefined}");
  });

  it("shows the blocker on screen, not only on hover", () => {
    expect(source).toMatch(/<p id="recon-save-blocker"[^>]*>\s*\{formBlocker\}/);
  });
});

describe("ReconciliationTable Notes cell", () => {
  const start = anchorIndex(source, "title={cp.notes ?? undefined}");
  const cell = source.slice(source.lastIndexOf("<td", start), anchorIndex(source, "</td>", start));

  it("wraps instead of truncating and carries the full note as a title", () => {
    expect(cell).not.toMatch(/\btruncate\b/);
    expect(cell).toContain("whitespace-normal");
    expect(cell).toContain("break-words");
  });
});

describe("ReconciliationTable Difference chip", () => {
  it("carries the band meaning as a title and as screen-reader text", () => {
    expect(source).toContain("title={band.label}");
    expect(source).toMatch(/<span className="sr-only">\{band\.label\}/);
  });

  it("renders a visible legend for the three glyphs", () => {
    expect(source).toContain("{CHECKPOINT_DIFFERENCE_LEGEND}");
  });
});
