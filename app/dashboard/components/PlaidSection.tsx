"use client";

/**
 * Settings panel for the Plaid-backed live Vanguard holdings feed
 * (EarningsEmailsSection / AiModelsSection idioms: self-contained fetch
 * on mount, inline PATCH errors, honest zero-result / failure messages).
 *
 * Three pieces:
 *   - Connection status + Connect/Reconnect link (opens the Link flow at
 *     /dashboard/plaid-link in a new tab — Plaid Link is a full-page
 *     redirect-capable widget, doesn't belong inside this modal).
 *   - Per-Plaid-account → local-account mapping (auto-proposed at
 *     exchange time, editable + savable here).
 *   - "Sync Vanguard now" — manual trigger for the same pipeline the
 *     daily launchd cron runs, with honest counts / unmatched-securities
 *     feedback (never a silent no-op).
 */

import { CHIP_TONE_CLASSES } from "@/app/dashboard/components/Chip";
import { useEffect, useState } from "react";
import apiFetch from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
import { joinSentences } from "@/lib/ui/join-sentences";

interface PlaidAccountInfo {
  id: string;
  name: string;
  mask: string | null;
  subtype: string | null;
}

interface PlaidSettingsPayload {
  configured: boolean;
  connected: boolean;
  connectionStatus: "ok" | "reauth_required" | "disconnected";
  lastSyncAt: string | null;
  plaidAccounts: PlaidAccountInfo[];
  accountMap: Record<string, number>;
  localAccounts: { id: number; name: string }[];
}

interface UnmatchedPlaidSecurity {
  name: string | null;
  reason: string;
}

interface SyncResponse {
  accountsSynced?: number;
  holdingsWritten?: number;
  pricesWritten?: number;
  staleRemoved?: number;
  unmatched?: UnmatchedPlaidSecurity[];
  securitiesCreated?: string[];
}

type InlineStatus =
  | { kind: "saved" | "info"; message: string }
  | { kind: "error"; message: string };

type SyncStatus =
  | {
      kind: "success";
      message: string;
      unmatched: UnmatchedPlaidSecurity[];
      securitiesCreated: string[];
    }
  | { kind: "error"; message: string };

type PlaidSettingsLoad =
  | { ok: true; payload: PlaidSettingsPayload }
  | { ok: false; message: string };

/**
 * Read the settings GET. That route answers with the settings object itself
 * (no success envelope), so the status and the shape are the gate: a failed
 * or unreadable answer is a failure line, never a settings panel built from
 * an error body.
 */
async function readPlaidSettings(res: Response): Promise<PlaidSettingsLoad> {
  const body = (await res.json().catch(() => null)) as
    | (Partial<PlaidSettingsPayload> & { error?: unknown })
    | null;
  if (
    res.ok &&
    body &&
    typeof body.configured === "boolean" &&
    Array.isArray(body.plaidAccounts) &&
    Array.isArray(body.localAccounts) &&
    body.accountMap != null
  ) {
    return { ok: true, payload: body as PlaidSettingsPayload };
  }
  const serverText = typeof body?.error === "string" && body.error.trim() ? body.error.trim() : null;
  return {
    ok: false,
    message: `Couldn't load the Plaid settings: ${
      serverText ?? `the server returned an error (HTTP ${res.status}).`
    }`,
  };
}

