"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ScrollFade } from "./ScrollFade";
import { usePrivacy } from "@/lib/privacy/context";
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
  /**
   * Additive, recap only — the UTC instant the scoreboard's reaction legs
   * were measured at (reaction_snapshot t0 + its window), sent only when the
   * scoreboard shows a usable leg. The scoreboard is rebuilt from the current
   * event row, so a leg measured after `sentAt` was not in the email that went
   * out; the header says so (see scoreboardRefreshedAfterSend).
   */
  reactionLegAt?: string | null;
  fullHtml: string;
}

/** `YYYY-MM-DD HH:MM:SS` (SQLite UTC) or an ISO string, as a Date; null when unparseable. */
function parseUtcStamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * The instant the scoreboard's reaction legs were measured at, when that is
 * LATER than the send — i.e. the scoreboard on screen carries a reaction the
 * sent email could not have had. Null when the leg predates (or equals) the
 * send, when this is not a sent email, or when either stamp is unreadable
 * (no label is better than a wrong one).
 */
export function scoreboardRefreshedAfterSend(
  sentAt: string | null | undefined,
  reactionLegAt: string | null | undefined,
): Date | null {
  const sent = parseUtcStamp(sentAt);
  const leg = parseUtcStamp(reactionLegAt);
  if (!sent || !leg) return null;
  return leg.getTime() > sent.getTime() ? leg : null;
}

/**
 * Where Tab lands next inside the viewer: the dialog's own controls form a
 * closed ring (Tab off the last wraps to the first, Shift+Tab off the first
 * wraps to the last). `current` is -1 when focus sits on the dialog panel
 * itself or anywhere outside the ring. Returns -1 when there is no control.
 */
export function nextTabStopIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return shift ? count - 1 : 0;
  return (current + (shift ? count - 1 : 1)) % count;
}

/**
 * Pure header block for the email viewer modal. Pulled out of
 * EarningsEmailViewer (which fetches in a useEffect and has no
 * fixture-driven render path) so it can be exercised directly with
 * react-dom/server in tests — see
 * tests/dashboard/earnings-email-viewer-delivery-state.test.ts.
 */
export function EmailViewerHeader({ data }: { data: EmailContentResponse | null }) {
  const refreshedAt =
    data && data.phase === "recap"
      ? scoreboardRefreshedAfterSend(data.sentAt, data.reactionLegAt)
      : null;
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
      {refreshedAt && (
        <p className="text-[11px] text-gold-ink font-mono mt-0.5 truncate">
          Scoreboard refreshed after send — reaction captured{" "}
          {formatSentAt(refreshedAt.toISOString())} ET
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
 * Body of the viewer: the sandboxed email frame, or — in privacy mode, until
 * the reader presses Reveal — a masked panel in its place.
 *
 * The email body is AI prose over the user's positions (older sends quote
 * share counts and account returns) and no privacy component can reach inside
 * an iframe's srcDoc, so the whole frame is the masking boundary: while
 * masked the iframe is NOT RENDERED AT ALL, so neither the body nor its
 * srcdoc attribute is in the page. Pure (props only) so it renders under
 * react-dom/server in tests.
 */
export function EmailViewerBody({
  data,
  masked,
  onReveal,
  frameRef,
}: {
  data: EmailContentResponse;
  masked: boolean;
  onReveal: () => void;
  frameRef?: RefObject<HTMLIFrameElement | null>;
}) {
  if (masked) {
    return (
      <div className="px-5 py-12 text-center">
        <p className="text-[14px] text-ink-dim">Amounts hidden — privacy mode</p>
        <p className="mt-1 text-[13px] text-ink-dim">
          This email can quote your positions, so it stays covered until you reveal it.
        </p>
        <button
          type="button"
          onClick={onReveal}
          className="mt-4 min-h-11 rounded-md border border-edge bg-raised px-4 text-[14px] text-ink hover:bg-muted"
        >
          Reveal this email
        </button>
      </div>
    );
  }
  return (
    /* The email's scoreboard table has a min-content width of ~820px
       (fixed-width columns for print-and-fill), wider than both the
       old max-w-3xl modal (768px) and any phone. Give the iframe that
       natural width and let ScrollFade own the horizontal overflow —
       without it the Δ (beat/miss) column silently clipped on desktop
       and EVERY number was off-screen at rest on mobile (2026-07-27
       sweep). */
    <ScrollFade>
      <iframe
        ref={frameRef}
        title={data.title}
        srcDoc={withExternalLinkTarget(data.fullHtml)}
        className="w-full min-w-[860px] block border-0 rounded-b-xl"
        style={{ height: "75dvh", backgroundColor: "#1a1a1a" }}
        sandbox={EMAIL_FRAME_SANDBOX}
      />
    </ScrollFade>
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
  const { isPrivate } = usePrivacy();
  // Privacy reveal is tied to the ONE loaded email it was pressed for (object
  // identity), lives in component state only (a reload starts covered again),
  // and is dropped whenever the viewer opens or closes or privacy mode is
  // switched, so every open — and every switch-on of privacy — starts covered.
  // Dropped during render (not in an effect) so no frame paints a stale reveal.
  const [revealedFor, setRevealedFor] = useState<EmailContentResponse | null>(null);
  const coverScope = open && isPrivate;
  const [prevCoverScope, setPrevCoverScope] = useState(coverScope);
  if (coverScope !== prevCoverScope) {
    setPrevCoverScope(coverScope);
    setRevealedFor(null);
  }
  const masked = isPrivate && (data === null || revealedFor !== data);
  const panelRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

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

  // Focus moves into the dialog on open and goes back to whatever opened it
  // (the list row) on close — otherwise Tab + Enter kept driving the list
  // hidden behind the overlay and swapped the open email.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open]);

  // Escape closes the modal; Tab stays inside it. The email frame is left out
  // of the Tab ring on purpose: a key pressed while focus is inside the
  // sandboxed frame never reaches this document, so Escape would go dead.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      e.preventDefault();
      const stops = Array.from(
        panel.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"),
      );
      const next = nextTabStopIndex(
        stops.length,
        stops.indexOf(document.activeElement as HTMLElement),
        e.shiftKey,
      );
      (next === -1 ? panel : stops[next]).focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // A click inside the email moves focus into the frame, which fires `blur`
  // on this window. Hand focus straight back to the dialog so Escape keeps
  // working; the sandbox stays script-free (no key bridge out of the frame).
  // Wheel and touch scrolling, text selection and link clicks do not need
  // focus in the frame. The check is deferred a tick because activeElement
  // has not moved yet when `blur` fires.
  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWindowBlur = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (frameRef.current && document.activeElement === frameRef.current) {
          panelRef.current?.focus();
        }
      }, 0);
    };
    window.addEventListener("blur", onWindowBlur);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [open]);

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
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={data?.title ?? "Earnings email"}
        tabIndex={-1}
        className="relative w-full max-w-4xl mx-auto my-8 electron:mt-12 max-h-[85dvh] overflow-y-auto rounded-xl border border-edge bg-panel shadow-2xl outline-none"
      >
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
            <EmailViewerBody
              data={data}
              masked={masked}
              onReveal={() => {
                setRevealedFor(data);
                // The reveal button unmounts with the cover; keep focus in the dialog.
                panelRef.current?.focus();
              }}
              frameRef={frameRef}
            />
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
