"use client";

import { CHIP_TONE_TEXT } from "@/app/dashboard/components/chip-tone-text";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import apiFetch from "@/lib/http/apiFetch";
import { EMAIL_FRAME_SANDBOX, withExternalLinkTarget } from "@/lib/email/archive-srcdoc";
import {
  DIGEST_WINDOW_OPTIONS,
  digestPreviewSince,
  digestWindowNeedsDate,
  isDigestMode,
  type DigestWindowChoice,
} from "./digest-window-choice";

type Layout = "structured" | "by_source" | "by_company";

interface DigestPreviewResponse {
  success: boolean;
  since: string;
  empty: boolean;
  structuredHtml: string | null;
  bySourceHtml: string | null;
  byCompanyHtml: string | null;
  /**
   * Set by POST when the AI synthesis failed during THIS preview and the
   * Structured layout is the per-source fallback. Absent/null = no fallback.
   */
  synthesisFallback?: string | null;
  /**
   * Optional: the article cap of each layout, if the route reports it. The
   * caps live in server modules a client component must not import, so the
   * caption shows a number only when the response carries one.
   */
  caps?: { structured?: number; bySource?: number; byCompany?: number } | null;
}

/**
 * May the paid Structured generation start now? Only on a reader's click, never
 * twice for one open, never while one is running. A failure clears "attempted"
 * so the same click retries.
 */
export function shouldStartStructuredGeneration(state: {
  hasStructured: boolean;
  generating: boolean;
  attempted: boolean;
}): boolean {
  return !state.hasStructured && !state.generating && !state.attempted;
}

export type StructuredPane = "html" | "generating" | "failed" | "offer" | "none";

/** What the Structured tab shows. The tab is the trigger, never a dead control. */
export function structuredPaneState(state: {
  hasStructured: boolean;
  generating: boolean;
  failed: boolean;
  attempted: boolean;
}): StructuredPane {
  if (state.hasStructured) return "html";
  if (state.generating) return "generating";
  if (state.failed) return "failed";
  if (!state.attempted) return "offer";
  return "none";
}

/**
 * The GET cannot see alert-only windows, so its "empty" is not final. Until the
 * Structured view has been generated once this open, the empty state says so
 * and offers the click; after that the POST's answer is authoritative.
 */
export function emptyMayHideStructured(state: { attempted: boolean; generating: boolean }): boolean {
  return !state.attempted && !state.generating;
}

/** The caption beside "Since ..." naming the active tab's article cap, or "" when unknown. */
export function capCaption(layout: Layout, caps: DigestPreviewResponse["caps"]): string {
  const n = layout === "structured" ? caps?.structured : layout === "by_source" ? caps?.bySource : caps?.byCompany;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "";
  return `up to ${n} articles`;
}

/**
 * Where the layout lands when the Structured generation finishes. A reader who
 * chose a tab keeps it — Structured only becomes available. Without a choice
 * the modal moves to Structured (the layout the email sends).
 */
export function layoutAfterGeneration(
  current: Layout,
  userPicked: boolean,
  structuredReady: boolean,
): Layout {
  if (!structuredReady) return current;
  return userPicked ? current : "structured";
}

/** The empty state names the window that was evaluated. */
export function emptyWindowMessage(since: string | null | undefined): string {
  if (!since) return "No articles or alerts in the selected window.";
  return `No articles or alerts since ${formatSince(since)}.`;
}

interface DigestEmailViewerProps {
  open: boolean;
  onClose: () => void;
  /**
   * The window chosen for sending, held by the page and shared with the Send
   * panel. The preview loads this window and can change it.
   */
  digestWindow: DigestWindowChoice;
  onDigestWindowChange: (next: DigestWindowChoice) => void;
}

/**
 * Modal that renders the morning digest two ways and lets the user toggle
 * between by-source and by-company layouts client-side. Mirrors the
 * EarningsEmailViewer pattern (portal + iframe + escape-key).
 *
 * Source of truth for content: GET /api/digest/preview returns both
 * pre-rendered HTML payloads in one call.
 */
