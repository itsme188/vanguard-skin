/**
 * The ambient-notes overlay and the Notes-page recovery row share one stored
 * draft. Two defects this file pins:
 *
 *   1. The overlay read storage once, at mount. After the recovery row
 *      discarded (or the composer saved) the draft, the overlay still held
 *      the old text and stored it again on the next keystroke.
 *   2. The overlay's debounce ran at mount and wrote back the very text it
 *      had just read, so a Discard inside the debounce window was undone.
 *
 * No DOM harness in this repo: the two decisions are pure functions tested
 * directly, and their wiring is pinned in source with `anchorIndex`, which
 * throws when an anchor vanishes.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import {
  AMBIENT_NOTES_STORAGE_KEY,
  shouldPersistDraft,
  draftToShowOnOpen,
} from "@/app/dashboard/components/NotesAmbient";
import { AMBIENT_NOTES_STORAGE_KEY as ROW_KEY } from "@/app/dashboard/components/NotesDraftRecovery";

const src = readFileSync("app/dashboard/components/NotesAmbient.tsx", "utf8");
const rowSrc = readFileSync("app/dashboard/components/NotesDraftRecovery.tsx", "utf8");

describe("one storage key, owned by the overlay", () => {
  it("the overlay exports it and the recovery row imports it", () => {
    expect(AMBIENT_NOTES_STORAGE_KEY).toBe("vgs:notes-ambient");
    expect(ROW_KEY).toBe(AMBIENT_NOTES_STORAGE_KEY);
    anchorIndex(src, "export const AMBIENT_NOTES_STORAGE_KEY =");
    expect(rowSrc).toMatch(/import \{ AMBIENT_NOTES_STORAGE_KEY \} from "\.\/NotesAmbient"/);
    expect(rowSrc).not.toContain('"vgs:notes-ambient"');
  });
});

describe("shouldPersistDraft — never write back what storage already holds", () => {
  it("the text read at mount is not written again (a Discard in the debounce window stays discarded)", () => {
    expect(shouldPersistDraft("old draft", "old draft")).toBe(false);
    expect(shouldPersistDraft("", "")).toBe(false);
  });

  it("an edit is written", () => {
    expect(shouldPersistDraft("old draft!", "old draft")).toBe(true);
    expect(shouldPersistDraft("", "old draft")).toBe(true);
    expect(shouldPersistDraft("new", "")).toBe(true);
  });
});

describe("draftToShowOnOpen — the overlay follows storage when it has nothing unsaved", () => {
  it("a draft discarded elsewhere is gone when the overlay opens", () => {
    expect(draftToShowOnOpen("old draft", "old draft", "")).toBe("");
  });

  it("a draft stored by another tab shows when the overlay opens", () => {
    expect(draftToShowOnOpen("", "", "from another tab")).toBe("from another tab");
  });

  it("an edit not yet written (debounce pending, or the write failed) is kept", () => {
    expect(draftToShowOnOpen("old draft plus more", "old draft", "old draft")).toBe("old draft plus more");
    expect(draftToShowOnOpen("typed in private mode", "", "")).toBe("typed in private mode");
  });

  it("unreadable storage keeps what the overlay holds", () => {
    expect(draftToShowOnOpen("old draft", "old draft", null)).toBe("old draft");
  });
});

describe("overlay wiring (source pins)", () => {
  it("the debounce effect asks shouldPersistDraft before it arms the timer", () => {
    const effect = sliceBetween(src, "// Debounced persist.", "}, [draft]);");
    const gate = anchorIndex(effect, "if (!shouldPersistDraft(draft, lastStored.current)) return;");
    expect(gate).toBeLessThan(anchorIndex(effect, "setTimeout("));
  });

  it("a successful write records what storage now holds", () => {
    const effect = sliceBetween(src, "// Debounced persist.", "}, [draft]);");
    const write = anchorIndex(effect, "localStorage.setItem(AMBIENT_NOTES_STORAGE_KEY, draft)");
    const record = anchorIndex(effect, "lastStored.current = draft;");
    expect(record).toBeGreaterThan(write);
    expect(record).toBeLessThan(anchorIndex(effect, "} catch"));
  });

  it("opening re-reads storage, before the toggle flips", () => {
    const handler = sliceBetween(src, "const onKeyDown = (e: KeyboardEvent) => {", 'if (e.key === "Escape"');
    const closedBranch = anchorIndex(handler, "if (!open) {");
    const read = anchorIndex(handler, "readStoredDraft()", closedBranch);
    const adopt = anchorIndex(handler, "draftToShowOnOpen(", closedBranch);
    const flip = anchorIndex(handler, "setOpen((o) => !o)");
    expect(read).toBeLessThan(flip);
    expect(adopt).toBeLessThan(flip);
    // The handler must see the current draft, not the one from mount.
    expect(src).toContain("}, [open, draft]);");
  });

  it("Clear and Save to Notes record the empty storage only when the removal worked", () => {
    for (const name of ["const handleSaveToNotes = useCallback", "const handleClear = useCallback"]) {
      const at = anchorIndex(src, name);
      const remove = anchorIndex(src, "localStorage.removeItem(AMBIENT_NOTES_STORAGE_KEY);", at);
      const record = anchorIndex(src, 'lastStored.current = "";', remove);
      expect(record).toBeLessThan(anchorIndex(src, "} catch", remove));
    }
  });
});
