"use client";

import { useCallback, useEffect, useState } from "react";
import { PrivateText } from "@/lib/privacy/components";
import { formatGeneratedAt } from "@/lib/calendar/date-utils";
import apiFetch from "@/lib/http/apiFetch";

interface Props {
  scope: string;
  surfaceKey: "factor-analysis" | "risk-metrics" | "position-risk" | "factor-heatmap" | "defense";
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Render the POST route's 429 `retryAfter` (ms) as domain language instead
 * of the bare "rate-limited" token — round up to whole hours so "1h" always
 * means "at most 1h left", never "just over 0".
 */
function formatRateLimitMessage(retryAfterMs: unknown): string {
  const ms = typeof retryAfterMs === "number" && retryAfterMs > 0 ? retryAfterMs : 0;
  if (ms < MS_PER_HOUR) {
    return "Narrative refreshes once per day — available again in less than 1h.";
  }
  const hours = Math.ceil(ms / MS_PER_HOUR);
  return `Narrative refreshes once per day — available again in about ${hours}h.`;
}

export function NarrativeBlock({ scope, surfaceKey }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // POST is the generate path (#35 task 5): GET is a cache-read that returns
  // { notGenerated: true } on a miss and NEVER generates. handleRefresh is
  // reused both for the manual Refresh button and to auto-fill an empty cache
  // on first view. Routed through apiFetch (#35 task 9-12) since it's a mutating call.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await apiFetch("/api/analysis/narrative", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, surface: surfaceKey }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setText(data.narrativeMd);
        setGeneratedAt(data.generatedAt ?? null);
      } else if (res.status === 429) {
        // The bare "rate-limited" token means nothing to a user — explain the
        // 24h window in domain language and surface the actual wait time.
        setRefreshError(formatRateLimitMessage(data.retryAfter));
      } else {
        // Honest failure surface — never swallow, never silently revert
        // (nothing was optimistically changed above, so the stale narrative
        // simply stays visible alongside this).
        setRefreshError(data.error ?? "Refresh failed");
      }
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, [scope, surfaceKey]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setRefreshError(null); // don't let a prior scope's refresh error bleed onto the new scope
    fetch(`/api/analysis/narrative?scope=${scope}&surface=${surfaceKey}`)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        if (data.success && data.narrativeMd) {
          setText(data.narrativeMd);
          setGeneratedAt(data.generatedAt ?? null);
        } else if (data.success && data.notGenerated) {
          // Cache is empty — auto-generate once via the POST path (GET no
          // longer generates-on-miss). Same call the Refresh button makes.
          void handleRefresh();
        } else if (!data.success) {
          setError(data.error ?? "Failed to load narrative");
        }
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Failed to load narrative"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [scope, surfaceKey, handleRefresh]);

  if (loading || (refreshing && !text))
    return <div className="text-xs text-ink-faint italic mt-2">Loading narrative…</div>;
  if (error || !text) return null; // graceful no-render on error

  // formatGeneratedAt returns null for an unparseable timestamp — hide the
  // caption rather than render "Invalid Date".
  const generatedLabel = generatedAt ? formatGeneratedAt(generatedAt) : null;

  return (
    <div className="text-sm text-ink-dim italic border-l-2 border-gold/40 pl-3 my-3 leading-relaxed">
      {/* AI narrative embeds portfolio-derived figures at generation time, so
          the only correct mask is the whole prose block (same rule as the
          interpretation sentences). */}
      <PrivateText>{text}</PrivateText>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 not-italic">
        {generatedLabel && (
          <span className="text-xs text-ink-faint">
            Generated {generatedLabel}
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
