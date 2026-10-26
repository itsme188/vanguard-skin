/**
 * Notes view: every note card's Edit / Delete control and its delete
 * question name the note (type, symbol, date), so thirty cards do not read
 * as one control and the question says which note goes.
 *
 * No DOM harness in this repo: the pure helper is tested directly and the
 * wiring is pinned by source (anchors throw when they vanish).
 *
 * [qa:dashboard-research-view-notes-note-cards-32-note-edit-delete-buttons-share-one-name-the-delete-dialog-never-na]
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { noteCardLabel } from "@/app/dashboard/components/NotesView";
import { anchorIndex } from "../helpers/source-anchor";

describe("noteCardLabel", () => {
  it("names the type, the symbol and the date", () => {
    expect(noteCardLabel({ note_type: "journal", symbol: "AAA", event_date: "2026-10-12" })).toBe(
      "Journal on AAA, Oct 12, 2026",
    );
  });

  it("leaves the symbol out when the note has none", () => {
    expect(noteCardLabel({ note_type: "journal", symbol: null, event_date: "2026-01-05" })).toBe(
      "Journal, Jan 5, 2026",
    );
    expect(noteCardLabel({ note_type: "journal", symbol: "  ", event_date: "2026-01-05" })).toBe(
      "Journal, Jan 5, 2026",
    );
    expect(noteCardLabel({ note_type: "journal", event_date: "2026-01-05" })).toBe("Journal, Jan 5, 2026");
  });

  it("uses the display label of the type, never the raw token", () => {
    const label = noteCardLabel({ note_type: "trade_thesis", symbol: "ZZZ", event_date: "2026-03-31" });
    expect(label).not.toContain("trade_thesis");
    expect(label).toMatch(/ on ZZZ, Mar 31, 2026$/);
  });

  it("two notes of one type on one day differ by symbol", () => {
    const a = noteCardLabel({ note_type: "journal", symbol: "AAA", event_date: "2026-10-12" });
    const b = noteCardLabel({ note_type: "journal", symbol: "ZZZ", event_date: "2026-10-12" });
    expect(a).not.toBe(b);
  });
});

describe("NotesView note card wiring (source pin)", () => {
  const src = readFileSync("app/dashboard/components/NotesView.tsx", "utf8");
  const card = src.slice(anchorIndex(src, "function NoteCard("));

  it("computes one label per card from the note", () => {
    expect(card).toContain("const cardLabel = noteCardLabel(note);");
  });

  it("the Edit and Delete controls carry the note's name, not a bare verb", () => {
    expect(card).toContain("aria-label={`Edit note: ${cardLabel}`}");
    expect(card).toContain("title={`Edit note: ${cardLabel}`}");
    expect(card).toContain("aria-label={`Delete note: ${cardLabel}`}");
    expect(card).toContain("title={`Delete note: ${cardLabel}`}");
    expect(card).not.toContain('aria-label="Edit note"');
    expect(card).not.toContain('aria-label="Delete note"');
  });

  it("the delete question names the note", () => {
    expect(card).toContain('message={`Delete the note "${cardLabel}"? This cannot be undone.`}');
    expect(card).not.toContain("Are you sure you want to delete this note?");
  });
});
