"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useElectron } from "@/lib/hooks/useElectron";

/** Fields grouped by section for the settings form. */
const SECTIONS = [
  {
    title: "API Keys",
    fields: [
      { key: "anthropicApiKey", label: "Anthropic API Key", sensitive: true },
      { key: "fredApiKey", label: "FRED API Key", sensitive: true },
      { key: "apiNinjasKey", label: "API Ninjas Key", sensitive: true },
    ],
  },
  {
    title: "IBKR TWS",
    fields: [
      { key: "ibkrAccountCode", label: "Account Code", sensitive: false },
      { key: "twsHost", label: "Host", sensitive: false },
      { key: "twsPort", label: "Port", sensitive: false },
      { key: "autoConnectTws", label: "Auto-connect on startup", sensitive: false, type: "toggle" as const },
      { key: "refreshIntervalMinutes", label: "Auto-refresh interval (min)", sensitive: false, type: "select" as const, options: ["0", "15", "30", "60"] },
    ],
  },
  {
    title: "Email Briefing",
    fields: [
      { key: "gmailAddress", label: "Gmail Address", sensitive: false },
      { key: "gmailAppPassword", label: "Gmail App Password", sensitive: true },
      { key: "briefingEmailTo", label: "Briefing Recipient", sensitive: false },
    ],
  },
  {
    title: "EDGAR",
    fields: [
      { key: "edgarContactEmail", label: "Contact Email", sensitive: false },
    ],
  },
  {
    title: "Mobile Push (Pushover)",
    fields: [
      { key: "pushoverAppToken", label: "App Token", sensitive: true },
      { key: "pushoverUserKey", label: "User Key", sensitive: true },
    ],
  },
] as const;

type FieldKey = (typeof SECTIONS)[number]["fields"][number]["key"];

