"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import apiFetch from "@/lib/http/apiFetch";

type Layout = "structured" | "by_source" | "by_company";

interface DigestPreviewResponse {
  success: boolean;
  since: string;
  empty: boolean;
  structuredHtml: string | null;
  bySourceHtml: string | null;
  byCompanyHtml: string | null;
}

interface DigestEmailViewerProps {
  open: boolean;
  onClose: () => void;
  /** Optional — overrides the server's default last-sent / 24h window. */
  since?: string;
}

/**
 * Modal that renders the morning digest two ways and lets the user toggle
 * between by-source and by-company layouts client-side. Mirrors the
 * EarningsEmailViewer pattern (portal + iframe + escape-key).
 *
 * Source of truth for content: GET /api/digest/preview returns both
 * pre-rendered HTML payloads in one call.
 */
export function DigestEmailViewer({ open, onClose, since }: DigestEmailViewerProps) {
  const [data, setData] = useState<DigestPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The STRUCTURED layout is the paid-AI synthesis, produced only by POST
  // (#35 task 5: GET is a side-effect-free read of the two deterministic
  // renderings). genLoading covers the extra POST round-trip.
  const [genLoading, setGenLoading] = useState(false);
  const [layout, setLayout] = useState<Layout>("structured");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setGenLoading(false);
    setError(null);
    setData(null);

    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    const url = `/api/digest/preview${qs}`;

    (async () => {
      try {
        // 1) GET — instant paint of by-publication / by-company (no AI, no write).
        const getRes = await fetch(url);
        if (!getRes.ok) {
          const body = (await getRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${getRes.status}`);
        }
        const getData = (await getRes.json()) as DigestPreviewResponse;
        if (cancelled) return;
        setData(getData);
        if (getData.bySourceHtml) setLayout("by_source");
        else if (getData.byCompanyHtml) setLayout("by_company");
        setLoading(false);

        // 2) POST — generate the structured (synthesis) layout. Routed through
        //    apiFetch (#35 task 9-12) since it's a mutating call. This is
        //    authoritative for `empty` (it accounts for alert-only windows the
        //    GET can miss).
        setGenLoading(true);
        const postRes = await apiFetch(url, { method: "POST" });
        if (!postRes.ok) return; // keep the deterministic views; structured stays unavailable
        const postData = (await postRes.json()) as DigestPreviewResponse;
        if (cancelled) return;
        setData(postData);
        if (postData.structuredHtml) setLayout("structured");
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load digest.");
      } finally {
        if (!cancelled) {
          setLoading(false);
          setGenLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, since]);

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
          className="sticky top-0 z-10 flex items-baseline justify-between px-5 py-3.5 border-b border-edge backdrop-blur-sm rounded-t-xl gap-3"
          style={{ backgroundColor: "var(--panel)" }}
        >
          <div className="flex flex-col min-w-0">
            <h2 className="text-sm font-medium text-ink truncate whitespace-nowrap!">Morning Research Digest</h2>
            {data && !data.empty && (
              <p className="text-[11px] text-ink-faint font-mono mt-0.5 truncate">
                Since {formatSince(data.since)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex rounded-md border border-edge overflow-hidden text-[11px]">
              <button
                type="button"
                onClick={() => setLayout("structured")}
                disabled={!data?.structuredHtml}
                className={`px-2.5 py-1 ${
                  layout === "structured"
                    ? "bg-gold/15 text-gold-ink"
                    : "text-ink-dim hover:bg-raised disabled:opacity-40"
                }`}
              >
                Structured
              </button>
              <button
                type="button"
                onClick={() => setLayout("by_source")}
                disabled={!data?.bySourceHtml}
                className={`px-2.5 py-1 border-l border-edge ${
                  layout === "by_source"
                    ? "bg-gold/15 text-gold-ink"
                    : "text-ink-dim hover:bg-raised disabled:opacity-40"
                }`}
              >
                By publication
              </button>
              <button
                type="button"
                onClick={() => setLayout("by_company")}
                disabled={!data?.byCompanyHtml}
                className={`px-2.5 py-1 border-l border-edge ${
                  layout === "by_company"
                    ? "bg-gold/15 text-gold-ink"
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
          {data?.empty && (
            <div className="px-5 py-12 text-center text-[14px] text-ink-faint">
              No articles or alerts in the selected window.
            </div>
          )}
          {data && !data.empty && activeHtml && (
            <iframe
              title="Morning Research Digest"
              srcDoc={activeHtml}
              className="w-full block border-0 rounded-b-xl"
              style={{ height: "75vh", backgroundColor: "#1a1a1a" }}
              sandbox="allow-same-origin"
            />
          )}
          {data && !data.empty && !activeHtml && layout === "structured" && genLoading && (
            <div className="px-5 py-12 text-center text-[14px] text-ink-faint">
              Generating structured view…
            </div>
          )}
          {data && !data.empty && !activeHtml && !(layout === "structured" && genLoading) && (
            <div className="px-5 py-12 text-center text-[14px] text-ink-faint">
              {layout === "structured" ? "Structured" : layout === "by_source" ? "By-publication" : "By-company"} view unavailable.
              {otherAvailable && (
                <button
                  type="button"
                  onClick={() => setLayout(layout === "structured" ? "by_source" : layout === "by_source" ? "by_company" : "structured")}
                  className="block mx-auto mt-3 text-[12px] text-gold-ink hover:text-gold/80"
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

function formatSince(iso: string): string {
  if (!iso) return "—";
  // Accept either YYYY-MM-DD or full ISO. Render as compact local-date string.
  const dateOnly = iso.length <= 10 ? iso : iso.slice(0, 10);
  const d = new Date(`${dateOnly}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