export function DigestEmailViewer({ open, onClose, digestWindow, onDigestWindowChange }: DigestEmailViewerProps) {
  // "Today" is the Eastern calendar day. No `since` = the server applies the
  // sender's since-last-email rule. A date mode with no date loads nothing.
  const since = digestPreviewSince(digestWindow);
  const needsDate = digestWindowNeedsDate(digestWindow);
  const [data, setData] = useState<DigestPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The STRUCTURED layout is the paid-AI synthesis, produced only by POST
  // (#35 task 5: GET is a side-effect-free read of the two deterministic
  // renderings). genLoading covers the extra POST round-trip.
  const [genLoading, setGenLoading] = useState(false);
  const [genFailed, setGenFailed] = useState(false);
  // True once a generation succeeded this open (even with no content): the
  // paid call is not repeated on a re-click. A failure clears it for a retry.
  const [attempted, setAttempted] = useState(false);
  // Guards a stale response after the modal closed or the window changed.
  const sessionRef = useRef(0);
  const generatingRef = useRef(false);
  const [layout, setLayout] = useState<Layout>("structured");
  // True once the reader clicks a layout tab; the generation finishing must
  // not move them off it. A ref: the POST continuation reads the latest value.
  const userPickedLayout = useRef(false);
  const pickLayout = (next: Layout) => {
    userPickedLayout.current = true;
    setLayout(next);
  };

  const previewUrl = () => {
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    return `/api/digest/preview${qs}`;
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const session = ++sessionRef.current;
    generatingRef.current = false;
    setLoading(true);
    setGenLoading(false);
    setGenFailed(false);
    setAttempted(false);
    userPickedLayout.current = false;
    setError(null);
    setData(null);

    if (needsDate) {
      setLoading(false);
      return () => {
        sessionRef.current++;
      };
    }

    (async () => {
      try {
        // GET only: by-publication / by-company (no AI, no write). The paid
        // Structured synthesis runs on the reader's click, never on open.
        const getRes = await fetch(previewUrl());
        if (!getRes.ok) {
          const body = (await getRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${getRes.status}`);
        }
        const getData = (await getRes.json()) as DigestPreviewResponse;
        if (cancelled) return;
        setData(getData);
        if (!userPickedLayout.current) {
          if (getData.bySourceHtml) setLayout("by_source");
          else if (getData.byCompanyHtml) setLayout("by_company");
        }
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load digest.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      sessionRef.current++;
    };
    // previewUrl closes over `since`, which is a dependency. A changed window
    // re-runs this: the old preview is wiped and an in-flight generation for
    // the old window is ignored when it lands (session check).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, since, needsDate]);

  // The paid AI call: one POST, started only by a click on the Structured tab
  // or its generate/retry control. Routed through apiFetch (mutating call).
  const generateStructured = async () => {
    if (needsDate) return;
    if (
      !shouldStartStructuredGeneration({
        hasStructured: Boolean(data?.structuredHtml),
        generating: generatingRef.current,
        attempted,
      })
    ) {
      return;
    }
    const session = sessionRef.current;
    generatingRef.current = true;
    setGenLoading(true);
    setGenFailed(false);
    try {
      const postRes = await apiFetch(previewUrl(), { method: "POST" });
      if (session !== sessionRef.current) return;
      if (!postRes.ok) {
        // keep the deterministic views; the click can try again
        setGenFailed(true);
        return;
      }
      const postData = (await postRes.json()) as DigestPreviewResponse;
      if (session !== sessionRef.current) return;
      setData(postData);
      setAttempted(true);
      setLayout((current) =>
        layoutAfterGeneration(current, userPickedLayout.current, Boolean(postData.structuredHtml)),
      );
    } catch {
      if (session === sessionRef.current) setGenFailed(true);
    } finally {
      if (session === sessionRef.current) {
        generatingRef.current = false;
        setGenLoading(false);
      }
    }
  };

  const openStructured = () => {
    pickLayout("structured");
    void generateStructured();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const activeHtml =
    layout === "structured" ? data?.structuredHtml
    : layout === "by_source" ? data?.bySourceHtml
    : data?.byCompanyHtml;
  const otherAvailable = Boolean(data?.structuredHtml || data?.bySourceHtml || data?.byCompanyHtml);
  // The POST is one AI call that can take about a minute; say so while it runs.
  const structuredGenerating = genLoading && !data?.structuredHtml;
  const structuredPane = structuredPaneState({
    hasStructured: Boolean(data?.structuredHtml),
    generating: structuredGenerating,
    failed: genFailed,
    attempted,
  });
  const capText = data ? capCaption(layout, data.caps) : "";

  return createPortal(
    <div
      className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-3xl mx-auto my-8 electron:mt-12 rounded-xl border border-edge bg-panel shadow-2xl">
        <div
          className="sticky top-0 z-10 flex flex-wrap items-baseline justify-between px-5 py-3.5 border-b border-edge backdrop-blur-sm rounded-t-xl gap-3"
          style={{ backgroundColor: "var(--panel)" }}
        >
          <div className="flex flex-col min-w-0 flex-1">
            <h2
              className="text-sm font-medium text-ink"
              title="Morning Research Digest"
            >
              Morning Research Digest
            </h2>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <select
                aria-label="Digest window"
                title="The same window the Email panel sends"
                value={digestWindow.mode}
                onChange={(e) => {
                  const mode = e.target.value;
                  if (isDigestMode(mode)) onDigestWindowChange({ ...digestWindow, mode });
                }}
                className="px-2 py-1 rounded-md bg-raised border border-edge text-xs text-ink"
              >
                {DIGEST_WINDOW_OPTIONS.map((o) => (
                  <option key={o.mode} value={o.mode}>
                    {o.label}
                  </option>
                ))}
              </select>
              {digestWindow.mode === "since_date" && (
                <input
                  type="date"
                  aria-label="Digest window start date"
                  value={digestWindow.sinceDate}
                  onChange={(e) => onDigestWindowChange({ ...digestWindow, sinceDate: e.target.value })}
                  className="px-2 py-1 rounded-md bg-raised border border-edge text-xs text-ink"
                />
              )}
            </div>
            {data && !data.empty && (
              <p className="text-[11px] text-ink-faint font-mono mt-1 truncate">
                Since {formatSince(data.since)}
                {capText ? ` · ${capText}` : ""}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex rounded-md border border-edge overflow-hidden text-[11px]">
              <button
                type="button"
                onClick={openStructured}
                disabled={!data}
                aria-busy={structuredGenerating}
                aria-label={structuredGenerating ? "Structured (generating)" : undefined}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 ${
                  layout === "structured"
                    ? `bg-gold/15 ${CHIP_TONE_TEXT.gold}`
                    : "text-ink-dim hover:bg-raised disabled:opacity-40"
                }`}
              >
                {structuredGenerating && (
                  <span
                    aria-hidden="true"
                    className="w-2.5 h-2.5 border-2 border-current border-t-transparent rounded-full animate-spin"
                  />
                )}
                Structured
              </button>
              <button
                type="button"
                onClick={() => pickLayout("by_source")}
                disabled={!data?.bySourceHtml}
                className={`px-2.5 py-1 border-l border-edge ${
                  layout === "by_source"
                    ? `bg-gold/15 ${CHIP_TONE_TEXT.gold}`
                    : "text-ink-dim hover:bg-raised disabled:opacity-40"
                }`}
              >
                By publication
              </button>
              <button
                type="button"
                onClick={() => pickLayout("by_company")}
                disabled={!data?.byCompanyHtml}
                className={`px-2.5 py-1 border-l border-edge ${
                  layout === "by_company"
                    ? `bg-gold/15 ${CHIP_TONE_TEXT.gold}`
                    : "text-ink-dim hover:bg-raised disabled:opacity-40"
                }`}
              >
                By company
              </button>
            </div>
            <button
              onClick={onClose}
              className="text-ink-faint hover:text-ink text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-raised shrink-0"
              aria-label="Close digest viewer"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="p-0 min-h-[300px]">
          {loading && (
            <div className="px-5 py-12 text-center text-[14px] text-ink-faint">Loading digest…</div>
          )}
          {error && (
            <div className="px-5 py-12 text-center text-[14px] text-down">{error}</div>
          )}
          {needsDate && (
            <div className="px-5 py-12 text-center text-[14px] text-warn">Choose a date first</div>
          )}
          {data?.empty && (
            <div className="px-5 py-12 text-center text-[14px] text-ink-faint">
              {emptyWindowMessage(data.since)}
              {emptyMayHideStructured({ attempted, generating: genLoading }) && (
                <div className="mt-3 text-[13px]">
                  The Structured view may still have content for this window (for example alerts only).
                  <button
                    type="button"
                    onClick={openStructured}
                    className="block mx-auto mt-3 text-[12px] text-gold-ink hover:underline"
                  >
                    Generate the Structured view (one AI call)
                  </button>
                </div>
              )}
              {data.empty && genLoading && (
                <div role="status" className="mt-3 text-[13px]">
                  Generating the Structured view (one AI call, about a minute)…
                </div>
              )}
              {genFailed && (
                <div role="status" className="mt-3 text-[13px] text-warn">
                  The Structured view could not be generated this time.
                  <button
                    type="button"
                    onClick={openStructured}
                    className="block mx-auto mt-2 text-[12px] text-gold-ink hover:underline"
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>
          )}
          {data && !data.empty && structuredGenerating && layout !== "structured" && (
            <div role="status" className="px-5 py-2 text-[12px] text-ink-dim border-b border-edge">
              Generating the Structured view (one AI call, about a minute). It opens on its tab when ready.
            </div>
          )}
          {data && !data.empty && genFailed && !data.structuredHtml && (
            <div role="status" className="px-5 py-2 text-[12px] text-warn border-b border-edge">
              The Structured view could not be generated this time. The other layouts are unaffected.
              <button type="button" onClick={openStructured} className="ml-2 text-gold-ink hover:underline">
                Try again
              </button>
            </div>
          )}
          {data && !data.empty && layout === "structured" && data.structuredHtml && data.synthesisFallback && (
            <div role="status" className="px-5 py-2 text-[12px] text-warn border-b border-edge">
              AI synthesis was unavailable for this preview, so this is the per-source fallback layout.
            </div>
          )}
          {data && !data.empty && activeHtml && (
            <iframe
              title="Morning Research Digest"
              srcDoc={withExternalLinkTarget(activeHtml)}
              className="w-full block border-0 rounded-b-xl"
              style={{ height: "75vh", backgroundColor: "#1a1a1a" }}
              sandbox={EMAIL_FRAME_SANDBOX}
            />
          )}
          {data && !data.empty && !activeHtml && layout === "structured" && structuredPane === "generating" && (
            <div className="px-5 py-12 text-center text-[14px] text-ink-faint">
              Generating structured view (one AI call, about a minute)…
            </div>
          )}
          {data && !data.empty && !activeHtml && layout === "structured" && structuredPane === "offer" && (
            <div className="px-5 py-12 text-center text-[14px] text-ink-faint">
              The Structured view is the AI-written layout the email sends. It runs one AI call, about a minute.
              <button
                type="button"
                onClick={openStructured}
                className="block mx-auto mt-3 text-[12px] text-gold-ink hover:underline"
              >
                Generate the Structured view (one AI call)
              </button>
            </div>
          )}
          {data && !data.empty && !activeHtml && layout === "structured" && structuredPane === "failed" && (
            <div className="px-5 py-12 text-center text-[14px] text-ink-faint">
              The Structured view could not be generated this time.
              <button
                type="button"
                onClick={openStructured}
                className="block mx-auto mt-3 text-[12px] text-gold-ink hover:underline"
              >
                Try again
              </button>
            </div>
          )}
          {data && !data.empty && !activeHtml && (layout !== "structured" || structuredPane === "none") && (
            <div className="px-5 py-12 text-center text-[14px] text-ink-faint">
              {layout === "structured" ? "Structured" : layout === "by_source" ? "By-publication" : "By-company"} view unavailable.
              {otherAvailable && (
                <button
                  type="button"
                  onClick={() => pickLayout(layout === "structured" ? "by_source" : layout === "by_source" ? "by_company" : "structured")}
                  className="block mx-auto mt-3 text-[12px] text-gold-ink hover:underline"
                >
                  Switch to the other view →
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function formatSince(iso: string): string {
  if (!iso) return "—";
  // A bare YYYY-MM-DD is a calendar date: render it as written.
  if (iso.length <= 10) {
    const d = new Date(`${iso}T00:00:00`);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  // A full timestamp (the last-sent marker) is an instant: show its Eastern
  // date AND time. A date alone hides why same-day articles are outside it.
  const t = new Date(iso);
  if (isNaN(t.getTime())) return iso;
  const text = t.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${text} ET`;
}
