"use client";

import { useEffect, useRef, useState } from "react";
import { MacroThemeReceiptDrawer } from "./MacroThemeReceiptDrawer";
import apiFetch from "@/lib/http/apiFetch";
import { Pct } from "@/lib/privacy/components";
import {
  describeRefreshFailure,
  isExpectedRefreshState,
  MACRO_THEMES_SUBJECT,
} from "./refresh-failure-message";

interface MacroTheme {
  name: string;
  factor_label: string;
  direction: "risk-on" | "risk-off" | "neutral";
  summary: string;
  exposure_bucket: "low" | "moderate" | "high" | "very-high";
  /** 0-100. Absent on a theme cached before the figure was stored. */
  exposure_pct?: number;
  exposure_rank?: "highest" | "lowest" | null;
  top_contributors: Array<{ symbol: string; weight: number }>;
}

interface ApiResponse {
  success: boolean;
  themes?: MacroTheme[] | null;
  sourceSummary?: {
    articles: Array<{ id: number; title: string }>;
    events: Array<{ id: number; symbol: string | null; event_date: string; title?: string; event_type?: string }>;
    alerts: Array<{ id: number; symbol: string }>;
  } | null;
  underThreshold?: boolean;
  notGenerated?: boolean;
  generatedAt?: string;
  fromCache?: boolean;
  error?: string;
  /** Generate failed because the AI service is unavailable (5xx / unreachable). */
  unavailable?: boolean;
  /** ms left on the POST route's window — only present on a 429. */
  retryAfter?: number;
  /** Which of the POST route's two limits fired — only present on a 429. */
  reason?: "daily" | "last_attempt_failed";
  /**
   * Client-side only: this failure is an EXPECTED state (a rate limit), not a
   * breakage, so it renders neutrally rather than in the loss colour.
   */
  expected?: boolean;
  /** Client-side only: the generate call failed, so "Try again" repeats it. */
  generateFailed?: boolean;
}

const FACTOR_LABELS: Record<string, string> = {
  interest_rate_sensitive: "Rate-sensitive",
  growth_vs_value: "Growth vs value",
  cyclical: "Cyclicality",
  international_exposure: "International",
  geopolitical_onshoring: "Onshoring",
  tariff_exposure: "Tariff",
  ai_exposure: "AI",
  crypto_adjacent: "Crypto-adjacent",
  regulatory_risk: "Regulatory",
};

/**
 * The names under a theme are the FACTOR's largest holdings, not the theme's:
 * two themes on one factor print the same names by construction. The label
 * says whose list it is so the repeat reads as intended.
 */
export function topContributorsLabel(factorLabel: string): string {
  return `top ${FACTOR_LABELS[factorLabel] ?? factorLabel} holdings`;
}

function directionColor(d: MacroTheme["direction"]) {
  if (d === "risk-on") return "var(--up, #10b981)";
  if (d === "risk-off") return "var(--down, #ef4444)";
  return "var(--ink-faint, #94a3b8)";
}

// The pill is coloured by the theme's place among THIS WEEK's themes, not by
// an absolute bucket: every factor tilt on a diversified book cleared the top
// bucket, so all five cards read "very-high" (owner ruling, QA finding
// analysis-macro-themes--exposure-badge-always-very-high).
export function exposurePillClass(rank: MacroTheme["exposure_rank"]) {
  if (rank === "highest") return "bg-amber/20 text-amber border-amber/30";
  if (rank === "lowest") return "bg-edge/20 text-ink-faint border-edge/40";
  return "bg-edge/40 text-ink-dim border-edge";
}

/** The relative marker beside the percentage, or null when there is none. */
export function exposureRankLabel(rank: MacroTheme["exposure_rank"]): string | null {
  if (rank === "highest") return "highest this week";
  if (rank === "lowest") return "lowest this week";
  return null;
}

/**
 * A theme cached before the percentage was stored has no figure to show. The
 * old bucket word is not a fallback (it is the thing the ruling dropped), so
 * such a theme renders no pill until the week's themes are next generated.
 */
export function hasExposureFigure(t: Pick<MacroTheme, "exposure_pct">): boolean {
  return typeof t.exposure_pct === "number" && Number.isFinite(t.exposure_pct);
}

