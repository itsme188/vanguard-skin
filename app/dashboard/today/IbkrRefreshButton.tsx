"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  latestPriceDate: string | null;
}

interface SyncStatusResponse {
  success: boolean;
  data: {
    status: "idle" | "syncing" | "error";
    currentPhase: string | null;
    phaseProgress: { current: number; total: number; label: string } | null;
    error: string | null;
  };
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 180_000;

export function IbkrRefreshButton({ latestPriceDate }: Props) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [phaseLabel, setPhaseLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  useEffect(() => () => { stopRef.current = true; }, []);

  async function refresh() {
    setSyncing(true);
    setError(null);
    setPhaseLabel("starting…");
    stopRef.current = false;
    try {
      const res = await fetch("/api/tws/auto-refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "quick" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
        setError(msg);
        setSyncing(false);
        setPhaseLabel(null);
        return;
      }
      const start = Date.now();
      while (!stopRef.current && Date.now() - start < POLL_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const statusRes = await fetch("/api/tws/sync-status", { cache: "no-store" });
        if (!statusRes.ok) continue;
        const json = (await statusRes.json()) as SyncStatusResponse;
        const s = json.data;
        if (s.status === "error" && s.error) {
          setError(s.error);
          setSyncing(false);
          setPhaseLabel(null);
          return;
        }
        if (s.status === "syncing") {
          if (s.phaseProgress) {
            setPhaseLabel(`${s.currentPhase ?? "syncing"} ${s.phaseProgress.current}/${s.phaseProgress.total}`);
          } else if (s.currentPhase) {
            setPhaseLabel(s.currentPhase);
          }
          continue;
        }
        // idle
        setSyncing(false);
        setPhaseLabel(null);
        router.refresh();
        return;
      }
      // Timeout safety net
      if (!stopRef.current) {
        setSyncing(false);
        setPhaseLabel(null);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSyncing(false);
      setPhaseLabel(null);
    }
  }

  const ageLabel = formatPriceAge(latestPriceDate);

  return (
    <div className="flex items-center gap-2 text-[11px]">
      {phaseLabel && <span className="text-ink-faint italic">{phaseLabel}</span>}
      {error && <span className="text-down" title={error}>⚠ {error.length > 30 ? `${error.slice(0, 30)}…` : error}</span>}
      {!syncing && !error && ageLabel && (
        <span className="text-ink-faint">{ageLabel}</span>
      )}
      <button
        type="button"
        onClick={refresh}
        disabled={syncing}
        className="text-ink-dim hover:text-gold disabled:opacity-50 font-mono"
      >
        {syncing ? "…syncing" : "↻ refresh"}
      </button>
    </div>
  );
}

function formatPriceAge(iso: string | null): string | null {
  if (!iso) return null;
  const datePart = iso.slice(0, 10);
  const then = new Date(`${datePart}T00:00:00`);
  if (isNaN(then.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffMs = today.getTime() - then.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}
