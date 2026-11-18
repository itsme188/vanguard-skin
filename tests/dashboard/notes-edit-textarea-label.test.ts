/**
 * The note edit box is named for the note it edits, so it is not announced
 * with the same name as the new-note composer's box.
 *
 * No DOM harness: pinned by source (anchors throw when they vanish).
 *
 * [qa:dashboard-research-view-notes-note-edit-form-note-edit-textarea-shares-the-composer-s-note-text-name-nothing-s]
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

const src = readFileSync("app/dashboard/components/NotesView.tsx", "utf8");

describe("note text box accessible name", () => {
  it("the shared form's textarea takes its name from the textLabel prop", () => {
    const start = anchorIndex(src, "<textarea", 0, "form textarea");
    const tag = src.slice(start, anchorIndex(src, "onChange", start, "textarea onChange"));
    expect(tag).toContain("aria-label={textLabel}");
    expect(tag).not.toContain('aria-label="Note text"');
  });

  it('textLabel is optional and defaults to "Note text"', () => {
    expect(src).toContain('textLabel = "Note text"');
    expect(src).toContain("textLabel?: string;");
  });

  it("the edit call site names the box for its note with cardLabel", () => {
    const edit = anchorIndex(src, "keepSecurity={{ id: note.security_id", 0, "edit call site");
    const end = anchorIndex(src, "/>", edit, "end of call");
    expect(src.slice(edit, end)).toContain("textLabel={`Edit note text: ${cardLabel}`}");
  });
});
