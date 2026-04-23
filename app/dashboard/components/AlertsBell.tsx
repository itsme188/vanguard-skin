"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { Money } from "@/lib/privacy/components";

interface PreviewAlert {
  id: number;
  security_id: number;
  symbol: string | null;
  triggered_at: string;
  triggered_price: number;
  level: {
    level_type: string;
    price: number;
    source_author: string | null;
  } | null;
}

export function AlertsBell() {
  const [count, setCount] = useState<number | null>(null);
  // Tracks the previous count so we can detect an INCREASE (new alert fired)
  // vs decrease (user responded to an alert) vs same (no change). Using a ref
  // instead of a state dep keeps fetchCount stable and avoids the
  // render-loop trap documented in CLAUDE.md (DataConfidenceIndicator fix).
  const prevCountRef = useRef<number | null>(null);

  // Hover preview — fetched lazily on mouseenter so we don't spam the API for
  // every page that renders the header. Disabled on touch devices via CSS.
  const [hovering, setHovering] = useState(false);
  const [preview, setPreview] = useState<PreviewAlert[]>([]);
  const [previewLoaded, setPreviewLoaded] = useState(false);

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts?countOnly=true");
      const json = await res.json();
      if (json.success) {
        const next = json.pendingCount as number;
        const prev = prevCountRef.current;
        // Fire "alert-fired" when pending count increases. Skip the null→N
        // case (initial mount) so re-opening the dashboard with pre-existing
        // alerts doesn't spam listeners.
        if (prev !== null && next > prev) {
          window.dispatchEvent(
            new CustomEvent("alert-fired", { detail: { delta: next - prev, pendingCount: next } })
          );
        }
        prevCountRef.current = next;
        setCount(next);
        // Invalidate cached preview on count change — next hover re-fetches.
        if (prev !== next) setPreviewLoaded(false);
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchCount();
    const interval = setInterval(fetchCount, 60_000);
    const onFocus = () => fetchCount();
    // Dispatched by the alerts inbox after a respond PATCH so the bell
    // updates immediately instead of waiting up to 60s for the poll.
    const onAlertsUpdated = () => fetchCount();
    window.addEventListener("focus", onFocus);
    window.addEventListener("alerts-updated", onAlertsUpdated);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("alerts-updated", onAlertsUpdated);
    };
  }, [fetchCount]);

  const onMouseEnter = useCallback(async () => {
    setHovering(true);
    if (previewLoaded || count === 0) return;
    try {
      const res = await fetch("/api/alerts?response=pending&limit=3");
      const json = await res.json();
      if (json.success) {
        setPreview(json.alerts as PreviewAlert[]);
        setPreviewLoaded(true);
      }
    } catch {
      // silent
    }
  }, [previewLoaded, count]);

  const onMouseLeave = useCallback(() => {
    setHovering(false);
  }, []);

  return (
    <div className="relative" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <Link
        href="/dashboard/alerts"
        className="relative flex items-center text-ink-dim hover:text-ink transition-colors"
        title={count ? `${count} pending alert${count === 1 ? "" : "s"}` : "No pending alerts"}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {count !== null && count > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-gold text-canvas text-[9px] font-mono font-bold flex items-center justify-center">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </Link>

      {/* Hover preview — desktop only (hidden below md). Click-through on the
          bell itself still goes to the full alerts page. */}
      {hovering && count !== null && count > 0 && (
        <div className="hidden md:block absolute right-0 top-full mt-2 w-72 rounded-lg border border-edge bg-panel shadow-xl z-50">
          <div className="px-3 py-2 border-b border-edge flex items-center justify-between">
            <span className="text-[11px] font-medium text-ink-dim">
              {count} pending alert{count === 1 ? "" : "s"}
            </span>
            <Link
              href="/dashboard/alerts"
              className="text-[11px] font-medium text-gold hover:brightness-110"
            >
              View all →
            </Link>
          </div>
          <ul className="divide-y divide-edge max-h-64 overflow-y-auto">
            {preview.length === 0 ? (
              <li className="px-3 py-3 text-[11px] text-ink-faint italic">
                {previewLoaded ? "No recent alerts" : "Loading..."}
              </li>
            ) : (
              preview.map((a) => (
                <li key={a.id} className="px-3 py-2">
                  <Link
                    href={`/dashboard/security/${a.security_id}`}
                    className="block hover:bg-raised -mx-3 px-3 py-1 rounded"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[11px] font-medium text-ink">
                        {a.symbol ?? "—"}
                      </span>
                      <span className="text-[10px] text-ink-faint">
                        {formatRelative(a.triggered_at)}
                      </span>
                    </div>
                    {a.level && (
                      <p className="text-[10px] text-ink-faint mt-0.5">
                        {a.level.level_type.replace("_", " ")} @ <Money value={a.level.price} precise />
                        <span className="ml-1.5 text-ink-dim">
                          hit <Money value={a.triggered_price} precise />
                        </span>
                        {a.level.source_author && (
                          <span className="text-ink-faint italic"> — {a.level.source_author}</span>
                        )}
                      </p>
                    )}
                  </Link>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const diffMin = Math.floor((Date.now() - t) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const hrs = Math.floor(diffMin / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
