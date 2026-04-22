"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

/**
 * Compact link shown next to AlertsBell when there are newsletter-extracted
 * levels awaiting user review. Hidden when count === 0 so the header stays
 * quiet in steady state.
 */
export function ReviewBell() {
  const [count, setCount] = useState<number | null>(null);

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch("/api/levels/review?countOnly=true");
      const json = await res.json();
      if (json.success) setCount(json.count as number);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchCount();
    // Poll on the same 60s cadence as AlertsBell — research sync can land
    // new pending reviews at any time.
    const interval = setInterval(fetchCount, 60_000);
    const onFocus = () => fetchCount();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchCount]);

  if (count === null || count === 0) return null;

  return (
    <Link
      href="/dashboard/levels/review"
      className="text-[11px] font-semibold px-2 py-1 rounded-full bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors uppercase tracking-wide"
      title={`${count} newsletter-extracted level${count === 1 ? "" : "s"} awaiting your review before they arm`}
    >
      {count} to review
    </Link>
  );
}
