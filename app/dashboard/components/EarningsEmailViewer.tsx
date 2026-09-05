"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ScrollFade } from "./ScrollFade";
import { EMAIL_FRAME_SANDBOX, withExternalLinkTarget } from "@/lib/email/archive-srcdoc";

export interface EmailContentResponse {
  title: string;
  sentAt: string;
  sentTo: string;
  eventDate: string;
  symbol: string;
  phase: "preview" | "recap";
  /** "cloud" = Worker fallback delivered this one — no local ai_output_md copy exists. */
  sentBy?: "local" | "cloud";
  /**
   * Additive — older payloads (and the inline-compose shape below, which
   * never sets it) may lack the field. "sent-by-cloud" and
   * "delivery-unknown" ALSO need to widen `sentBy`'s "local" answer:
   * `sentBy` says who attempted the send, this says whether it is known to
   * have arrived. A `sentBy === "local"` row can still be
   * "delivery-unknown" — see lib/earnings/email-states.ts.
   */
  deliveryState?: "sent" | "sent-by-cloud" | "delivery-unknown";
  fullHtml: string;
}

/**
 * Pure header block for the email viewer modal. Pulled out of
 * EarningsEmailViewer (which fetches in a useEffect and has no
 * fixture-driven render path) so it can be exercised directly with
 * react-dom/server in tests — see
 * tests/dashboard/earnings-email-viewer-delivery-state.test.ts.
 */
export function EmailViewerHeader({ data }: { data: EmailContentResponse | null }) {
  return (
    <div className="flex flex-col min-w-0">
      <h2 className="text-sm font-medium text-ink truncate whitespace-nowrap!">
        {data?.title ?? "Earnings email"}
      </h2>
      {data && data.sentAt && data.sentTo && (
        <p className="text-[11px] text-ink-faint font-mono mt-0.5 truncate">
          {data.deliveryState === "delivery-unknown" ? "Delivery unknown" : "Sent"}{" "}
          {formatSentAt(data.sentAt)} ET to {data.sentTo}
        </p>
      )}
      {data && !data.sentAt && (
        <p className="text-[11px] text-ink-faint font-mono mt-0.5 truncate">
          Live preview — not sent
        </p>
      )}
      {data && data.sentBy === "cloud" && (
        <p className="text-[11px] text-gold-ink font-mono mt-0.5 truncate">
          Delivered by cloud fallback — no local copy of the prose (scoreboard below is
          still live-rebuilt)
        </p>
      )}
      {data && data.deliveryState === "delivery-unknown" && (
        <p className="text-[11px] text-gold-ink font-mono mt-0.5 truncate">
          The provider never confirmed this email was delivered — check the mailbox or the
          Resend log for the message id before sending it again.
        </p>
      )}
    </div>
  );
}

/**
 * In-app preview shape used by the "Generate" button on EarningsRowChips.
 * No sentAt/sentTo — this is a fresh compose, not a sent-email recall.
 */
export interface InlineEmailData {
  title: string;
  fullHtml: string;
  symbol: string;
  eventDate: string | null;
  phase: "preview" | "recap";
}

interface EarningsEmailViewerProps {
  eventId: number;
  phase: "preview" | "recap";
  open: boolean;
  onClose: () => void;
  /** When provided, renders this content directly and skips the API fetch. */
  inlineData?: InlineEmailData | null;
}

/**
 * Modal that renders a previously-sent earnings email in-app via iframe.
 *
 * The full HTML (scoreboard rebuilt from current calendar_events fields +
 * AI prose from earnings_emails.ai_output_md) is fetched on open and
 * srcDoc'd into an iframe so the email-specific styling stays isolated
 * from the app's global CSS.
 *
 * Source links inside the archived body open in the system browser / a new
 * tab, never in the frame — see lib/email/archive-srcdoc.ts for why the
 * sandbox alone could not prevent that.
 */
export function EarningsEmailViewer({
  eventId,
  phase,
  open,
  onClose,
  inlineData,
}: EarningsEmailViewerProps) {
  const [data, setData] = useState<EmailContentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    // When inlineData is provided, skip the fetch — the parent already
    // composed the content (e.g. via /api/earnings/recap-modal).
    if (inlineData) {
      setData({
        title: inlineData.title,
        sentAt: "",
        sentTo: "",
        eventDate: inlineData.eventDate ?? "",
        symbol: inlineData.symbol,
        phase: inlineData.phase,
        fullHtml: inlineData.fullHtml,
      });
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/api/earnings/email-content?eventId=${eventId}&phase=${phase}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<EmailContentResponse>;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load email.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, eventId, phase, inlineData]);

  // Escape key closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-4xl mx-auto my-8 electron:mt-12 max-h-[85dvh] overflow-y-auto rounded-xl border border-edge bg-panel shadow-2xl">
        {/* Sticky header */}
        <div className="sticky top-0 z-10 flex items-baseline justify-between px-5 py-3.5 border-b border-edge bg-panel/95 backdrop-blur-sm rounded-t-xl gap-3">
          <EmailViewerHeader data={data} />
          <button
            onClick={onClose}
            className="relative text-ink-faint hover:text-ink text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-raised shrink-0 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
            aria-label="Close email viewer"
          >
            ✕
          </button>
        </div>

        {/* Body — iframe wrapper is separately capped (max-h-[85dvh]) and
            scrolls internally: the panel above is already bounded, but the
            iframe's own inline height (75vh) can exceed what's left after
            the sticky header, so the wrapper needs its own scroll region
            rather than relying on the outer overlay's page-level scroll. */}
        <div className="p-0 min-h-[300px] max-h-[85dvh] overflow-y-auto">
          {loading && (
            <div className="px-5 py-12 text-center text-[14px] text-ink-faint">
              Loading email…
            </div>
          )}
          {error && (
            <div className="px-5 py-12 text-center text-[14px] text-down">
              {error}
            </div>
          )}
          {data && (
            /* The email's scoreboard table has a min-content width of ~820px
               (fixed-width columns for print-and-fill), wider than both the
               old max-w-3xl modal (768px) and any phone. Give the iframe that
               natural width and let ScrollFade own the horizontal overflow —
               without it the Δ (beat/miss) column silently clipped on desktop
               and EVERY number was off-screen at rest on mobile (2026-07-27
               sweep). */
            <ScrollFade>
              <iframe
                title={data.title}
                srcDoc={withExternalLinkTarget(data.fullHtml)}
                className="w-full min-w-[860px] block border-0 rounded-b-xl"
                style={{ height: "75dvh", backgroundColor: "#1a1a1a" }}
                sandbox={EMAIL_FRAME_SANDBOX}
              />
            </ScrollFade>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function formatSentAt(iso: string): string {
  // Audit row stores `YYYY-MM-DD HH:MM:SS` in UTC (SQLite datetime('now')).
  // Render as ET wall-clock for the user.
  const utc = iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z");
  const d = new Date(utc);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}