/**
 * What a cold cache shows. Nothing has been generated for this scope this
 * week, and opening the page must not spend an AI call to change that: the
 * card says so and offers the one button that does.
 */
export const MACRO_COLD_CACHE_COPY = "No themes generated yet for this scope this week.";
export const MACRO_GENERATE_LABEL = "Generate this week's themes";
export const MACRO_GENERATE_TITLE = "Generates this week's themes with one AI call";

/** True when the cache read came back empty and nothing has been generated. */
export function isMacroColdCache(
  data: { success?: boolean; notGenerated?: boolean } | null,
): boolean {
  return data?.success === true && data.notGenerated === true;
}

export function MacroOverlayCard({ scope }: { scope: string }) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [drawerOpenForThemeIdx, setDrawerOpenForThemeIdx] = useState<number | null>(null);
  // Bumped only by the manual "Try again" button — never automatically.
  const [retryNonce, setRetryNonce] = useState(0);
  // The scope on screen now, so a generate reply for a scope the user has
  // since left never lands on the new one.
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  // The paid-AI write path. It runs ONLY from a click (the cold-cache button
  // or "Try again" after a failed generate) — never from the mount effect
  // below. Routed through apiFetch (#35 task 9-12) since it's a mutating call.
  const handleGenerate = async () => {
    const requestedScope = scope;
    setGenerating(true);
    const generate = async (): Promise<ApiResponse> => {
      const res = await apiFetch("/api/analysis/macro-themes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: requestedScope }),
      });
      const json = (await res.json()) as ApiResponse;
      if (res.ok && json.success) return json;
      // The route answers a rate limit with a bare API token; dropping
      // res.status made that token the entire card body (2026-09-10 QA). The
      // shared translator turns every failure — the once-a-day limit, the short
      // cooldown after a failed attempt, and any other status — into the same
      // domain language NarrativeBlock uses.
      const fallback = describeRefreshFailure(MACRO_THEMES_SUBJECT, res.status, json);
      const routeMessage =
        res.status !== 429 && typeof json.error === "string" && json.error.trim() !== ""
          ? json.error
          : null;
      return {
        ...json,
        success: false,
        generateFailed: true,
        expected: isExpectedRefreshState(res.status),
        unavailable: res.status >= 500,
        // A non-429 route message is written for a reader (the themes-parse
        // failures); anything missing falls back to the shared sentence.
        error: routeMessage ?? fallback,
      };
    };
    let final: ApiResponse;
    try {
      final = await generate();
    } catch {
      final = {
        success: false,
        generateFailed: true,
        unavailable: true,
        error: describeRefreshFailure(MACRO_THEMES_SUBJECT, 0, null),
      };
    }
    if (scopeRef.current === requestedScope) setData(final);
    setGenerating(false);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // GET is a side-effect-free cache read (#35 task 5). On a miss it returns
    // { notGenerated: true } and the card stops there, showing the cold-cache
    // state: no AI call is made until the button is pressed.
    (async () => {
      try {
        const getRes = await fetch(
          `/api/analysis/macro-themes?scope=${encodeURIComponent(scope)}`,
        );
        const j = (await getRes.json()) as ApiResponse;
        if (!cancelled) setData(j);
      } catch {
        // Network-level failure (offline, server restarting mid-load). "network
        // error" is a protocol word, not domain language — status 0 is the
        // shared helper's "the request never completed" branch.
        if (!cancelled) {
          setData({
            success: false,
            unavailable: true,
            error: describeRefreshFailure(MACRO_THEMES_SUBJECT, 0, null),
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scope, retryNonce]);

  return (
    <section className="bg-panel border border-edge rounded-lg p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-medium text-ink">Macro this week</h3>
          <p className="text-xs text-ink-faint mt-0.5">
            AI-distilled themes from research feeds + macro releases
            <span className="ml-2 italic">· {scope}</span>
          </p>
        </div>
        {data?.generatedAt && (
          <span className="text-[10px] text-ink-faint uppercase tracking-wider">
            {data.fromCache ? "cached" : "fresh"}
          </span>
        )}
      </header>

      {loading && (
        <div className="rounded-lg border border-edge/40 bg-canvas px-3 py-6 text-center">
          <p className="text-xs text-ink-faint">Loading…</p>
        </div>
      )}

      {!loading && isMacroColdCache(data) && (
        <div className="rounded-lg border border-edge/40 bg-canvas px-3 py-6 text-center">
          <p className="text-xs text-ink-faint">{MACRO_COLD_CACHE_COPY}</p>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            title={MACRO_GENERATE_TITLE}
            className="relative mt-2 text-xs font-medium text-amber underline decoration-dotted underline-offset-2 hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-2"
          >
            {generating ? "Generating…" : MACRO_GENERATE_LABEL}
          </button>
        </div>
      )}

      {!loading && data?.underThreshold && (
        <div className="rounded-lg border border-edge/40 bg-canvas px-3 py-6 text-center">
          <p className="text-xs text-ink-faint">
            No actionable themes this week — insufficient signal.
          </p>
        </div>
      )}

      {!loading && data?.themes && data.themes.length > 0 && (
        <ul className="space-y-2">
          {data.themes.map((t, i) => (
            <li key={i} className="rounded-lg border border-edge/60 bg-canvas px-3 py-2.5">
              <div className="flex items-baseline gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-full mt-1.5 shrink-0"
                  style={{ backgroundColor: directionColor(t.direction) }}
                />
                <h4 className="text-sm font-medium text-ink flex-1">{t.name}</h4>
                {hasExposureFigure(t) && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${exposurePillClass(t.exposure_rank)} uppercase tracking-wide`}
                    title="Value-weighted share of this scope's holdings exposed to this theme's factor, scaled by how strongly each holding is tagged"
                  >
                    your exposure: <Pct value={t.exposure_pct} digits={0} />
                    {exposureRankLabel(t.exposure_rank) && ` · ${exposureRankLabel(t.exposure_rank)}`}
                  </span>
                )}
              </div>
              <p className="text-xs text-ink-dim mt-1 ml-4">{t.summary}</p>
              <div className="mt-2 ml-4 flex items-center gap-3 text-[11px]">
                <span className="text-ink-faint">
                  factor: {FACTOR_LABELS[t.factor_label] ?? t.factor_label}
                </span>
                {t.top_contributors.length > 0 && (
                  <span className="text-ink-faint">
                    {topContributorsLabel(t.factor_label)}: {t.top_contributors.map((c) => c.symbol).join(", ")}
                  </span>
                )}
                {data.sourceSummary != null ? (
                  <button
                    type="button"
                    onClick={() => setDrawerOpenForThemeIdx(i)}
                    className="relative ml-auto text-amber hover:text-amber/80 transition-colors pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-2"
                  >
                    {"This week's inputs →"}
                  </button>
                ) : (
                  // The receipt drawer only renders with a sourceSummary; a
                  // cached theme without one would make the button a dead
                  // click, so say why there is nothing to open instead.
                  <span className="ml-auto text-ink-faint italic">
                    no sources recorded
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!loading && data && !data.success && !data.underThreshold && (
        // A rate limit is the product working as designed, so it renders in the
        // neutral empty-state treatment (same as the under-threshold box) with
        // role="status"; only a real breakage gets the loss colour and an alert.
        <div
          role={data.expected ? "status" : "alert"}
          className={`rounded-lg border bg-canvas px-3 py-3 text-center ${
            data.expected ? "border-edge/40" : "border-down/40"
          }`}
        >
          <p className={`text-xs ${data.expected ? "text-ink-faint" : "text-down"}`}>
            {data.unavailable
              ? "AI narrative unavailable right now."
              : (data.error ?? "Failed to load macro themes")}
          </p>
          {/* A failed generate repeats the generate (the user already asked
              for it); a failed load re-reads the cache. */}
          {!data.expected && (
            <button
              type="button"
              onClick={() => (data.generateFailed ? handleGenerate() : setRetryNonce((n) => n + 1))}
              disabled={generating}
              className="relative mt-2 text-xs font-medium text-amber underline decoration-dotted underline-offset-2 hover:brightness-110 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-2"
            >
              Try again
            </button>
          )}
        </div>
      )}

      {drawerOpenForThemeIdx !== null && data?.sourceSummary && data.themes && (
        <MacroThemeReceiptDrawer
          sourceSummary={data.sourceSummary}
          onClose={() => setDrawerOpenForThemeIdx(null)}
        />
      )}
    </section>
  );
}
