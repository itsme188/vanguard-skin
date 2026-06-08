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

interface PreviewReview {
  id: number;
  security_id: number;
  symbol: string;
  level_type: string;
  price: number;
  source_author: string | null;
  created_at: string;
}

/**
 * Single bell that combines fired alerts (level crossings awaiting user
 * response) and newsletter-extracted levels awaiting review approval.
 * Replaces the prior split AlertsBell + ReviewBell.
 *
 * Click → /dashboard/alerts (unified inbox).
 *
 * Preserves the existing `alert-fired` window event when fired-alert count
 * increases (LevelsPanel listens). Does NOT fire that event for review-count
 * increases — those aren't actionable triggers, they're just inbox items.
 */
export function NotificationBell() {
  const [firedCount, setFiredCount] = useState<number | null>(null);
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [conflictCount, setConflictCount] = useState<number | null>(null);
  const prevFiredRef = useRef<number | null>(null);

  const [hovering, setHovering] = useState(false);
  const [previewAlerts, setPreviewAlerts] = useState<PreviewAlert[]>([]);
  const [previewReviews, setPreviewReviews] = useState<PreviewReview[]>([]);
  const [previewLoaded, setPreviewLoaded] = useState(false);

  const fetchCounts = useCallback(async () => {
    try {
      const [alertsRes, reviewRes, conflictRes] = await Promise.all([
        fetch("/api/alerts?countOnly=true"),
        fetch("/api/levels/review?countOnly=true"),
        fetch("/api/earnings/conflicts?countOnly=true"),
      ]);
      const [alertsJson, reviewJson, conflictJson] = await Promise.all([
        alertsRes.json(),
        reviewRes.json(),
        conflictRes.json(),
      ]);
      const nextFired = alertsJson?.success ? (alertsJson.pendingCount as number) : 0;
      const nextReview = reviewJson?.success ? (reviewJson.count as number) : 0;
      const nextConflict = conflictJson?.success ? (conflictJson.count as number) : 0;

      const prevFired = prevFiredRef.current;
      if (prevFired !== null && nextFired > prevFired) {
        window.dispatchEvent(
          new CustomEvent("alert-fired", {
            detail: { delta: nextFired - prevFired, pendingCount: nextFired },
          })
        );
      }
      prevFiredRef.current = nextFired;

      setFiredCount((cur) => {
        if (cur !== nextFired) setPreviewLoaded(false);
        return nextFired;
      });
      setReviewCount((cur) => {
        if (cur !== nextReview) setPreviewLoaded(false);
        return nextReview;
      });
      setConflictCount(nextConflict);
    } catch {
      // silent — bell never blocks the header
    }
  }, []);

  useEffect(() => {
    fetchCounts();
    const interval = setInterval(fetchCounts, 60_000);
    const onFocus = () => fetchCounts();
    const onAlertsUpdated = () => fetchCounts();
    const onReviewsUpdated = () => fetchCounts();
    window.addEventListener("focus", onFocus);
    window.addEventListener("alerts-updated", onAlertsUpdated);
    window.addEventListener("reviews-updated", onReviewsUpdated);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("alerts-updated", onAlertsUpdated);
      window.removeEventListener("reviews-updated", onReviewsUpdated);
    };
  }, [fetchCounts]);

  const totalCount = (firedCount ?? 0) + (reviewCount ?? 0) + (conflictCount ?? 0);

  const onMouseEnter = useCallback(async () => {
    setHovering(true);
    if (previewLoaded || totalCount === 0) return;
    try {
      const requests: Promise<Response>[] = [];
      if ((firedCount ?? 0) > 0) {
        requests.push(fetch("/api/alerts?response=pending&limit=3"));
      } else {
        requests.push(Promise.resolve(new Response(JSON.stringify({ success: true, alerts: [] }))));
      }
      if ((reviewCount ?? 0) > 0) {
        requests.push(fetch("/api/levels/review"));
      } else {
        requests.push(Promise.resolve(new Response(JSON.stringify({ success: true, levels: [] }))));
      }
      const [alertsRes, reviewRes] = await Promise.all(requests);
      const alertsJson = await alertsRes.json();
      const reviewJson = await reviewRes.json();
      if (alertsJson?.success) setPreviewAlerts(alertsJson.alerts as PreviewAlert[]);
      if (reviewJson?.success) {
        const all = (reviewJson.levels as PreviewReview[]) ?? [];
        setPreviewReviews(all.slice(0, 3));
      }
      setPreviewLoaded(true);
    } catch {
      // silent
    }
  }, [previewLoaded, totalCount, firedCount, reviewCount]);

  const onMouseLeave = useCallback(() => {
    setHovering(false);
  }, []);

  const tooltip = (() => {
    const parts: string[] = [];
    if ((firedCount ?? 0) > 0) parts.push(`${firedCount} fired`);
    if ((reviewCount ?? 0) > 0) parts.push(`${reviewCount} to review`);
    if ((conflictCount ?? 0) > 0) parts.push(`${conflictCount} date conflict${conflictCount === 1 ? "" : "s"}`);
    return parts.length === 0 ? "No notifications" : parts.join(" · ");
  })();

  return (
    <div className="relative" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <Link
        href="/dashboard/alerts"
        className="relative flex items-center text-ink-dim hover:text-ink transition-colors"
        title={tooltip}
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
        {totalCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-gold text-canvas text-[9px] font-mono font-bold flex items-center justify-center">
            {totalCount > 9 ? "9+" : totalCount}
          </span>
        )}
      </Link>

      {hovering && totalCount > 0 && (
        <div
          className="hidden md:block absolute right-0 top-full mt-2 w-80 rounded-lg border border-edge bg-panel shadow-xl z-50"
          style={{ backgroundColor: "var(--panel)" }}
        >
          <div className="px-3 py-2 border-b border-edge flex items-center justify-between">
            <span className="text-[11px] font-medium text-ink-dim">
              {tooltip}
            </span>
            <Link
              href="/dashboard/alerts"
              className="text-[11px] font-medium text-gold hover:brightness-110"
            >
              View all →
            </Link>
          </div>

          {(firedCount ?? 0) > 0 && (
            <div>
              <div className="px-3 py-1.5 bg-raised border-b border-edge">
                <span className="text-[9px] font-medium text-gold uppercase tracking-wider">
                  Pending alerts
                </span>
              </div>
              <ul className="divide-y divide-edge">
                {previewAlerts.length === 0 ? (
                  <li className="px-3 py-2 text-[11px] text-ink-faint italic">
                    {previewLoaded ? "—" : "Loading..."}
                  </li>
                ) : (
                  previewAlerts.map((a) => (
                    <li key={`a-${a.id}`} className="px-3 py-2">
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
                            {a.level.level_type.replace("_", " ")} @{" "}
                            <Money value={a.level.price} precise />
                            <span className="ml-1.5 text-ink-dim">
                              hit <Money value={a.triggered_price} precise />
                            </span>
                            {a.level.source_author && (
                              <span className="text-ink-faint italic">
                                {" "}— {a.level.source_author}
                              </span>
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

          {(reviewCount ?? 0) > 0 && (
            <div>
              <div className="px-3 py-1.5 bg-raised border-b border-edge border-t">
                <span className="text-[9px] font-medium text-amber-500 uppercase tracking-wider">
                  Levels to review
                </span>
              </div>
              <ul className="divide-y divide-edge">
                {previewReviews.length === 0 ? (
                  <li className="px-3 py-2 text-[11px] text-ink-faint italic">
                    {previewLoaded ? "—" : "Loading..."}
                  </li>
                ) : (
                  previewReviews.map((l) => (
                    <li key={`r-${l.id}`} className="px-3 py-2">
                      <Link
                        href={`/dashboard/security/${l.security_id}`}
                        className="block hover:bg-raised -mx-3 px-3 py-1 rounded"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-mono text-[11px] font-medium text-ink">
                            {l.symbol}
                          </span>
                          <span className="text-[10px] text-ink-faint">
                            {formatRelative(l.created_at)}
                          </span>
                        </div>
                        <p className="text-[10px] text-ink-faint mt-0.5">
                          {l.level_type.replace("_", " ")} @{" "}
                          <Money value={l.price} precise />
                          {l.source_author && (
                            <span className="text-ink-faint italic">
                              {" "}— {l.source_author}
                            </span>
                          )}
                        </p>
                      </Link>
                    </li>
                  ))
                )}
              </ul>
            </div>
          )}

          {(conflictCount ?? 0) > 0 && (
            <div>
              <div className="px-3 py-1.5 bg-raised border-b border-edge border-t">
                <span className="text-[9px] font-medium text-gold uppercase tracking-wider">
                  Earnings date conflicts
                </span>
              </div>
              <Link
                href="/dashboard/today"
                className="block px-3 py-2 hover:bg-raised"
              >
                <span className="text-[11px] text-ink">
                  {conflictCount} name{conflictCount === 1 ? "" : "s"} with disagreeing sources
                </span>
                <p className="text-[10px] text-ink-faint mt-0.5">
                  Confirm the date against IBKR on the Today view →
                </p>
              </Link>
            </div>
          )}
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
