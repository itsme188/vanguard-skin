"use client";

import { useEffect, useState } from "react";
import { PrivateText } from "@/lib/privacy/components";

interface Props {
  scope: string;
  surfaceKey: "factor-analysis" | "risk-metrics" | "position-risk" | "factor-heatmap" | "defense";
}

// Exported for unit testing (no rendering harness in this repo — see the
// notesListIsFiltered precedent in tests/dashboard/notes-filtered-state.test.ts
// for the pattern of testing extracted pure helpers directly).
export function formatGeneratedAt(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });
}

export function NarrativeBlock({ scope, surfaceKey }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/analysis/narrative?scope=${scope}&surface=${surfaceKey}`)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        if (data.success) {
          setText(data.narrativeMd);
          setGeneratedAt(data.generatedAt ?? null);
        } else {
          setError(data.error ?? "Failed to load narrative");
        }
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Failed to load narrative"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [scope, surfaceKey]);

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch("/api/analysis/narrative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, surface: surfaceKey }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setText(data.narrativeMd);
        setGeneratedAt(data.generatedAt ?? null);
      } else {
        // Honest failure surface (incl. the 24h rate-limit message) — never
        // swallow, never silently revert (nothing was optimistically changed
        // above, so the stale narrative simply stays visible alongside this).
        setRefreshError(data.error ?? "Refresh failed");
      }
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) return <div className="text-xs text-ink-faint italic mt-2">Loading narrative…</div>;
  if (error || !text) return null; // graceful no-render on error

  return (
    <div className="text-sm text-ink-dim italic border-l-2 border-gold/40 pl-3 my-3 leading-relaxed">
      {/* AI narrative embeds portfolio-derived figures at generation time, so
          the only correct mask is the whole prose block (same rule as the
          interpretation sentences). */}
      <PrivateText>{text}</PrivateText>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 not-italic">
        {generatedAt && (
          <span className="text-xs text-ink-faint">
            Generated {formatGeneratedAt(generatedAt)}
          </span>
        )}
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label="Refresh narrative"
          className="text-xs text-ink-dim underline decoration-dotted underline-offset-2 hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        {refreshError && (
          <span className="text-xs text-warn" role="alert">
            {refreshError}
          </span>
        )}
      </div>
    </div>
  );
}
