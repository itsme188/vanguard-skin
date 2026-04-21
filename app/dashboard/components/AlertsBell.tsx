"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

export function AlertsBell() {
  const [count, setCount] = useState<number | null>(null);

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts?countOnly=true");
      const json = await res.json();
      if (json.success) setCount(json.pendingCount);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchCount();
    const interval = setInterval(fetchCount, 60_000);
    const onFocus = () => fetchCount();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchCount]);

  return (
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
  );
}
