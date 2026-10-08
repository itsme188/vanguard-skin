/**
 * Notes draft recovery on a phone (backlog unit U28).
 *
 * The ambient-notes overlay is keyboard-only (Cmd+;), so a draft it left in
 * localStorage on a phone could never be reached. The Notes page now shows a
 * recovery row that reads that draft.
 *
 * No DOM harness in this repo: the behaviour is tested through the pure
 * functions the row calls (with a fake storage), plus source pins located
 * with `anchorIndex`, which throws when an anchor vanishes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  AMBIENT_NOTES_STORAGE_KEY,
  readAmbientDraft,
  removeAmbientDraft,
  mergeDraftIntoComposer,
  draftCoveredBySave,
  clearAmbientDraftIfSaved,
  draftPreview,
} from "@/app/dashboard/components/NotesDraftRecovery";
import { noteDraftBlocker, EARNINGS_NOTE_NEEDS_SECURITY } from "@/app/dashboard/components/NotesView";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const rowSrc = readFileSync("app/dashboard/components/NotesDraftRecovery.tsx", "utf8");
const viewSrc = readFileSync("app/dashboard/components/NotesView.tsx", "utf8");
const ambientSrc = readFileSync("app/dashboard/components/NotesAmbient.tsx", "utf8");

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
}

const blockedStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("storage key — one literal, shared with the overlay", () => {
  it("is the exact key NotesAmbient writes", () => {
    // NotesAmbient exports its key and the recovery row imports it, so the
    // two cannot drift.
    anchorIndex(ambientSrc, `export const AMBIENT_NOTES_STORAGE_KEY = "${AMBIENT_NOTES_STORAGE_KEY}";`);
    anchorIndex(rowSrc, 'import { AMBIENT_NOTES_STORAGE_KEY } from "./NotesAmbient";');
  });

  it("the row file never spells the literal itself", () => {
    expect(rowSrc.split(`"${AMBIENT_NOTES_STORAGE_KEY}"`).length - 1).toBe(0);
  });

  it("the overlay still stores the draft as the plain text (no wrapper, no date)", () => {
    anchorIndex(ambientSrc, "localStorage.setItem(AMBIENT_NOTES_STORAGE_KEY, draft)");
  });
});

describe("readAmbientDraft", () => {
  it("returns the stored draft", () => {
    const s = fakeStorage({ [AMBIENT_NOTES_STORAGE_KEY]: "Margins held up.\nCheck guidance." });
    expect(readAmbientDraft(s)).toBe("Margins held up.\nCheck guidance.");
  });

  it("nothing stored, an empty string or only whitespace is no draft", () => {
    expect(readAmbientDraft(fakeStorage())).toBeNull();
    expect(readAmbientDraft(fakeStorage({ [AMBIENT_NOTES_STORAGE_KEY]: "" }))).toBeNull();
    expect(readAmbientDraft(fakeStorage({ [AMBIENT_NOTES_STORAGE_KEY]: "  \n " }))).toBeNull();
  });

  it("blocked or missing storage is no draft, never a throw", () => {
    expect(readAmbientDraft(blockedStorage)).toBeNull();
    expect(readAmbientDraft(null)).toBeNull();
  });

  it("reading never removes or changes the draft", () => {
    const s = fakeStorage({ [AMBIENT_NOTES_STORAGE_KEY]: "keep me" });
    readAmbientDraft(s);
    readAmbientDraft(s);
    expect(s.data.get(AMBIENT_NOTES_STORAGE_KEY)).toBe("keep me");
  });
});

describe("removeAmbientDraft", () => {
  it("removes only the draft key and reports success", () => {
    const s = fakeStorage({ [AMBIENT_NOTES_STORAGE_KEY]: "x", other: "y" });
    expect(removeAmbientDraft(s)).toBe(true);
    expect(s.data.has(AMBIENT_NOTES_STORAGE_KEY)).toBe(false);
    expect(s.data.get("other")).toBe("y");
  });

  it("blocked storage reports failure instead of throwing", () => {
    expect(removeAmbientDraft(blockedStorage)).toBe(false);
    expect(removeAmbientDraft(null)).toBe(false);
  });
});

describe("mergeDraftIntoComposer — Open in editor never loses text", () => {
  it("an empty composer takes the draft as is", () => {
    expect(mergeDraftIntoComposer("", "draft text")).toBe("draft text");
    expect(mergeDraftIntoComposer("   ", "draft text")).toBe("draft text");
  });

  it("text already in the composer is kept, the draft goes after it", () => {
    expect(mergeDraftIntoComposer("half a thought", "draft text")).toBe("half a thought\n\ndraft text");
  });

  it("pressing the button twice does not paste the draft twice", () => {
    const once = mergeDraftIntoComposer("half a thought", "draft text");
    expect(mergeDraftIntoComposer(once, "draft text")).toBe(once);
    expect(mergeDraftIntoComposer("draft text", "draft text")).toBe("draft text");
  });
});

describe("draftCoveredBySave / clearAmbientDraftIfSaved — the row goes once the draft is saved", () => {
  it("a saved note that carries the whole draft covers it", () => {
    expect(draftCoveredBySave("draft text", "draft text")).toBe(true);
    expect(draftCoveredBySave("  draft text \n", "draft text")).toBe(true);
    expect(draftCoveredBySave("draft text", "intro\n\ndraft text\n\nmore")).toBe(true);
  });

  it("a different or partial note does not", () => {
    expect(draftCoveredBySave("draft text", "something else")).toBe(false);
    expect(draftCoveredBySave("draft text and more", "draft text")).toBe(false);
    expect(draftCoveredBySave("", "anything")).toBe(false);
    expect(draftCoveredBySave("   ", "anything")).toBe(false);
  });

  it("saving the draft removes it from storage", () => {
    const s = fakeStorage({ [AMBIENT_NOTES_STORAGE_KEY]: "draft text" });
    expect(clearAmbientDraftIfSaved("draft text", s)).toBe(true);
    expect(s.data.has(AMBIENT_NOTES_STORAGE_KEY)).toBe(false);
  });

  it("saving an unrelated note leaves the draft where it is", () => {
    const s = fakeStorage({ [AMBIENT_NOTES_STORAGE_KEY]: "draft text" });
    expect(clearAmbientDraftIfSaved("a different note", s)).toBe(false);
    expect(s.data.get(AMBIENT_NOTES_STORAGE_KEY)).toBe("draft text");
  });

  it("a draft the owner rewrote before saving is NOT removed (only Discard may drop unsaved words)", () => {
    const s = fakeStorage({ [AMBIENT_NOTES_STORAGE_KEY]: "draft text with a typo" });
    expect(clearAmbientDraftIfSaved("draft text, typo fixed", s)).toBe(false);
    expect(s.data.get(AMBIENT_NOTES_STORAGE_KEY)).toBe("draft text with a typo");
  });

  it("blocked storage is a quiet no", () => {
    expect(clearAmbientDraftIfSaved("draft text", blockedStorage)).toBe(false);
  });
});

describe("draftPreview", () => {
  it("short drafts show whole, long ones are cut with an ellipsis", () => {
    expect(draftPreview("short")).toBe("short");
    const long = "word ".repeat(100);
    const p = draftPreview(long);
    expect(p.length).toBeLessThanOrEqual(161);
    expect(p.endsWith("…")).toBe(true);
  });
});

describe("the recovery row (source pins)", () => {
  it("renders the draft only inside <PrivateText>", () => {
    const start = anchorIndex(rowSrc, "<PrivateText>");
    const end = anchorIndex(rowSrc, "</PrivateText>", start);
    expect(rowSrc.slice(start, end)).toContain("draftPreview(draft)");
    // The draft text reaches markup nowhere else.
    expect(rowSrc.split("draftPreview(draft)").length - 1).toBe(1);
    // A bare JSX {draft} (a template-string ${draft} in a pure helper is fine).
    expect(rowSrc).not.toMatch(/(?<!\$)\{draft\}/);
  });

  it("never logs", () => {
    expect(rowSrc).not.toMatch(/console\./);
  });

  it("storage is removed in one function only, and reading sits in a try/catch", () => {
    expect(rowSrc.split(".removeItem(").length - 1).toBe(1);
    expect(rowSrc.split(".getItem(").length - 1).toBe(1);
    const read = sliceBetween(rowSrc, "export function readAmbientDraft", "export function removeAmbientDraft");
    expect(read).toContain("try {");
    expect(read).toContain("catch");
    expect(rowSrc).not.toContain(".setItem(");
  });

  it("Discard asks first: the removal runs from the confirm dialog, not the button", () => {
    const dialog = rowSrc.slice(anchorIndex(rowSrc, "<ConfirmDialog"));
    expect(dialog).toContain("onConfirm={handleDiscard}");
    const button = sliceBetween(rowSrc, "setConfirmingDiscard(true)", "Discard\n");
    expect(button).not.toContain("handleDiscard");
  });

  it("Open in editor hands the text to the composer and removes nothing", () => {
    const open = sliceBetween(rowSrc, "function handleOpen()", "function handleDiscard()");
    expect(open).toContain("onOpenInEditor(");
    expect(open).not.toContain("removeAmbientDraft");
  });

  it("the server render and a blocked browser both show nothing", () => {
    anchorIndex(rowSrc, "getServerSnapshot");
    anchorIndex(rowSrc, "if (draft == null) return null;");
  });
});

describe("NotesView wiring (source pins)", () => {
  it("renders the row above the composer", () => {
    const row = anchorIndex(viewSrc, "<NotesDraftRecovery");
    const form = anchorIndex(viewSrc, "<form onSubmit={handleCreate}");
    expect(row).toBeLessThan(form);
  });

  it("Open in editor fills the composer through mergeDraftIntoComposer and saves nothing", () => {
    const wiring = sliceBetween(viewSrc, "<NotesDraftRecovery", "/>");
    expect(wiring).toContain("setFormContent((prev) => mergeDraftIntoComposer(prev, text))");
    expect(wiring).not.toContain("apiFetch");
    expect(wiring).not.toContain("handleCreate");
  });

  it("the stored draft is cleared only after the server confirmed the save", () => {
    const create = sliceBetween(viewSrc, "async function handleCreate", "// ─── Update note");
    const gate = anchorIndex(create, "if (!res.ok || !data?.success)");
    const clear = anchorIndex(create, "clearAmbientDraftIfSaved(");
    expect(clear).toBeGreaterThan(gate);
    expect(create.split("clearAmbientDraftIfSaved(").length - 1).toBe(1);
  });

  it("a recovered draft filed as an earnings note still needs a security", () => {
    expect(noteDraftBlocker({ type: "earnings", symbol: "" })).toBe(EARNINGS_NOTE_NEEDS_SECURITY);
    const create = sliceBetween(viewSrc, "async function handleCreate", "// ─── Update note");
    expect(anchorIndex(create, "noteDraftBlocker(")).toBeLessThan(anchorIndex(create, "apiFetch("));
  });
});
