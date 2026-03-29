"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function WatchlistButton({
  securityId,
  initialWatched,
  priceTargetLow,
  priceTargetHigh,
}: {
  securityId: number;
  initialWatched: boolean;
  priceTargetLow: number | null;
  priceTargetHigh: number | null;
}) {
  const [watched, setWatched] = useState(initialWatched);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleToggle() {
    setLoading(true);
    try {
      if (watched) {
        // Need to get the watchlist item ID first
        const listRes = await fetch("/api/watchlist");
        const listData = await listRes.json();
        const item = listData.items?.find(
          (i: { security_id: number }) => i.security_id === securityId
        );
        if (item) {
          await fetch(`/api/watchlist?id=${item.id}`, { method: "DELETE" });
        }
        setWatched(false);
      } else {
        await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ securityId }),
        });
        setWatched(true);
      }
      router.refresh();
    } catch {
      // Revert on error
      setWatched(watched);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors disabled:opacity-50 ${
        watched
          ? "bg-gold/10 text-gold border-gold/30 hover:bg-gold/20"
          : "border-edge text-ink-dim hover:text-ink hover:border-ink-faint"
      }`}
      title={watched ? "Remove from watchlist" : "Add to watchlist"}
    >
      {loading ? (
        "..."
      ) : watched ? (
        <span className="flex items-center gap-1">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth={1}
          >
            <path d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
          </svg>
          Watching
        </span>
      ) : (
        <span className="flex items-center gap-1">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
          </svg>
          Watch
        </span>
      )}
    </button>
  );
}
