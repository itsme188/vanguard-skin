"use client";

/**
 * Settings panel for per-email-type recipient overrides. Lives inside
 * SettingsModal as a self-contained section because it stores values in
 * the SQLite `settings` table (via /api/settings/email-recipients) rather
 * than the Electron AppSettings JSON file — changes apply immediately to
 * the next cron sweep without an app restart.
 *
 * Three text fields (comma-separated email lists):
 *   - Sunday Briefing   → briefing_email_recipients
 *   - Morning Digest    → digest_email_recipients
 *   - Evening Email     → evening_email_recipients
 *
 * When a field is empty the cron path falls back to the corresponding env
 * var (BRIEFING_EMAIL_TO, DIGEST_EMAIL_TO, EVENING_EMAIL_TO).
 */

import { useEffect, useRef, useState } from "react";
import apiFetch from "@/lib/http/apiFetch";

interface RecipientsState {
  briefing_email_recipients: string;
  digest_email_recipients: string;
  evening_email_recipients: string;
}

const EMPTY_STATE: RecipientsState = {
  briefing_email_recipients: "",
  digest_email_recipients: "",
  evening_email_recipients: "",
};

type FieldKey = keyof RecipientsState;

const FIELDS: { key: FieldKey; label: string; envFallback: string }[] = [
  {
    key: "briefing_email_recipients",
    label: "Sunday Briefing",
    envFallback: "BRIEFING_EMAIL_TO",
  },
  {
    key: "digest_email_recipients",
    label: "Morning Digest",
    envFallback: "DIGEST_EMAIL_TO",
  },
  {
    key: "evening_email_recipients",
    label: "Evening Email",
    envFallback: "EVENING_EMAIL_TO",
  },
];

export function EmailRecipientsSection() {
  const [state, setState] = useState<RecipientsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Track which fields the user has edited since last save
  const [dirty, setDirty] = useState<Partial<RecipientsState>>({});
  // Per-field save feedback ("saved" | "error" | null)
  const [saveStatus, setSaveStatus] = useState<
    Partial<Record<FieldKey, "saved" | "error">>
  >({});
  const saveTimers = useRef<Partial<Record<FieldKey, ReturnType<typeof setTimeout>>>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/email-recipients")
      .then((r) => r.json())
      .then((data: Partial<RecipientsState>) => {
        if (!cancelled) {
          setState({ ...EMPTY_STATE, ...data });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Load failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleChange(key: FieldKey, value: string) {
    setDirty((prev) => ({ ...prev, [key]: value }));
    setSaveStatus((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function saveField(key: FieldKey) {
    if (!(key in dirty)) return;
    const value = dirty[key] ?? "";
    try {
      const res = await apiFetch("/api/settings/email-recipients", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Commit to state and clear dirty bit
      setState((prev) => (prev ? { ...prev, [key]: value } : prev));
      setDirty((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setSaveStatus((prev) => ({ ...prev, [key]: "saved" }));

      // Clear "saved" indicator after 2s
      clearTimeout(saveTimers.current[key]);
      saveTimers.current[key] = setTimeout(() => {
        setSaveStatus((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }, 2000);
    } catch {
      setSaveStatus((prev) => ({ ...prev, [key]: "error" }));
    }
  }

  async function saveAll() {
    const keys = Object.keys(dirty) as FieldKey[];
    if (keys.length === 0) return;
    try {
      const res = await apiFetch("/api/settings/email-recipients", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(dirty),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const newState = { ...(state ?? EMPTY_STATE), ...dirty };
      setState(newState);
      setDirty({});
      const newStatus: Partial<Record<FieldKey, "saved" | "error">> = {};
      for (const k of keys) newStatus[k] = "saved";
      setSaveStatus(newStatus);
      for (const k of keys) {
        clearTimeout(saveTimers.current[k]);
        saveTimers.current[k] = setTimeout(() => {
          setSaveStatus((prev) => {
            const next = { ...prev };
            delete next[k];
            return next;
          });
        }, 2000);
      }
    } catch {
      const errStatus: Partial<Record<FieldKey, "saved" | "error">> = {};
      for (const k of keys) errStatus[k] = "error";
      setSaveStatus(errStatus);
    }
  }

  if (!state && !error) {
    return (
      <div className="space-y-2">
        <p className="text-[10px] text-ink-faint uppercase tracking-wider">
          Email Recipients
        </p>
        <p className="text-[11px] text-ink-faint italic">Loading…</p>
      </div>
    );
  }

  const hasDirty = Object.keys(dirty).length > 0;

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-ink-faint uppercase tracking-wider">
        Email Recipients
      </p>

      {error && <p className="text-[11px] text-down">{error}</p>}

      {state && (
        <>
          <p className="text-[10px] text-ink-faint italic">
            Comma-separated list. Leave blank to use the env-var default.
          </p>

          {FIELDS.map(({ key, label, envFallback }) => {
            const fieldValue = key in dirty ? (dirty[key] ?? "") : state[key];
            const isDirty = key in dirty;
            const status = saveStatus[key];
            return (
              <div key={key}>
                <label className="block text-[11px] text-ink-dim mb-0.5">
                  {label}
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={fieldValue}
                    onChange={(e) => handleChange(key, e.target.value)}
                    onBlur={() => saveField(key)}
                    placeholder={`Falls back to ${envFallback} env var`}
                    className={`flex-1 px-2 py-1 text-xs font-mono bg-raised border rounded text-ink focus:outline-none focus:border-gold ${
                      isDirty ? "border-gold/50" : "border-edge"
                    }`}
                  />
                  {status === "saved" && (
                    <span className="text-[11px] text-up whitespace-nowrap">
                      ✓ Saved
                    </span>
                  )}
                  {status === "error" && (
                    <span className="text-[11px] text-down whitespace-nowrap">
                      Save failed
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {hasDirty && (
            <div className="pt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={saveAll}
                className="px-3 py-1 text-xs font-medium rounded-lg bg-gold/20 text-gold-ink hover:bg-gold/30 transition-colors"
              >
                Save Recipients
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
