"use client";

/**
 * Settings panel for earnings preview/recap emails. Lives inside
 * SettingsModal as a self-contained section because it stores prefs in
 * the SQLite settings table (via /api/settings/earnings) rather than the
 * Electron AppSettings JSON file — that way mute/disable changes apply
 * immediately to the next 15-min cron sweep without an app restart.
 *
 * Two controls:
 *   - Master toggle (enabled / disabled). When OFF, findEmailCandidates
 *     returns []; no preview or recap fires for any symbol.
 *   - Muted symbols list. Type a symbol + Enter to mute; click × to
 *     unmute. Symbols are upper-cased + deduped server-side.
 */

import { useEffect, useState } from "react";
import apiFetch from "@/lib/http/apiFetch";

interface EarningsSettings {
  enabled: boolean;
  mutedSymbols: string[];
}

export function EarningsEmailsSection() {
  const [state, setState] = useState<EarningsSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/earnings")
      .then((r) => r.json())
      .then((data: EarningsSettings) => {
        if (!cancelled) setState(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Load failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function patch(updates: Partial<EarningsSettings>) {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/settings/earnings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as EarningsSettings;
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function addMute() {
    if (!state) return;
    const sym = draft.trim().toUpperCase();
    if (!sym) return;
    if (state.mutedSymbols.includes(sym)) {
      setDraft("");
      return;
    }
    void patch({ mutedSymbols: [...state.mutedSymbols, sym] });
    setDraft("");
  }

  function removeMute(sym: string) {
    if (!state) return;
    void patch({ mutedSymbols: state.mutedSymbols.filter((s) => s !== sym) });
  }

  if (!state && !error) {
    return (
      <div className="space-y-2">
        <p className="text-[10px] text-ink-faint uppercase tracking-wider">
          Earnings Emails
        </p>
        <p className="text-[11px] text-ink-faint italic">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-ink-faint uppercase tracking-wider">
        Earnings Emails
      </p>

      {error && (
        <p className="text-[11px] text-down">{error}</p>
      )}

      {state && (
        <>
          <label className="flex items-center gap-2 cursor-pointer py-0.5">
            <input
              type="checkbox"
              checked={state.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
              disabled={saving}
              className="accent-gold w-3.5 h-3.5"
            />
            <span className="text-[11px] text-ink-dim">
              Send earnings preview + recap emails
              {!state.enabled && <span className="text-ink-faint italic"> — disabled</span>}
            </span>
          </label>

          <div>
            <label className="block text-[11px] text-ink-dim mb-1">
              Muted symbols ({state.mutedSymbols.length})
            </label>
            {state.mutedSymbols.length > 0 ? (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {state.mutedSymbols.map((sym) => (
                  <span
                    key={sym}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono bg-raised border border-edge rounded"
                  >
                    {sym}
                    <button
                      type="button"
                      onClick={() => removeMute(sym)}
                      disabled={saving}
                      className="text-ink-faint hover:text-down ml-0.5"
                      aria-label={`Unmute ${sym}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[10px] text-ink-faint italic mb-1.5">
                No muted symbols.
              </p>
            )}
            <div className="flex gap-1">
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addMute();
                  }
                }}
                placeholder="TICKER"
                disabled={saving}
                className="flex-1 px-2 py-1 text-xs font-mono bg-raised border border-edge rounded text-ink uppercase focus:outline-none focus:border-gold"
                maxLength={10}
              />
              <button
                type="button"
                onClick={addMute}
                disabled={saving || !draft.trim()}
                className="px-2.5 py-1 text-xs bg-gold/20 text-gold-ink hover:bg-gold/30 disabled:opacity-30 rounded"
              >
                Mute
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
