"use client";

/**
 * Shared load/save state for the SQLite-backed preference controls.
 *
 * Each control (printing, ignored symbols, position limits) owns its own copy
 * of this hook and sends only its own fields, which the route accepts as a
 * subset. A failed save leaves the on-screen values as the server last
 * confirmed them and says what happened — it never pretends a change landed.
 */

import { useCallback, useEffect, useState } from "react";
import {
  loadPreferences,
  patchPreferences,
  type AppPreferences,
  type PreferencesPatch,
} from "./preferences-client";

export interface PreferencesState {
  /** Null until the first read finishes, or while it failed. */
  prefs: AppPreferences | null;
  /** A load or save failure, in plain words. */
  message: string | null;
  saving: boolean;
  /** True after a save the server confirmed; cleared by the next save, a failure, or `clearSaved`. */
  saved: boolean;
  /** Dismisses the saved note, for when the owner edits a field again. */
  clearSaved: () => void;
  /** Sends a subset; `action` completes "Couldn't <action>: …". */
  save: (updates: PreferencesPatch, action: string) => Promise<boolean>;
}

export function usePreferences(): PreferencesState {
  const [prefs, setPrefs] = useState<AppPreferences | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    loadPreferences(controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (result.ok) setPrefs(result.prefs);
        else setMessage(result.message);
      },
      () => {
        // The load helper already turns a transport failure into a sentence;
        // this arm only runs when the request was aborted on unmount.
      },
    );
    return () => controller.abort();
  }, []);

  const save = useCallback(async (updates: PreferencesPatch, action: string) => {
    setSaving(true);
    setMessage(null);
    setSaved(false);
    const result = await patchPreferences(updates, action);
    setSaving(false);
    if (!result.ok) {
      setMessage(result.message);
      return false;
    }
    setPrefs(result.prefs);
    setSaved(true);
    return true;
  }, []);

  const clearSaved = useCallback(() => setSaved(false), []);

  return { prefs, message, saving, saved, clearSaved, save };
}