export function SettingsModal() {
  const { isElectron, api } = useElectron();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [showSensitive, setShowSensitive] = useState<Record<string, boolean>>({});
  const [version, setVersion] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");

  const loadSettings = useCallback(async () => {
    if (!api) return;
    const settings = await api.getSettings();
    setValues(settings);
    setDirty({});
    setSaveStatus("idle");
  }, [api]);

  useEffect(() => {
    if (open && api) {
      loadSettings();
      api.getAppVersion().then(setVersion);
    }
  }, [open, api, loadSettings]);

  // Allow other components to open the modal via a custom event
  useEffect(() => {
    function handleOpenEvent() {
      setOpen(true);
    }
    window.addEventListener("open-settings", handleOpenEvent);
    return () => window.removeEventListener("open-settings", handleOpenEvent);
  }, []);

  // Not in Electron — render nothing
  if (!isElectron) return null;

  function handleFieldChange(key: FieldKey, value: string) {
    setDirty((prev) => ({ ...prev, [key]: value }));
    setSaveStatus("idle");
  }

  function getDisplayValue(key: FieldKey, sensitive: boolean): string {
    // If user has typed a new value, show that
    if (key in dirty) return dirty[key];
    // Otherwise show the sanitized value from settings
    const val = values[key];
    if (val === undefined || val === "") return "";
    return String(val);
  }

  const hasDirtyFields = Object.keys(dirty).length > 0;

  async function handleSave() {
    if (!api || !hasDirtyFields) return;

    // Only send fields the user actually changed
    const updates: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(dirty)) {
      if (key === "twsPort" || key === "refreshIntervalMinutes") {
        updates[key] = Number(val);
      } else if (key === "autoConnectTws" || key === "firstRunComplete") {
        updates[key] = val === "true";
      } else {
        updates[key] = val;
      }
    }

    try {
      await api.saveSettings(updates);
      setSaveStatus("saved");
      setDirty({});
      // Reload settings to get updated sanitized values
      await loadSettings();
    } catch {
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

  return (
    <>
      {/* Gear button in header */}
      <button
        onClick={() => setOpen(true)}
        className="text-ink-faint hover:text-ink-dim transition-colors"
        title="Settings"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>

      {/* Modal overlay — portaled to document.body so it escapes the
          dashboard header's stacking context (z-50 + backdrop-blur-xl).
          Without the portal, the modal body rendered visually behind
          the dashboard main content. */}
      {open && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          {/* Backdrop — behind the modal, click-to-close */}
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />

          {/* Modal — outer container scrolls the viewport; no internal height
              cap so content is never clipped. Sticky header keeps the close
              button pinned while scrolling. */}
          <div className="relative w-full max-w-lg mx-auto my-12 electron:mt-16 rounded-xl border border-edge bg-panel shadow-2xl">
            {/* Header — sticky relative to outer scroll container */}
            <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3.5 border-b border-edge bg-panel/95 backdrop-blur-sm rounded-t-xl">
              <h2 className="text-sm font-medium text-ink">Settings</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-ink-faint hover:text-ink text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-raised"
                aria-label="Close settings"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-5">
              {/* Setting sections */}
              {SECTIONS.map((section) => (
                <div key={section.title} className="space-y-2">
                  <p className="text-[10px] text-ink-faint uppercase tracking-wider">
                    {section.title}
                  </p>
                  <div className="space-y-2">
                    {section.fields.map((field) => {
                      const displayVal = getDisplayValue(field.key, field.sensitive);
                      const isFieldDirty = field.key in dirty;
                      const isVisible = showSensitive[field.key];

                      // Toggle fields (boolean settings)
                      if ("type" in field && field.type === "toggle") {
                        const checked = field.key in dirty
                          ? dirty[field.key] === "true"
                          : !!values[field.key];
                        return (
                          <label key={field.key} className="flex items-center gap-2 cursor-pointer py-0.5">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => handleFieldChange(field.key, String(e.target.checked))}
                              className="accent-gold w-3.5 h-3.5"
                            />
                            <span className={`text-[11px] ${isFieldDirty ? "text-gold" : "text-ink-dim"}`}>
                              {field.label}
                            </span>
                          </label>
                        );
                      }

                      // Select fields (dropdown)
                      if ("type" in field && field.type === "select" && "options" in field) {
                        const currentVal = field.key in dirty
                          ? dirty[field.key]
                          : String(values[field.key] ?? "");
                        return (
                          <div key={field.key}>
                            <label className="block text-[11px] text-ink-dim mb-0.5">
                              {field.label}
                            </label>
                            <select
                              value={currentVal}
                              onChange={(e) => handleFieldChange(field.key, e.target.value)}
                              className={`w-full px-2 py-1 text-xs font-mono bg-raised border rounded text-ink ${
                                isFieldDirty ? "border-gold/50" : "border-edge"
                              }`}
                            >
                              {(field.options as readonly string[]).map((opt) => (
                                <option key={opt} value={opt}>
                                  {opt === "0" ? "Disabled" : `${opt} min`}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      }

                      return (
                        <div key={field.key}>
                          <label className="block text-[11px] text-ink-dim mb-0.5">
                            {field.label}
                          </label>
                          <div className="relative">
                            <input
                              type={field.sensitive && !isVisible ? "password" : "text"}
                              value={displayVal}
                              onChange={(e) => handleFieldChange(field.key, e.target.value)}
                              placeholder={field.sensitive ? "Enter new value..." : ""}
                              className={`w-full px-2 py-1 text-xs font-mono bg-raised border rounded text-ink ${
                                isFieldDirty
                                  ? "border-gold/50"
                                  : "border-edge"
                              }`}
                            />
                            {field.sensitive && (
                              <button
                                type="button"
                                onClick={() =>
                                  setShowSensitive((prev) => ({
                                    ...prev,
                                    [field.key]: !prev[field.key],
                                  }))
                                }
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink-dim text-[10px]"
                              >
                                {isVisible ? "hide" : "show"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Save button */}
              <div className="pt-2 border-t border-edge space-y-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSave}
                    disabled={!hasDirtyFields}
                    className="px-4 py-1.5 text-xs font-medium rounded-lg bg-gold/20 text-gold hover:bg-gold/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    Save Settings
                  </button>
                  {saveStatus === "saved" && (
                    <span className="text-[11px] text-up">Saved</span>
                  )}
                  {saveStatus === "error" && (
                    <span className="text-[11px] text-down">Save failed</span>
                  )}
                </div>
                {saveStatus === "saved" && (
                  <p className="text-[10px] text-ink-faint">
                    API key changes require a restart to take effect.{" "}
                    <button
                      onClick={handleRestart}
                      className="text-gold hover:text-gold/80 underline"
                    >
                      Restart now
                    </button>
                  </p>
                )}
              </div>

              {/* Footer — data dir + version */}
              <div className="pt-2 border-t border-edge flex items-center justify-between">
                <button
                  onClick={handleOpenData}
                  className="text-[11px] text-ink-faint hover:text-ink-dim transition-colors underline"
                >
                  Open Data Directory
                </button>
                {version && (
                  <span className="text-[10px] text-ink-faint font-mono">
                    v{version}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
