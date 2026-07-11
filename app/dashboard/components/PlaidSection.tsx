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

import { useEffect, useState } from "react";

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
  success: boolean;
  accountsSynced?: number;
  holdingsWritten?: number;
  pricesWritten?: number;
  staleRemoved?: number;
  skippedReason?: "market_closed" | "already_synced_today" | null;
  unmatched?: UnmatchedPlaidSecurity[];
  error?: string;
}

type InlineStatus =
  | { kind: "saved" | "info"; message: string }
  | { kind: "error"; message: string };

type SyncStatus =
  | { kind: "success"; message: string; unmatched: UnmatchedPlaidSecurity[] }
  | { kind: "error"; message: string };

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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/plaid")
      .then((r) => r.json())
      .then((data: PlaidSettingsPayload) => {
        if (cancelled) return;
        setPayload(data);
        setDraftMap(data.accountMap);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load Plaid settings");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function load() {
    try {
      const res = await fetch("/api/settings/plaid");
      const data = (await res.json()) as PlaidSettingsPayload;
      setPayload(data);
      setDraftMap(data.accountMap);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load Plaid settings");
    }
  }

  async function saveMapping() {
    setMapSaving(true);
    setMapStatus(null);
    try {
      const res = await fetch("/api/settings/plaid", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountMap: draftMap }),
      });
      const data = (await res.json()) as PlaidSettingsPayload & { success?: boolean; error?: string };
      if (!res.ok || data.success === false) {
        setMapStatus({ kind: "error", message: data.error || `Save failed (HTTP ${res.status})` });
        return;
      }
      setPayload(data);
      setDraftMap(data.accountMap);
      setMapStatus({ kind: "saved", message: "Mapping saved." });
    } catch (err) {
      setMapStatus({
        kind: "error",
        message: err instanceof Error ? `Save failed: ${err.message}` : "Save failed",
      });
    } finally {
      setMapSaving(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncStatus(null);
    try {
      const res = await fetch("/api/plaid/sync", { method: "POST" });
      const data = (await res.json()) as SyncResponse;
      if (data.success) {
        const accountsSynced = data.accountsSynced ?? 0;
        const holdingsWritten = data.holdingsWritten ?? 0;
        let message: string;
        if (data.skippedReason === "market_closed") {
          message = "Nothing to sync — the market is closed.";
        } else if (data.skippedReason === "already_synced_today") {
          message = "Already synced today — nothing new to pull.";
        } else {
          message = `Synced ${holdingsWritten} holding${holdingsWritten === 1 ? "" : "s"} across ${accountsSynced} account${accountsSynced === 1 ? "" : "s"}.`;
        }
        setSyncStatus({ kind: "success", message, unmatched: data.unmatched ?? [] });
        void load();
      } else {
        setSyncStatus({ kind: "error", message: data.error || "Sync failed." });
      }
    } catch {
      setSyncStatus({ kind: "error", message: "Failed to connect to server" });
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
          className="px-2.5 py-1 text-[11px] font-medium rounded bg-gold/20 text-gold hover:bg-gold/30 transition-colors whitespace-nowrap"
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
          </div>
        )}
      </div>
    </div>
  );
}
