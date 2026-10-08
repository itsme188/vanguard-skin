"use client";

/**
 * Recovery row for a draft the ambient-notes overlay left behind.
 *
 * The overlay (NotesAmbient.tsx) is keyboard-only (Cmd+;), so on a phone a
 * draft it stored in localStorage could never be reached again. This row,
 * shown on the Notes page at every width, reads that draft and offers two
 * things: put it in the composer, or discard it.
 *
 * Rules:
 *   - It never saves anything. "Open in editor" only fills the composer; the
 *     note is created when the owner presses Save Note there.
 *   - It never removes the stored draft on its own. The draft leaves storage
 *     only through Discard (after a confirmation) or once a saved note
 *     carries the whole draft text (`clearAmbientDraftIfSaved`).
 *   - The draft is the owner's private writing: it is rendered inside the
 *     PrivateText wrapper and is never logged.
 */

import { useState, useSyncExternalStore } from "react";
import { PrivateText } from "@/lib/privacy/components";
import { ConfirmDialog } from "./ConfirmDialog";
import { AMBIENT_NOTES_STORAGE_KEY } from "./NotesAmbient";

// The key NotesAmbient.tsx writes, imported from it so the two cannot drift.
// The stored value is the draft's plain text (no wrapper object, no date).
export { AMBIENT_NOTES_STORAGE_KEY };

type DraftStorage = Pick<Storage, "getItem" | "removeItem">;

/** The browser's localStorage, or null on the server / when access throws. */
function browserStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The stored draft, or null when there is none or storage is blocked. */
export function readAmbientDraft(storage: DraftStorage | null = browserStorage()): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(AMBIENT_NOTES_STORAGE_KEY);
    return raw != null && raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Remove the stored draft. False when storage is blocked. */
export function removeAmbientDraft(storage: DraftStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(AMBIENT_NOTES_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * The composer text after "Open in editor". Text already in the composer is
 * kept and the draft goes after it; a draft that is already there is not
 * pasted a second time.
 */
export function mergeDraftIntoComposer(existing: string, draft: string): string {
  if (existing.trim().length === 0) return draft;
  if (existing.includes(draft.trim())) return existing;
  return `${existing}\n\n${draft}`;
}

/** True when a saved note carries the whole draft text. */
export function draftCoveredBySave(draft: string, savedContent: string): boolean {
  const text = draft.trim();
  return text.length > 0 && savedContent.includes(text);
}

/**
 * Called by the composer after the server confirmed a save. Removes the
 * stored draft only when the saved note carries all of it, so a draft the
 * owner rewrote before saving stays until they discard it themselves.
 */
export function clearAmbientDraftIfSaved(
  savedContent: string,
  storage: DraftStorage | null = browserStorage(),
): boolean {
  const draft = readAmbientDraft(storage);
  if (draft == null || !draftCoveredBySave(draft, savedContent)) return false;
  const removed = removeAmbientDraft(storage);
  if (removed) notifyDraftChanged();
  return removed;
}

const PREVIEW_MAX = 160;

/** First part of the draft for the row; the full text is in the editor. */
export function draftPreview(draft: string): string {
  const text = draft.trim();
  return text.length <= PREVIEW_MAX ? text : `${text.slice(0, PREVIEW_MAX).trimEnd()}…`;
}

// ─── Storage as an external store ────────────────────────────────
// The row's only state is what is in storage, so it disappears by itself when
// the draft is saved, discarded, or cleared in another tab. The server
// snapshot is null: nothing is rendered until the browser has read storage,
// so there is no hydration mismatch.

const listeners = new Set<() => void>();

function notifyDraftChanged(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function getSnapshot(): string | null {
  return readAmbientDraft();
}

function getServerSnapshot(): string | null {
  return null;
}

const ROW_BUTTON =
  "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors focus-ring pointer-coarse:min-h-11";

export function NotesDraftRecovery({
  onOpenInEditor,
}: {
  /** Fill the composer with the draft. Must not save. */
  onOpenInEditor: (text: string) => void;
}) {
  const draft = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [opened, setOpened] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [discardFailed, setDiscardFailed] = useState(false);

  if (draft == null) return null;

  function handleOpen() {
    // Read again at the press: the stored draft is the source of truth.
    const current = readAmbientDraft();
    if (current == null) {
      notifyDraftChanged();
      return;
    }
    onOpenInEditor(current);
    setOpened(true);
  }

  function handleDiscard() {
    setConfirmingDiscard(false);
    if (removeAmbientDraft()) {
      setDiscardFailed(false);
      notifyDraftChanged();
    } else {
      setDiscardFailed(true);
    }
  }

  return (
    <section
      aria-label="Unsaved note draft"
      className="bg-panel border border-edge rounded-xl p-4 space-y-2"
    >
      <p className="text-sm font-medium text-ink">You have an unsaved note draft</p>
      <p className="text-sm text-ink-dim line-clamp-2 break-words">
        <PrivateText>{draftPreview(draft)}</PrivateText>
      </p>
      {opened && (
        <p className="text-xs text-ink-dim">
          The draft is in the editor below. It is not saved until you press Save Note, and it
          stays here until you save it unchanged or discard it.
        </p>
      )}
      {discardFailed && (
        <p className="text-xs text-down">
          The draft could not be removed because this browser is blocking storage. Nothing was
          changed.
        </p>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={handleOpen}
          className={`${ROW_BUTTON} bg-gold/20 text-gold-ink hover:brightness-110`}
        >
          Open in editor
        </button>
        <button
          type="button"
          onClick={() => setConfirmingDiscard(true)}
          className={`${ROW_BUTTON} text-ink-dim hover:text-ink hover:bg-raised`}
        >
          Discard
        </button>
      </div>
      <ConfirmDialog
        open={confirmingDiscard}
        title="Discard this draft?"
        message="The unsaved draft is removed from this device. This can't be undone."
        confirmLabel="Discard"
        variant="danger"
        onConfirm={handleDiscard}
        onCancel={() => setConfirmingDiscard(false)}
      />
    </section>
  );
}