function formatTimeSince(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function PlaidSection() {
  const [payload, setPayload] = useState<PlaidSettingsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftMap, setDraftMap] = useState<Record<string, number>>({});
  const [mapStatus, setMapStatus] = useState<InlineStatus | null>(null);
  const [mapSaving, setMapSaving] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  // A re-read that failed AFTER a sync that finished. Its own line: it must
  // never replace the section or hide the sync's result.
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/plaid")
      .then(readPlaidSettings)
      .then((loaded) => {
        if (cancelled) return;
        if (!loaded.ok) {
          setLoadError(loaded.message);
          return;
        }
        setPayload(loaded.payload);
        setDraftMap(loaded.payload.accountMap);
      })
      .catch(() => {
        if (!cancelled) setLoadError(networkFailureMessage("load the Plaid settings"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The re-read after a sync whose outcome has already been said. A re-read
  // that fails is not the sync failing: the settings on screen stay as they
  // were (only the "last synced" time is out of date) and the failure gets
  // its own line under the sync result.
  async function refreshAfterWrite() {
    const failed = "The sync finished; the list could not be refreshed. Reload to see it.";
    try {
      const loaded = await readPlaidSettings(await fetch("/api/settings/plaid"));
      if (!loaded.ok) {
        setRefreshError(failed);
        return;
      }
      setPayload(loaded.payload);
      setDraftMap(loaded.payload.accountMap);
      setRefreshError(null);
    } catch {
      setRefreshError(failed);
    }
  }

  async function saveMapping() {
    setMapSaving(true);
    setMapStatus(null);
    try {
      const res = await apiFetch("/api/settings/plaid", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountMap: draftMap }),
      });
      const result = await readMutationResult<PlaidSettingsPayload>(res);
      if (!result.ok) {
        setMapStatus({
          kind: "error",
          message: joinSentences(
            `Mapping not saved: ${result.message}`,
            "The saved mapping is unchanged.",
          ),
        });
        return;
      }
      setPayload(result.data);
      setDraftMap(result.data.accountMap);
      setMapStatus({ kind: "saved", message: "Mapping saved." });
    } catch {
      setMapStatus({
        kind: "error",
        message: `${networkFailureMessage("save the mapping")} The saved mapping is unchanged.`,
      });
    } finally {
      setMapSaving(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncStatus(null);
    setRefreshError(null);
    try {
      const res = await apiFetch("/api/plaid/sync", { method: "POST" });
      const result = await readMutationResult<SyncResponse>(res);
      if (!result.ok) {
        setSyncStatus({ kind: "error", message: `Vanguard sync failed: ${result.message}` });
        return;
      }
      const data = result.data;
      const accountsSynced = data.accountsSynced ?? 0;
      const holdingsWritten = data.holdingsWritten ?? 0;
      // This button's route always forces the sync, so the cron-only
      // "skipped" answers (closed day, already ran today) never come back
      // here; tests/plaid/plaid-minors-q30.test.ts pins that.
      let message = `Synced ${holdingsWritten} holding${holdingsWritten === 1 ? "" : "s"} across ${accountsSynced} account${accountsSynced === 1 ? "" : "s"}.`;
      const securitiesCreated = data.securitiesCreated ?? [];
      if (securitiesCreated.length > 0) {
        message += ` New securities created: ${securitiesCreated.join(", ")} — verify these aren't duplicates of existing holdings.`;
      }
      setSyncStatus({
        kind: "success",
        message,
        unmatched: data.unmatched ?? [],
        securitiesCreated,
      });
      void refreshAfterWrite();
    } catch {
      setSyncStatus({ kind: "error", message: networkFailureMessage("sync Vanguard") });
    } finally {
      setSyncing(false);
    }
  }

  if (!payload && !loadError) {
    return (
      <div className="space-y-2">
        <p className="text-[10px] text-ink-faint uppercase tracking-wider">
          Vanguard Live (Plaid)
        </p>
        <p className="text-[11px] text-ink-faint italic">Loading…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-2">
        <p className="text-[10px] text-ink-faint uppercase tracking-wider">
          Vanguard Live (Plaid)
        </p>
        <p className="text-[11px] text-down">{loadError}</p>
      </div>
    );
  }

  if (!payload) return null;

  if (!payload.configured) {
    return (
      <div className="space-y-2">
        <p className="text-[10px] text-ink-faint uppercase tracking-wider">
          Vanguard Live (Plaid)
        </p>
        <p className="text-[11px] text-ink-faint">
          Plaid credentials not set — add PLAID_CLIENT_ID / PLAID_SECRET to
          .env.local or settings.json.
        </p>
      </div>
    );
  }

  const connectHref =
    payload.connectionStatus === "reauth_required"
      ? "/dashboard/plaid-link?mode=reauth"
      : "/dashboard/plaid-link";
  const connectLabel =
    payload.connectionStatus === "reauth_required" ? "Reconnect" : "Connect Vanguard";

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-ink-faint uppercase tracking-wider">
        Vanguard Live (Plaid)
      </p>

      <div className="flex items-center justify-between gap-2">
        {payload.connectionStatus === "disconnected" && (
          <span className="text-[11px] text-ink-dim">Disconnected</span>
        )}
        {payload.connectionStatus === "ok" && (
          <span className="text-[11px] text-ink-dim">
            Connected
            {payload.lastSyncAt
              ? ` · last synced ${formatTimeSince(payload.lastSyncAt)}`
              : " · never synced"}
          </span>
        )}
        {payload.connectionStatus === "reauth_required" && (
          <span className="text-[11px] text-down">Needs re-authentication</span>
        )}
        <a
          href={connectHref}
          target="_blank"
          rel="noreferrer"
          className={`px-2.5 py-1 text-[11px] font-medium rounded ${CHIP_TONE_CLASSES.gold} hover:bg-gold/30 transition-colors whitespace-nowrap`}
        >
          {connectLabel}
        </a>
      </div>

      {payload.plaidAccounts.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <label className="block text-[11px] text-ink-dim">Account mapping</label>
          {payload.plaidAccounts.map((pa) => (
            <div key={pa.id} className="flex items-center gap-1.5">
              <span
                className="flex-1 min-w-0 truncate text-[11px] font-mono text-ink-faint"
                title={pa.name}
              >
                {pa.name}
                {pa.mask ? ` ···${pa.mask}` : ""}
              </span>
              <select
                value={draftMap[pa.id] ?? ""}
                onChange={(e) =>
                  setDraftMap((prev) => ({
                    ...prev,
                    [pa.id]: Number(e.target.value),
                  }))
                }
                disabled={mapSaving}
                className="px-2 py-1 text-[11px] font-mono bg-raised border border-edge rounded text-ink focus:outline-none focus:border-gold"
              >
                <option value="" disabled>
                  Select account…
                </option>
                {payload.localAccounts.map((acct) => (
                  <option key={acct.id} value={acct.id}>
                    {acct.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={saveMapping}
              disabled={mapSaving}
              className="px-2.5 py-1 text-[11px] font-medium rounded bg-raised border border-edge text-ink-dim hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {mapSaving ? "Saving…" : "Save mapping"}
            </button>
            {mapStatus && (
              <span
                className={`text-[11px] ${
                  mapStatus.kind === "error" ? "text-down" : "text-up"
                }`}
              >
                {mapStatus.message}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="pt-1 space-y-1">
        <button
          type="button"
          onClick={handleSync}
          disabled={syncing}
          className="px-2.5 py-1 text-[11px] font-medium rounded bg-raised border border-edge text-ink-dim hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          {syncing ? "Syncing…" : "Sync Vanguard now"}
        </button>
        {syncStatus && (
          <div className="text-[11px] space-y-0.5">
            <p className={syncStatus.kind === "error" ? "text-down" : "text-up"}>
              {syncStatus.message}
            </p>
            {syncStatus.kind === "success" && syncStatus.unmatched.length > 0 && (
              <p className="text-ink-faint italic">
                Unmatched:{" "}
                {syncStatus.unmatched
                  .map((u) => `${u.name ?? "unknown security"} (${u.reason})`)
                  .join(", ")}
              </p>
            )}
            {refreshError && (
              <p className="text-down" role="status">
                {refreshError}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
