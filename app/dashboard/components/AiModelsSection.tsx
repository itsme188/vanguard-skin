"use client";

/**
 * Settings panel for per-feature AI model overrides. Lives inside
 * SettingsModal as a self-contained section (EmailRecipientsSection /
 * EarningsEmailsSection precedent) because overrides are stored in the
 * SQLite `settings` table via /api/settings/ai-models — changes apply to
 * the very next AI call (the resolver cache is invalidated on write), no
 * app restart needed.
 *
 * Per feature key: the code default, the effective model (mono), a text
 * input for the override (placeholder = default), Save + Reset. A plain
 * text input, not a dropdown — model ids change too fast for a hardcoded
 * list. Validation (format + provider whitelist) happens server-side and
 * errors surface inline per the honest-button-feedback rule.
 */

import { useEffect, useState } from "react";

interface FeatureModelRow {
  key: string;
  defaultModel: string;
  override: string | null;
  effective: string;
}

type RowStatus =
  | { kind: "saved" | "info"; message: string }
  | { kind: "error"; message: string };

export function AiModelsSection() {
  const [features, setFeatures] = useState<FeatureModelRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/ai-models")
      .then(async (r) => {
        const data = (await r.json()) as {
          success?: boolean;
          features?: FeatureModelRow[];
          error?: string;
        };
        if (!r.ok || !data.success || !data.features) {
          throw new Error(data.error || `HTTP ${r.status}`);
        }
        if (!cancelled) setFeatures(data.features);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load AI models",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setRowStatus(key: string, s: RowStatus | null) {
    setStatus((prev) => {
      const next = { ...prev };
      if (s) next[key] = s;
      else delete next[key];
      return next;
    });
  }

  async function patchOverride(key: string, model: string | null) {
    setSaving((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await fetch("/api/settings/ai-models", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, model }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        features?: FeatureModelRow[];
        error?: string;
      };
      if (!res.ok || !data.success || !data.features) {
        setRowStatus(key, {
          kind: "error",
          message: data.error || `Save failed (HTTP ${res.status}) — override unchanged`,
        });
        return;
      }
      setFeatures(data.features);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setRowStatus(
        key,
        model === null
          ? { kind: "saved", message: "Override cleared — back to the default model" }
          : { kind: "saved", message: "Saved — applies to the next AI call" },
      );
    } catch (err) {
      setRowStatus(key, {
        kind: "error",
        message:
          err instanceof Error
            ? `Save failed: ${err.message} — override unchanged`
            : "Save failed — override unchanged",
      });
    } finally {
      setSaving((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  async function handleSave(row: FeatureModelRow) {
    const key = row.key;
    const draft = (key in drafts ? drafts[key] : (row.override ?? "")).trim();
    if (draft === (row.override ?? "")) {
      setRowStatus(key, {
        kind: "info",
        message: row.override
          ? "No change — this override is already saved"
          : "Nothing to save — field is empty and no override is set",
      });
      return;
    }
    // Empty input = clear (same as Reset), explained rather than silently no-oping.
    await patchOverride(key, draft === "" ? null : draft);
  }

  if (!features && !loadError) {
    return (
      <div className="space-y-2">
        <p className="text-[10px] text-ink-faint uppercase tracking-wider">
          AI Models
        </p>
        <p className="text-[11px] text-ink-faint italic">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-ink-faint uppercase tracking-wider">
        AI Models
      </p>

      {loadError && <p className="text-[11px] text-down">{loadError}</p>}

      {features && (
        <>
          <p className="text-[10px] text-ink-faint italic">
            Per-feature model override as{" "}
            <span className="font-mono">provider/model-id</span> (providers:
            anthropic, openai, workers-ai). Leave blank to use the code
            default. Changes apply to the next AI call — no restart.
          </p>

          <div className="space-y-2">
            {features.map((row) => {
              const draft =
                row.key in drafts ? drafts[row.key] : (row.override ?? "");
              const isDirty = draft.trim() !== (row.override ?? "");
              const rowStatus = status[row.key];
              const isSaving = !!saving[row.key];
              return (
                <div key={row.key}>
                  <div className="flex items-baseline justify-between gap-2">
                    <label className="block text-[11px] text-ink-dim mb-0.5">
                      {row.key}
                      {row.override && (
                        <span className="ml-1.5 text-[10px] text-gold-ink">
                          overridden
                        </span>
                      )}
                    </label>
                    <span
                      className="text-[10px] font-mono text-ink-faint truncate max-w-[55%]"
                      title={`Effective: ${row.effective}`}
                    >
                      {/* Tier-token defaults ($frontier/$workhorse/$cheap) resolve
                          to a concrete model at call time — show the expansion so
                          "default" doesn't read as an opaque token. */}
                      {!row.override && row.defaultModel.includes("/$")
                        ? `${row.defaultModel.split("/")[1]} → ${row.effective}`
                        : row.effective}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={draft}
                      onChange={(e) => {
                        setDrafts((prev) => ({
                          ...prev,
                          [row.key]: e.target.value,
                        }));
                        setRowStatus(row.key, null);
                      }}
                      placeholder={row.defaultModel}
                      spellCheck={false}
                      className={`flex-1 min-w-0 px-2 py-1 text-xs font-mono bg-raised border rounded text-ink focus:outline-none focus:border-gold ${
                        isDirty ? "border-gold/50" : "border-edge"
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => handleSave(row)}
                      disabled={isSaving}
                      className="px-2 py-1 text-[11px] font-medium rounded bg-gold/20 text-gold-ink hover:bg-gold/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                    >
                      {isSaving ? "Saving…" : "Save"}
                    </button>
                    {row.override && (
                      <button
                        type="button"
                        onClick={() => patchOverride(row.key, null)}
                        disabled={isSaving}
                        className="px-2 py-1 text-[11px] font-medium rounded bg-raised border border-edge text-ink-dim hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                        title="Clear the override and fall back to the default model"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  {rowStatus && (
                    <p
                      className={`mt-0.5 text-[11px] ${
                        rowStatus.kind === "error"
                          ? "text-down"
                          : rowStatus.kind === "saved"
                            ? "text-up"
                            : "text-ink-faint"
                      }`}
                    >
                      {rowStatus.kind === "saved" ? "✓ " : ""}
                      {rowStatus.message}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
