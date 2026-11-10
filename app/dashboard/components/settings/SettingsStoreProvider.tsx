"use client";

/**
 * The Settings page's file-store state: load, dirty map, one Save.
 *
 * This is the page-wide half of what the old SettingsModal did. It holds the
 * dirty map for every `AppSettings` field on the page and saves them all in
 * ONE request, so the owner edits a key in the AI group and the port in the
 * Broker group and presses Save once.
 *
 * The mechanism is deliberately unchanged from the modal:
 *  - Electron IPC (`api.getSettings()` / `api.saveSettings(updates)`) when the
 *    packaged app is running;
 *  - `GET` / `POST /api/settings` as the dev fallback.
 * That route answers with the settings OBJECT and not a `{success}` envelope,
 * so `res.ok` is the gate here and the server's own error text is preferred.
 * tests/repo/honest-mutating-handlers.test.ts carries this file with that
 * reason; converting it needs a server change, not a client one.
 *
 * The children are server-rendered: the provider wraps the whole page so the
 * groups can be interleaved with the DB-backed sections in page.tsx.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { CHIP_TONE_CLASSES } from "@/app/dashboard/components/Chip";
import { networkFailureMessage } from "@/lib/ui/mutation-result";
import apiFetch from "@/lib/http/apiFetch";
import { useElectron } from "@/lib/hooks/useElectron";
import { BOOLEAN_FIELD_KEYS, NUMERIC_FIELD_KEYS } from "./settings-fields";

/** Either Electron IPC (packaged app) or the /api/settings dev fallback. */
interface SettingsSource {
  getSettings: () => Promise<Record<string, string | number | boolean>>;
  saveSettings: (updates: Record<string, unknown>) => Promise<unknown>;
}

/** Failure whose message is already user-facing copy (see the source below). */
class SettingsSaveError extends Error {}

interface SettingsStore {
  /** The sanitized values the store handed back (secrets arrive as ***last4). */
  values: Record<string, string | number | boolean>;
  /** Fields the owner has edited but not yet saved, as strings. */
  dirty: Record<string, string>;
  setField: (key: string, value: string) => void;
  /** Non-null when neither channel could be read; the groups stay hidden. */
  unavailableReason: string | null;
}

const StoreContext = createContext<SettingsStore | null>(null);

/** The field groups read the store through this. */
export function useSettingsStore(): SettingsStore {
  const ctx = useContext(StoreContext);
  if (!ctx) {
    throw new Error("useSettingsStore must be used inside <SettingsStoreProvider>");
  }
  return ctx;
}

