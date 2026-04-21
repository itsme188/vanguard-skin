"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import type { LevelReviewStatus } from "@/lib/types";
import { useToast } from "../../components/Toast";

interface PendingLevel {
  id: number;
  security_id: number;
  symbol: string;
  security_name: string | null;
  level_type: string;
  price: number;
  price_source: string;
  direction: string | null;
  action_hint: string | null;
  source_author: string | null;
  thesis: string | null;
  timeframe: string | null;
  source_article_id: number | null;
  current_price: number | null;
  created_at: string;
}

function formatPriceSourceLabel(source: string): string {
  const m = /^(sma|ema)_(\d+)$/.exec(source);
  if (!m) return source;
  return `${m[1].toUpperCase()} ${m[2]}`;
}

function distancePct(level: number, current: number | null): string | null {
  if (current == null) return null;
  const pct = ((current - level) / level) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export default function LevelsReviewPage() {
  const { toast } = useToast();
  const [levels, setLevels] = useState<PendingLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/levels/review");
      const json = await res.json();
      if (json.success) setLevels(json.levels);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function decide(id: number, status: LevelReviewStatus) {
    setBusyId(id);
    try {
      const res = await fetch("/api/levels/review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!res.ok) {
        toast("Failed to update level", "error");
        return;
      }
      toast(
        status === "auto_approved"
          ? "Level approved — now armed"
          : "Level rejected",
        status === "auto_approved" ? "success" : "info"
      );
      // Optimistic: drop the row immediately.
      setLevels((prev) => prev.filter((l) => l.id !== id));
    } finally {
      setBusyId(null);
    }
  }

  async function approveAll() {
    const ids = levels.map((l) => l.id);
    setBusyId(-1);
    try {
      await Promise.all(
        ids.map((id) =>
          fetch("/api/levels/review", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, status: "auto_approved" }),
          })
        )
      );
      toast(`${ids.length} level${ids.length === 1 ? "" : "s"} approved`, "success");
      setLevels([]);
    } finally {
      setBusyId(null);
    }
  }

  // Group by source_author so the user can triage per-source (e.g. "go through
  // all of Purple Drink's extractions in one pass").
  const grouped = new Map<string, PendingLevel[]>();
  for (const l of levels) {
    const key = l.source_author ?? "Unknown";
    const arr = grouped.get(key) ?? [];
    arr.push(l);
    grouped.set(key, arr);
  }

  return (
    <div className="space-y-5">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-2xl text-ink">Review newsletter levels</h1>
          <p className="text-[11px] text-ink-faint mt-0.5">
            Levels extracted from newsletters waiting on your approval before they arm.
          </p>
        </div>
        {levels.length > 0 && (
          <button
            onClick={approveAll}
            disabled={busyId !== null}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gold/30 bg-gold/10 text-gold hover:bg-gold/20 disabled:opacity-50"
          >
            Approve all ({levels.length})
          </button>
        )}
      </header>

      {loading ? (
        <p className="text-[11px] text-ink-faint italic py-6 text-center">Loading...</p>
      ) : levels.length === 0 ? (
        <div className="rounded-xl border border-edge bg-panel p-10 text-center">
          <p className="text-sm text-ink-dim">Nothing to review.</p>
          <p className="text-[11px] text-ink-faint mt-2">
            When the research sync extracts new levels, they'll appear here for your approval
            before the scan arms them.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {Array.from(grouped.entries()).map(([author, rows]) => (
            <section key={author}>
              <h2 className="text-[11px] uppercase tracking-wider text-ink-dim mb-2">
                {author}
                <span className="ml-1.5 text-ink-faint font-mono">{rows.length}</span>
              </h2>
              <ul className="space-y-2">
                {rows.map((l) => {
                  const dist = distancePct(l.price, l.current_price);
                  return (
                    <li
                      key={l.id}
                      className="rounded-xl border border-edge bg-panel p-4 flex items-start justify-between gap-4 flex-wrap"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <Link
                            href={`/dashboard/security/${l.security_id}`}
                            className="font-mono text-sm font-medium text-ink hover:text-gold"
                          >
                            {l.symbol}
                          </Link>
                          <span className="text-[11px] text-ink-dim uppercase">
                            {l.level_type.replace("_", " ")}
                          </span>
                          <span className="text-sm font-mono text-ink">
                            @ ${l.price.toFixed(2)}
                          </span>
                          {l.price_source && l.price_source !== "static" && (
                            <span className="text-[9px] px-1 py-0.5 rounded bg-raised text-ink-faint uppercase tracking-wider">
                              {formatPriceSourceLabel(l.price_source)}
                            </span>
                          )}
                          {dist && (
                            <span className="text-[11px] text-ink-faint font-mono">
                              {dist} vs ${l.current_price!.toFixed(2)}
                            </span>
                          )}
                        </div>
                        {l.thesis && (
                          <p className="text-[11px] text-ink-dim italic mt-1">— {l.thesis}</p>
                        )}
                        <p className="text-[10px] text-ink-faint mt-1">
                          {l.timeframe && `${l.timeframe} · `}
                          extracted {new Date(l.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => decide(l.id, "auto_approved")}
                          disabled={busyId !== null}
                          className="px-3 py-1 text-[11px] rounded bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => decide(l.id, "rejected")}
                          disabled={busyId !== null}
                          className="px-3 py-1 text-[11px] rounded text-ink-faint hover:text-ink-dim disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
