"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import apiFetch from "@/lib/http/apiFetch";

const STORAGE_KEY = "vgs:notes-ambient";
const SAVE_DEBOUNCE_MS = 400;

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Ambient notes overlay — fixed bottom-right panel toggled by Cmd+;.
 * Drafts persist to localStorage on every keystroke (debounced) so tab
 * changes never lose state. Click "Save to Notes" to materialize the draft
 * as a real `journal` note in the DB; the draft clears after a successful
 * save. Close button / Escape hides the panel without touching the draft.
 */
export function NotesAmbient() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  // Hydrate from localStorage on mount.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setDraft(stored);
    } catch {
      // localStorage unavailable (private browsing) — ambient mode degrades
      // gracefully to in-memory state for this session.
    }
  }, []);

  // Debounced persist. Each keystroke resets the timer; we write once the
  // user pauses for SAVE_DEBOUNCE_MS. Avoids hammering localStorage on every
  // letter while still feeling instant.
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        if (draft.length === 0) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, draft);
      } catch {
        // ignore
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [draft]);

  // Cmd+; / Ctrl+; toggles. Escape closes when open. We attach a single
  // window-level listener so any tab/page can summon the overlay.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isToggle = (e.metaKey || e.ctrlKey) && e.key === ";";
      if (isToggle) {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Auto-focus the textarea when the panel opens.
  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  const handleSaveToNotes = useCallback(async () => {
    const content = draft.trim();
    if (!content) return;
    setSaveState("saving");
    setErrorMsg(null);
    try {
      const res = await apiFetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note_type: "journal", content }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Save failed (${res.status})`);
      }
      // Clear the draft locally + in storage on a successful materialization.
      setDraft("");
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1800);
      // Server components on the current route (e.g. the Notes list on
      // /dashboard/research?view=notes) show the note without a manual reload.
      router.refresh();
    } catch (err) {
      setSaveState("error");
      setErrorMsg(err instanceof Error ? err.message : "Save failed");
    }
  }, [draft, router]);

  const handleClear = useCallback(() => {
    if (draft && !confirm("Clear this draft? This can't be undone.")) return;
    setDraft("");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, [draft]);

  // Closed: render nothing. QA ruling (2026-09-04, closes an 8-entry finding
  // family): a fixed floating action button here sat over row controls on
  // every dense surface (Today, Accounts, Import, Alerts, Research Notes —
  // desktop and mobile alike), so the FAB is gone entirely. The overlay
  // stays reachable via Cmd+;/Ctrl+; (below); on mobile, notes themselves
  // are reached through the bottom-nav "Notes" entry (MobileBottomNav.tsx,
  // the Notes page at /dashboard/research?view=notes) — the overlay is
  // keyboard-only there by ruling. The unsaved-draft dot reminder that
  // used to live on the FAB is intentionally gone with it — draft state is
  // still persisted to localStorage either way.
  if (!open) {
    return null;
  }

  return (
    <div
      // Mirrors the FAB offset — tracks --chat-rail-width so the panel sits
      // beside the rail when open and at the corner when it's collapsed.
      className="fixed z-[60] bottom-20 right-4 md:bottom-6 md:right-6 xl:right-[calc(var(--chat-rail-width)_+_1.5rem)] w-[min(380px,calc(100vw-2rem))] rounded-xl border border-edge bg-panel shadow-xl"
      role="dialog"
      aria-label="Ambient notes"
    >
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-edge">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-ink-faint">
            Notes
          </span>
          <span className="text-[10px] text-ink-faint font-mono">
            {draft.length > 0 ? `${draft.length} chars` : "empty"}
          </span>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="text-ink-faint hover:text-ink transition-colors"
          aria-label="Close ambient notes"
          title="Close (Esc)"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Drop a thought… auto-saved as you type. Click Save to Notes to keep it."
        rows={6}
        className="w-full resize-none bg-transparent px-4 py-3 text-sm leading-[1.6] text-ink placeholder:text-ink-faint focus:outline-none"
      />

      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-edge">
        <span className="text-[11px] text-ink-faint">
          {saveState === "saving" && "Saving…"}
          {saveState === "saved" && "Saved to Notes"}
          {saveState === "error" && (errorMsg || "Save failed")}
          {saveState === "idle" && (
            /* Keyboard hints — meaningless on touch, hidden there */
            <span className="text-ink-faint pointer-coarse:hidden">
              <kbd className="px-1.5 py-0.5 rounded bg-raised border border-edge text-[10px] font-mono">⌘;</kbd>
              {" toggle · "}
              <kbd className="px-1.5 py-0.5 rounded bg-raised border border-edge text-[10px] font-mono">Esc</kbd>
              {" close"}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleClear}
            disabled={!draft || saveState === "saving"}
            className="px-2.5 py-1 rounded-md text-xs text-ink-dim hover:text-ink hover:bg-raised transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Clear
          </button>
          <button
            onClick={handleSaveToNotes}
            disabled={!draft.trim() || saveState === "saving"}
            className="px-3 py-1 rounded-md text-xs font-medium bg-gold text-canvas hover:brightness-110 transition-[filter,scale] active:scale-[0.96] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save to Notes
          </button>
        </div>
      </div>
    </div>
  );
}
