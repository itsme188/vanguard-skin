"use client";

/**
 * Settings panel for AI provider failover (provider-failover design §7, slice 4).
 * Lives inside SettingsModal beside AiModelsSection and is stored the same way
 * (SQLite `settings` via /api/settings/ai-failover, applies to the next AI call).
 *
 * Per eligible feature: an on/off switch and an ordered fallback list (provider
 * qualified specs, comma separated, blank = the default order). A feature the
 * design keeps parked (native web search, PDF input, the Cloudflare-only
 * route) shows its reason and NO controls. A group switch turns the earnings
 * print-prep features on or off together. Everything is OFF until switched on,
 * and the server refuses a parked feature whatever this page sends.
 */

import { useEffect, useState } from "react";
import { CHIP_TONE_CLASSES } from "@/app/dashboard/components/Chip";
import apiFetch from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
import { joinSentences } from "@/lib/ui/join-sentences";

interface FailoverFeatureRow {
  key: string;
  eligible: boolean;
  parkedReason: string | null;
  enabled: boolean;
  fallbacks: string[] | null;
  defaultFallbacks: string[];
}

interface FailoverView {
  features: FailoverFeatureRow[];
  group: { key: string; label: string; features: string[]; allEnabled: boolean };
}

type Status = { kind: "saved" | "info" | "error"; message: string };

export function AiFailoverSection() {
  const [view, setView] = useState<FailoverView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/ai-failover")
      .then(async (r) => {
        const result = await readMutationResult<Partial<FailoverView>>(r);
        if (cancelled) return;
        if (!result.ok || !result.data.features || !result.data.group) {
          setLoadError(
            `Couldn't load the failover settings: ${result.ok ? "the server sent no list." : result.message}`,
          );
          return;
        }
        setView(result.data as FailoverView);
      })
      .catch(() => {
        if (!cancelled) setLoadError(networkFailureMessage("load the failover settings"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setRowStatus(id: string, s: Status | null) {
    setStatus((prev) => {
      const next = { ...prev };
      if (s) next[id] = s;
      else delete next[id];
      return next;
    });
  }

  async function patch(id: string, body: Record<string, unknown>, okMessage: string) {
    setBusy((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await apiFetch("/api/settings/ai-failover", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await readMutationResult<Partial<FailoverView>>(res);
      if (!result.ok || !result.data.features || !result.data.group) {
        setRowStatus(id, {
          kind: "error",
          message: joinSentences(
            `Not saved: ${result.ok ? "the server sent no list." : result.message}`,
            "The setting is unchanged.",
          ),
        });
        return;
      }
      setView(result.data as FailoverView);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setRowStatus(id, { kind: "saved", message: okMessage });
    } catch {
      setRowStatus(id, {
        kind: "error",
        message: `${networkFailureMessage("save the failover setting")} The setting is unchanged.`,
      });
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  if (!view && !loadError) {
    return (
      <div className="space-y-2">
        <p className="text-[10px] text-ink-faint uppercase tracking-wider">AI failover</p>
        <p className="text-[11px] text-ink-faint italic">Loading…</p>
      </div>
    );
  }

  const eligible = view?.features.filter((f) => f.eligible) ?? [];
  const parked = view?.features.filter((f) => !f.eligible) ?? [];

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-ink-faint uppercase tracking-wider">AI failover</p>
      {loadError && <p className="text-[11px] text-down">{loadError}</p>}

      {view && (
        <>
          <p className="text-[10px] text-ink-faint italic">
            When Anthropic fails at the account level (credit used up, key rejected, key missing), a
            switched-on feature retries on the next provider in its list. Everything is off until you
            turn it on. The fallback list is{" "}
            <span className="font-mono">provider/model-id</span> or{" "}
            <span className="font-mono">provider/$tier</span>, comma separated, in order (providers:
            openai, workers-ai). Blank uses the default order.
          </p>

          <div className="flex items-center justify-between gap-2 rounded border border-edge bg-raised px-2 py-1.5">
            <span className="text-[11px] text-ink">
              {view.group.label} ({view.group.features.length} features)
              <span className="ml-1.5 text-[10px] text-ink-faint">
                {view.group.allEnabled ? "all on" : "not all on"}
              </span>
            </span>
            <button
              type="button"
              disabled={!!busy.group}
              onClick={() =>
                patch(
                  "group",
                  { group: "earningsPrep", enabled: !view.group.allEnabled },
                  view.group.allEnabled ? "Group switched off" : "Group switched on — applies to the next AI call",
                )
              }
              className={`px-2 py-1 text-[11px] font-medium rounded ${CHIP_TONE_CLASSES.gold} disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap`}
            >
              {busy.group ? "Saving…" : view.group.allEnabled ? "Switch group off" : "Switch group on"}
            </button>
          </div>
          {status.group && <StatusLine s={status.group} />}

          <div className="space-y-2">
            {eligible.map((row) => {
              const saved = (row.fallbacks ?? []).join(", ");
              const draft = row.key in drafts ? drafts[row.key] : saved;
              const dirty = draft.trim() !== saved;
              return (
                <div key={row.key}>
                  <div className="flex items-baseline justify-between gap-2">
                    <label className="flex items-center gap-1.5 text-[11px] text-ink-dim">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        disabled={!!busy[row.key]}
                        onChange={(e) =>
                          patch(
                            row.key,
                            { key: row.key, enabled: e.target.checked },
                            e.target.checked ? "Failover on — applies to the next AI call" : "Failover off",
                          )
                        }
                      />
                      {row.key}
                      {row.enabled && <span className="text-[10px] text-gold-ink">on</span>}
                    </label>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={draft}
                      onChange={(e) => {
                        setDrafts((prev) => ({ ...prev, [row.key]: e.target.value }));
                        setRowStatus(row.key, null);
                      }}
                      placeholder={row.defaultFallbacks.join(", ")}
                      spellCheck={false}
                      aria-label={`Fallback order for ${row.key}`}
                      className={`flex-1 min-w-0 px-2 py-1 text-xs font-mono bg-raised border rounded text-ink focus:outline-none focus:border-gold ${
                        dirty ? "border-gold/50" : "border-edge"
                      }`}
                    />
                    <button
                      type="button"
                      disabled={!!busy[row.key] || !dirty}
                      onClick={() => {
                        const list = draft
                          .split(",")
                          .map((s) => s.trim())
                          .filter((s) => s !== "");
                        void patch(
                          row.key,
                          { key: row.key, fallbacks: list.length > 0 ? list : null },
                          list.length > 0 ? "Saved — applies to the next AI call" : "Cleared — back to the default order",
                        );
                      }}
                      className={`px-2 py-1 text-[11px] font-medium rounded ${CHIP_TONE_CLASSES.gold} disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap`}
                    >
                      {busy[row.key] ? "Saving…" : "Save"}
                    </button>
                  </div>
                  {status[row.key] && <StatusLine s={status[row.key]} />}
                </div>
              );
            })}
          </div>

          {parked.length > 0 && (
            <div className="space-y-1 pt-1">
              <p className="text-[10px] text-ink-faint uppercase tracking-wider">Stay on their provider</p>
              {parked.map((row) => (
                <div key={row.key} className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] text-ink-dim">{row.key}</span>
                  <span className="text-[10px] text-ink-dim text-right">{row.parkedReason}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusLine({ s }: { s: Status }) {
  return (
    <p
      className={`mt-0.5 text-[11px] ${
        s.kind === "error" ? "text-down" : s.kind === "saved" ? "text-up" : "text-ink-faint"
      }`}
    >
      {s.kind === "saved" ? "✓ " : ""}
      {s.message}
    </p>
  );
}
