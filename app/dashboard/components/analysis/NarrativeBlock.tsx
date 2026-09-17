"use client";

import { useCallback, useEffect, useState } from "react";
import { PrivateText } from "@/lib/privacy/components";
import { formatGeneratedAt, parseDbTimestamp } from "@/lib/calendar/date-utils";
import apiFetch from "@/lib/http/apiFetch";
import {
  describeRefreshFailure,
  NARRATIVE_SUBJECT,
} from "./refresh-failure-message";

interface Props {
  scope: string;
  surfaceKey: "factor-analysis" | "risk-metrics" | "position-risk" | "factor-heatmap" | "defense";
}

const MS_PER_MINUTE = 60 * 1000;

/**
 * Age of the cached prose in plain relative language ("3 days ago"). Used only
 * in the drift banner, where "how stale is this" is the point — the neutral
 * caption below the prose keeps the absolute ET date.
 *
 * Returns null for an unparseable stamp so the caller can drop the clause
 * rather than print "Invalid Date".
 */
function formatRelativeAge(raw: string | null): string | null {
  if (!raw) return null;
  const d = parseDbTimestamp(raw);
  if (!d) return null;
  const minutes = Math.floor((Date.now() - d.getTime()) / MS_PER_MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * What actually stopped matching. The defense surface gets the concrete
 * wording from the finding that prompted this (the cached narrative asserted
 * 30% protection against an 11% card, and advised on a SPY put that had left
 * the book); every other surface gets the general form.
 */
function driftDetail(surfaceKey: Props["surfaceKey"]): string {
  return surfaceKey === "defense"
    ? "the hedge book or coverage numbers no longer match"
    : "the numbers on this card no longer match";
}

export type NarrativeRenderState = "loading" | "hidden" | "cold-failure" | "narrative";

/**
 * Pure render-state decision, extracted so the QA finding
 * (analysis-defense-narrative--auto-generation-500-card-vanishes-no-error-no-retry)
 * can be pinned by a unit test — this repo has no jsdom/RTL harness to render
 * the component itself.
 *
 * The bug: a cold cache (GET returns {notGenerated:true}) auto-fires the
 * generate POST. When that POST fails, `refreshError` gets set but `text`
 * stays null — the old render guard combined "error is set" OR "no text yet"
 * into one bare no-render, so the missing-text arm fired and removed the
 * whole card even though no GET-level `error` existed. A paid AI generation
 * attempt left no message, no retry button, and a reload paid for another.
 *
 * `error` (the initial GET failing outright) still hides the card — that
 * failure mode is unchanged here; this only adds a state for the case GET
 * succeeded (possibly with notGenerated) but the follow-up POST did not.
 */
export function narrativeRenderState({
  text,
  error,
  refreshError,
  loading,
  refreshing,
}: {
  text: string | null;
  error: string | null;
  refreshError: string | null;
  loading: boolean;
  refreshing: boolean;
}): NarrativeRenderState {
  if (loading || (refreshing && !text)) return "loading";
  // A failed scope load must not reveal text retained from the previous scope.
  if (error) return "hidden";
  if (text) return "narrative";
  return refreshError ? "cold-failure" : "hidden";
}

export function NarrativeBlock({ scope, surfaceKey }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Which control started the refresh, so the outcome renders under the
  // button the user actually pressed. The drift banner's button is ~128px
  // above the footer line where the status used to be its ONLY home, with
  // the whole narrative in between — the reason a rate-limited click read
  // as "the button does nothing" (QA 2026-09-07). "footer" is also the
  // resting value for the auto-fill call the effect makes on an empty cache.
  const [refreshOrigin, setRefreshOrigin] = useState<"banner" | "footer">("footer");
  // The cached prose was generated from inputs that have since changed
  // (migration 087). We keep showing it — hiding it would trade a stale
  // reading for no reading — but say so plainly, right above it.
  const [drifted, setDrifted] = useState(false);

  // POST is the generate path (#35 task 5): GET is a cache-read that returns
  // { notGenerated: true } on a miss and NEVER generates. handleRefresh is
  // reused both for the manual Refresh button and to auto-fill an empty cache
  // on first view. Routed through apiFetch (#35 task 9-12) since it's a mutating call.
  const handleRefresh = useCallback(async (origin: "banner" | "footer" = "footer") => {
    setRefreshing(true);
    setRefreshError(null);
    setRefreshOrigin(origin);
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
        // Regenerated against the current book — the banner has to clear, or
        // the user refreshes forever chasing a warning that never goes away.
        setDrifted(data.drifted === true);
      } else {
        // Honest failure surface — never swallow, never silently revert
        // (nothing was optimistically changed above, so the stale narrative
        // simply stays visible alongside this). One helper covers the
        // rate limit and every other non-OK status, so no response can
        // reach the card as a bare token or as nothing at all.
        setRefreshError(describeRefreshFailure(NARRATIVE_SUBJECT, res.status, data));
      }
    } catch {
      // Network-level failure (offline, server restarting mid-click). The
      // browser's raw message ("Failed to fetch") is not domain language.
      setRefreshError(describeRefreshFailure(NARRATIVE_SUBJECT, 0, null));
    } finally {
      setRefreshing(false);
    }
  }, [scope, surfaceKey]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setRefreshError(null); // don't let a prior scope's refresh error bleed onto the new scope
    setDrifted(false); // ...nor a prior scope's drift banner onto the new scope
    fetch(`/api/analysis/narrative?scope=${scope}&surface=${surfaceKey}`)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        if (data.success && data.narrativeMd) {
          setText(data.narrativeMd);
          setGeneratedAt(data.generatedAt ?? null);
          setDrifted(data.drifted === true);
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

  const renderState = narrativeRenderState({ text, error, refreshError, loading, refreshing });

  if (renderState === "loading")
    return <div className="text-xs text-ink-faint italic mt-2">Loading narrative…</div>;
  if (renderState === "cold-failure") {
    // Cold cache (GET returned notGenerated) auto-fired the generate POST and
    // that POST failed — say so plainly instead of vanishing the card, since
    // the auto-fire already spent a paid AI call and a silent reload would
    // spend another one chasing a message that never arrives.
    return (
      <div
        role="alert"
        className="not-italic text-xs text-warn mt-2 flex flex-wrap items-center gap-x-2 gap-y-1"
      >
        <span>{refreshError}</span>
        <button
          type="button"
          onClick={() => handleRefresh("footer")}
          disabled={refreshing}
          aria-label="Try generating the narrative again"
          className="font-medium underline decoration-dotted underline-offset-2 hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {refreshing ? "Refreshing…" : "Try again"}
        </button>
      </div>
    );
  }
  if (renderState === "hidden" || !text) return null; // graceful no-render: nothing generated, no attempt to explain

  // formatGeneratedAt returns null for an unparseable timestamp — hide the
  // caption rather than render "Invalid Date".
  const generatedLabel = generatedAt ? formatGeneratedAt(generatedAt) : null;
  const relativeAge = formatRelativeAge(generatedAt);

  return (
    <div className="text-sm text-ink-dim italic border-l-2 border-gold/40 pl-3 my-3 leading-relaxed">
      {drifted && (
        <div
          role="status"
          className="not-italic text-xs text-warn border border-warn/40 bg-warn/10 rounded px-2 py-1.5 mb-2 leading-snug flex flex-wrap items-center gap-x-2 gap-y-1"
        >
          <span>
            Inputs changed since this was generated
            {relativeAge ? ` ${relativeAge}` : ""} — {driftDetail(surfaceKey)}.
          </span>
          {/* Refresh right where the banner is read — the footer control
              (below the full prose block) is ~128px away with the whole
              narrative in between. Same handler/state as the footer button,
              styled to match its underline-dotted convention. */}
          <button
            type="button"
            onClick={() => handleRefresh("banner")}
            disabled={refreshing}
            aria-label="Refresh narrative now"
            className="text-xs text-warn font-medium underline decoration-dotted underline-offset-2 hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {refreshing ? "Refreshing…" : "Refresh to regenerate"}
          </button>
          {/* basis-full puts the outcome on its own line directly under the
              button inside this same banner, so the only remedy the banner
              offers can never fail silently. */}
          {refreshError && refreshOrigin === "banner" && (
            <span className="basis-full text-xs text-warn" role="alert">
              {refreshError}
            </span>
          )}
        </div>
      )}
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
          onClick={() => handleRefresh("footer")}
          disabled={refreshing}
          aria-label="Refresh narrative"
          className="text-xs text-ink-dim underline decoration-dotted underline-offset-2 hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        {refreshError && refreshOrigin === "footer" && (
          <span className="text-xs text-warn" role="alert">
            {refreshError}
          </span>
        )}
      </div>
    </div>
  );
}
