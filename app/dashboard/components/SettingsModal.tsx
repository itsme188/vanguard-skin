"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useElectron } from "@/lib/hooks/useElectron";
import { AiModelsSection } from "./AiModelsSection";
import { EarningsEmailsSection } from "./EarningsEmailsSection";
import { EmailRecipientsSection } from "./EmailRecipientsSection";
import { PlaidSection } from "./PlaidSection";

/**
 * Settings source abstraction — either Electron IPC (packaged app) or the
 * /api/settings dev-mode HTTP fallback. Same shape as the Electron API
 * surface the modal expects.
 */
interface SettingsSource {
  getSettings: () => Promise<Record<string, string | number | boolean>>;
  saveSettings: (updates: Record<string, unknown>) => Promise<unknown>;
  available: boolean;
}

/** Fields grouped by section for the settings form. */
const SECTIONS = [
  {
    title: "API Keys",
    fields: [
      { key: "anthropicApiKey", label: "Anthropic API Key", sensitive: true },
      { key: "fredApiKey", label: "FRED API Key", sensitive: true },
      { key: "apiNinjasKey", label: "API Ninjas Key", sensitive: true },
      { key: "alphaVantageApiKey", label: "Alpha Vantage Key (transcripts)", sensitive: true },
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
      { key: "resendApiKey", label: "Resend API Key (outbound)", sensitive: true },
      { key: "resendFromDomain", label: "Resend From Domain (e.g. myportfoliodesk.com)", sensitive: false },
      { key: "gmailAddress", label: "Gmail Address (inbound IMAP)", sensitive: false },
      { key: "gmailAppPassword", label: "Gmail App Password (inbound IMAP)", sensitive: true },
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
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

  // Resolve the settings source: Electron IPC first, HTTP dev route as
  // fallback. `available=false` means neither channel is usable — the modal
  // surfaces a friendly message instead of showing empty fields.
  const source = useMemo<SettingsSource>(() => {
    if (api) {
      return {
        getSettings: () => api.getSettings(),
        saveSettings: (updates) => api.saveSettings(updates),
        available: true,
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
        const res = await fetch("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(updates),
        });
        if (!res.ok) {
          throw new Error(`Save failed (HTTP ${res.status})`);
        }
      },
      // We don't know yet whether the route exists — the first getSettings
      // call below will set unavailableReason if it 404s.
      available: true,
    };
  }, [api]);

  const loadSettings = useCallback(async () => {
    try {
      const settings = await source.getSettings();
      setValues(settings);
      setDirty({});
      setSaveStatus("idle");
      setUnavailableReason(null);
    } catch (err) {
      setUnavailableReason(
        err instanceof Error ? err.message : "Settings unavailable.",
      );
    }
  }, [source]);

  useEffect(() => {
    if (!open) return;
    loadSettings();
    if (api) {
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
    if (!hasDirtyFields) return;

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
      await source.saveSettings(updates);
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
        className="relative text-ink-faint hover:text-ink-dim transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']"
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
              {unavailableReason && (
                <div className="rounded-lg border border-edge bg-raised/40 p-3 text-[11px] text-ink-dim">
                  {unavailableReason}
                </div>
              )}

              {/* Setting sections — hidden when the source didn't load. */}
              {!unavailableReason && SECTIONS.map((section) => (
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

              {/* Email recipients section — DB-backed per-email-type
                  recipient overrides. Changes apply immediately to the
                  next cron sweep without an app restart. */}
              {!unavailableReason && (
                <div className="pt-2 border-t border-edge">
                  <EmailRecipientsSection />
                </div>
              )}

              {/* Earnings-emails section — uses its own DB-backed
                  endpoint instead of the Electron settings file so changes
                  apply immediately to the next cron sweep. */}
              {!unavailableReason && (
                <div className="pt-2 border-t border-edge">
                  <EarningsEmailsSection />
                </div>
              )}

              {/* AI model overrides — DB-backed per-feature model swaps
                  (settings key feature_model_overrides). The resolver cache
                  is invalidated on write, so changes apply to the next AI
                  call without a restart. */}
              {!unavailableReason && (
                <div className="pt-2 border-t border-edge">
                  <AiModelsSection />
                </div>
              )}

              {/* Plaid-backed live Vanguard holdings feed — DB-backed
                  connection state (access token, account map) via
                  /api/settings/plaid, same reasoning as the sections
                  above: applies immediately, no app restart. */}
              {!unavailableReason && (
                <div className="pt-2 border-t border-edge">
                  <PlaidSection />
                </div>
              )}

              {/* Save button — hidden when unavailable */}
              {!unavailableReason && (
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
                {saveStatus === "saved" && isElectron && (
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
                {saveStatus === "saved" && !isElectron && (
                  <p className="text-[10px] text-ink-faint">
                    Settings saved to the Electron app&apos;s Application Support
                    directory. Restart the dev server for API-key changes to
                    take effect.
                  </p>
                )}
              </div>
              )}

              {/* Footer — data dir + version (Electron-only). */}
              {isElectron && (
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
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