export function SettingsStoreProvider({ children }: { children: React.ReactNode }) {
  const { isElectron, api } = useElectron();
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [version, setVersion] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

  const source = useMemo<SettingsSource>(() => {
    if (api) {
      return {
        getSettings: () => api.getSettings(),
        saveSettings: (updates) => api.saveSettings(updates),
      };
    }
    return {
      getSettings: async () => {
        const res = await fetch("/api/settings");
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? "Settings API is only available in development mode. Use the packaged Electron app instead."
              : `Settings fetch failed (HTTP ${res.status})`,
          );
        }
        return res.json();
      },
      saveSettings: async (updates) => {
        const res = await apiFetch("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(updates),
        });
        if (!res.ok) {
          // This route answers with the settings object (no success envelope),
          // so res.ok is the gate; prefer the server's own error text.
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
          const serverText =
            typeof body?.error === "string" && body.error.trim() ? body.error.trim() : null;
          throw new SettingsSaveError(
            serverText ?? `The server returned an error (HTTP ${res.status}).`,
          );
        }
      },
    };
  }, [api]);

  const applyLoaded = useCallback((settings: Record<string, string | number | boolean>) => {
    setValues(settings);
    setDirty({});
    setSaveStatus("idle");
    setUnavailableReason(null);
  }, []);

  /** The message the settings source itself threw (dev-mode notice, status). */
  const describeLoadFailure = (err: unknown): string =>
    err instanceof Error ? err.message : "Settings unavailable.";

  const loadSettings = useCallback(async () => {
    try {
      applyLoaded(await source.getSettings());
    } catch (err) {
      setUnavailableReason(describeLoadFailure(err));
    }
  }, [source, applyLoaded]);

  // First load. setState happens in the promise callbacks, never in the
  // effect body (that would cascade renders).
  useEffect(() => {
    let cancelled = false;
    source.getSettings().then(
      (settings) => {
        if (!cancelled) applyLoaded(settings);
      },
      (err: unknown) => {
        if (!cancelled) setUnavailableReason(describeLoadFailure(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, applyLoaded]);

  useEffect(() => {
    if (!api) return;
    api.getAppVersion().then(setVersion);
  }, [api]);

  const setField = useCallback((key: string, value: string) => {
    setDirty((prev) => ({ ...prev, [key]: value }));
    setSaveStatus("idle");
  }, []);

  const hasDirtyFields = Object.keys(dirty).length > 0;

  async function handleSave() {
    if (!hasDirtyFields) return;

    // Only the fields the owner actually changed are sent.
    const updates: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(dirty)) {
      if ((NUMERIC_FIELD_KEYS as readonly string[]).includes(key)) {
        updates[key] = Number(val);
      } else if ((BOOLEAN_FIELD_KEYS as readonly string[]).includes(key)) {
        updates[key] = val === "true";
      } else {
        updates[key] = val;
      }
    }

    try {
      await source.saveSettings(updates);
      setSaveStatus("saved");
      setDirty({});
      // Re-read so the masked values shown match what is now stored.
      await loadSettings();
    } catch (err) {
      // Only our own copy is shown; an IPC/transport exception stays generic.
      setSaveError(
        err instanceof SettingsSaveError ? err.message : networkFailureMessage("save the settings"),
      );
      setSaveStatus("error");
    }
  }

  async function handleRestart() {
    if (!api) return;
    await api.restartApp();
  }

  async function handleOpenData() {
    if (!api) return;
    await api.openDataDir();
  }

  const store = useMemo<SettingsStore>(
    () => ({ values, dirty, setField, unavailableReason }),
    [values, dirty, setField, unavailableReason],
  );

  return (
    <StoreContext.Provider value={store}>
     {/* One wrapper element so the provider is a single grid/flex child on
         the page: the notice, the groups and the save bar stack inside it. */}
     <div className="min-w-0 space-y-6">
      {unavailableReason && (
        <div
          role="status"
          className="rounded-xl border border-edge bg-raised/40 px-5 py-4 text-[13px] text-ink-dim"
        >
          {unavailableReason}
        </div>
      )}

      {children}

      {/* Save bar — one Save for every field on the page. Sticky so a change
          made at the top of a long page can be saved without scrolling back. */}
      {!unavailableReason && (
        <div className="sticky bottom-0 z-20 -mx-4 md:mx-0 border-t border-edge bg-panel/95 backdrop-blur-sm px-4 md:px-5 py-3 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleSave}
              disabled={!hasDirtyFields}
              className={`px-4 py-1.5 text-xs font-medium rounded-lg ${CHIP_TONE_CLASSES.gold} hover:bg-gold/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors`}
            >
              Save settings
            </button>
            <span className="text-[12px] text-ink-dim">
              {hasDirtyFields
                ? `${Object.keys(dirty).length} unsaved change${Object.keys(dirty).length === 1 ? "" : "s"}`
                : "No unsaved changes."}
            </span>
            {saveStatus === "saved" && <span className="text-[12px] text-up">Saved</span>}
            {saveStatus === "error" && (
              <span role="alert" className="text-[12px] text-down">
                {saveError ? `Couldn't save the settings: ${saveError}` : "Save failed"}
              </span>
            )}
          </div>
          {saveStatus === "saved" && isElectron && (
            <p className="text-[12px] text-ink-faint">
              These settings are read when the app starts, so a restart is needed before the
              change takes effect.{" "}
              <button onClick={handleRestart} className="text-gold-ink underline hover:decoration-2">
                Restart now
              </button>
            </p>
          )}
          {saveStatus === "saved" && !isElectron && (
            <p className="text-[12px] text-ink-faint">
              Saved to the desktop app&apos;s settings file. Restart the dev server before the
              change takes effect.
            </p>
          )}
          {isElectron && (
            <div className="flex items-center justify-between pt-1">
              <button
                onClick={handleOpenData}
                className="text-[12px] text-ink-faint hover:text-ink-dim transition-colors underline"
              >
                Open data directory
              </button>
              {version && <span className="text-[11px] text-ink-faint font-mono">v{version}</span>}
            </div>
          )}
        </div>
      )}
     </div>
    </StoreContext.Provider>
  );
}
