"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  SecurityLevel,
  LevelType,
  LevelDirection,
  LevelActionHint,
  LevelTimeframe,
  LevelPriceSource,
} from "@/lib/types";
import { useToast } from "./Toast";

type EnrichedLevel = SecurityLevel & { effective_price: number | null };

const PRICE_SOURCE_OPTIONS: Array<{ value: LevelPriceSource; label: string }> = [
  { value: "static", label: "Specific price" },
  { value: "sma_9", label: "SMA 9" },
  { value: "sma_21", label: "SMA 21" },
  { value: "sma_50", label: "SMA 50" },
  { value: "sma_200", label: "SMA 200" },
  { value: "ema_9", label: "EMA 9" },
  { value: "ema_21", label: "EMA 21" },
];

function priceSourceLabel(src: LevelPriceSource): string {
  return PRICE_SOURCE_OPTIONS.find((o) => o.value === src)?.label ?? src;
}

function triggeredToday(triggeredAt: string | null): boolean {
  if (!triggeredAt) return false;
  // Compare local dates (user's tz). The scanner dedup uses SQLite's date('now')
  // which is UTC, but this is a UI hint — good-enough tolerance.
  const t = new Date(triggeredAt);
  if (isNaN(t.getTime())) return false;
  const now = new Date();
  return t.toDateString() === now.toDateString();
}

const LEVEL_TYPE_OPTIONS: LevelType[] = [
  "support",
  "resistance",
  "entry",
  "exit",
  "stop",
  "scale_in",
];

const LEVEL_TYPE_LABEL: Record<LevelType, string> = {
  support: "Support",
  resistance: "Resistance",
  entry: "Entry",
  exit: "Exit / Target",
  stop: "Stop",
  scale_in: "Scale In",
};

const LEVEL_TYPE_COLOR: Record<LevelType, string> = {
  support: "text-emerald-400",
  resistance: "text-rose-400",
  entry: "text-emerald-400",
  exit: "text-blue-400",
  stop: "text-rose-400",
  scale_in: "text-emerald-300",
};

export function LevelsPanel({
  securityId,
  symbol,
  currentPrice,
}: {
  securityId: number;
  symbol: string;
  currentPrice: number | null;
}) {
  const { toast } = useToast();
  const [levels, setLevels] = useState<EnrichedLevel[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [sourceOptions, setSourceOptions] = useState<string[]>([]);
  // Provenance filter: "All" | "Me" | specific author. Lets the user triage
  // their own levels vs newsletter-derived ones once the list grows.
  const [authorFilter, setAuthorFilter] = useState<string>("All");

  // Form state. Default author = "Me" so user-originated levels are tracked as
  // the user's own. Dropdown also surfaces known research_sources for one-click
  // provenance when the level came from a newsletter.
  const [levelType, setLevelType] = useState<LevelType>("entry");
  const [priceSource, setPriceSource] = useState<LevelPriceSource>("static");
  const [price, setPrice] = useState("");
  const [direction, setDirection] = useState<LevelDirection | "">("");
  const [actionHint, setActionHint] = useState<LevelActionHint | "">("");
  const [sourceAuthor, setSourceAuthor] = useState("Me");
  const [thesis, setThesis] = useState("");
  const [timeframe, setTimeframe] = useState<LevelTimeframe | "">("");
  const [expiresAt, setExpiresAt] = useState("");
  // Mobile only: collapses Direction/Action/Source/Timeframe/Expires/Thesis
  // behind a "More options" disclosure to keep tap targets large. Desktop
  // always shows the full form.
  const [showAdvanced, setShowAdvanced] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/levels?securityId=${securityId}&activeOnly=${!showInactive}`
      );
      const json = await res.json();
      if (json.success) setLevels(json.levels);
    } finally {
      setLoading(false);
    }
  }, [securityId, showInactive]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Refetch when an alert fires elsewhere (AlertsBell's poll detects it).
  // Without this the panel can show a level as active for up to 30s after it
  // triggered, even though is_active flipped to 0 in the DB.
  useEffect(() => {
    const onAlertFired = () => refresh();
    window.addEventListener("alert-fired", onAlertFired);
    return () => window.removeEventListener("alert-fired", onAlertFired);
  }, [refresh]);

  // Load known research sources once so the Source/Author field can offer
  // them as a datalist. "Me" is always first to nudge user toward tracking
  // self-originated levels separately from followed-authors.
  useEffect(() => {
    fetch("/api/research/sources")
      .then((r) => r.json())
      .then((j) => {
        if (j.success && Array.isArray(j.data)) {
          const names = j.data.map((s: { name: string }) => s.name).filter(Boolean);
          setSourceOptions(["Me", ...names]);
        }
      })
      .catch(() => setSourceOptions(["Me"]));
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    // For MA-based levels, use the current price as a reference (the server will
    // recompute the effective price daily from ohlcv_bars). For static levels,
    // require a valid number.
    const priceNum = price ? parseFloat(price) : currentPrice ?? 0;
    if (priceSource === "static" && (!priceNum || Number.isNaN(priceNum))) return;

    setLoading(true);
    try {
      const res = await fetch("/api/levels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          security_id: securityId,
          level_type: levelType,
          price: priceNum,
          price_source: priceSource,
          direction: direction || null,
          action_hint: actionHint || null,
          source: "user",
          source_author: sourceAuthor || null,
          thesis: thesis || null,
          timeframe: timeframe || null,
          expires_at: expiresAt || null,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast(`Failed to add level: ${json.error ?? "unknown"}`, "error");
        return;
      }
      toast(`${symbol} ${levelType} level added`, "success");
      // Reset form — keep "Me" as the default author after submit so a quick
      // series of self-originated entries doesn't need re-typing.
      setPrice("");
      setThesis("");
      setSourceAuthor("Me");
      setPriceSource("static");
      setExpiresAt("");
      setAdding(false);
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  async function handleDeactivate(id: number) {
    const res = await fetch("/api/levels", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "deactivate" }),
    });
    if (res.ok) toast("Level paused", "info");
    else toast("Failed to pause level", "error");
    refresh();
  }

  async function handleReactivate(id: number) {
    const res = await fetch("/api/levels", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "reactivate" }),
    });
    if (res.ok) toast("Level reactivated", "success");
    else toast("Failed to reactivate level", "error");
    refresh();
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this level permanently?")) return;
    const res = await fetch(`/api/levels?id=${id}`, { method: "DELETE" });
    if (res.ok) toast("Level deleted", "info");
    else toast("Failed to delete level", "error");
    refresh();
  }

  return (
    <section className="rounded-xl border border-edge bg-panel p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-medium text-ink">Levels & Alerts</h2>
          <p className="text-[11px] text-ink-faint mt-0.5">
            Entry, exit, stop, or support/resistance levels. Alerts fire once per level when crossed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-ink-faint flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="accent-gold"
            />
            Show inactive
          </label>
          <button
            onClick={() => setAdding((v) => !v)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gold/30 bg-gold/10 text-gold hover:bg-gold/20 transition-colors"
          >
            {adding ? "Cancel" : "+ Add Level"}
          </button>
        </div>
      </div>

      {adding && (
        <form
          onSubmit={handleAdd}
          className="mb-4 p-4 rounded-lg border border-edge bg-raised space-y-3"
        >
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Field label="Type">
              <select
                value={levelType}
                onChange={(e) => setLevelType(e.target.value as LevelType)}
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
              >
                {LEVEL_TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>{LEVEL_TYPE_LABEL[t]}</option>
                ))}
              </select>
            </Field>
            <Field label="Reference">
              <select
                value={priceSource}
                onChange={(e) => setPriceSource(e.target.value as LevelPriceSource)}
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
              >
                {PRICE_SOURCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label={priceSource === "static" ? "Price" : "Price (optional)"}>
              <input
                type="number"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                required={priceSource === "static"}
                placeholder={
                  priceSource === "static"
                    ? (currentPrice ? currentPrice.toFixed(2) : "0.00")
                    : "auto (uses MA)"
                }
                disabled={priceSource !== "static"}
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs disabled:opacity-40"
              />
            </Field>
            <div className={`contents ${showAdvanced ? "" : "hidden md:contents"}`}>
              <Field label="Direction">
                <select
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as LevelDirection | "")}
                  className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
                >
                  <option value="">—</option>
                  <option value="bullish">Bullish</option>
                  <option value="bearish">Bearish</option>
                </select>
              </Field>
              <Field label="Action">
                <select
                  value={actionHint}
                  onChange={(e) => setActionHint(e.target.value as LevelActionHint | "")}
                  className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
                >
                  <option value="">—</option>
                  <option value="new_position">New position</option>
                  <option value="scale_in">Scale in</option>
                  <option value="trim">Trim</option>
                  <option value="close">Close</option>
                  <option value="watch">Watch</option>
                </select>
              </Field>
            </div>
          </div>
          {/* Mobile-only disclosure. Desktop always shows the second grid. */}
          {!showAdvanced && (
            <button
              type="button"
              onClick={() => setShowAdvanced(true)}
              className="md:hidden w-full text-center text-[11px] text-gold py-2 border border-dashed border-gold/30 rounded hover:bg-gold/5"
            >
              More options ↓
            </button>
          )}
          <div className={`grid grid-cols-2 md:grid-cols-4 gap-3 ${showAdvanced ? "" : "hidden md:grid"}`}>
            <Field label="Source / Author">
              <input
                type="text"
                list="levels-sources"
                value={sourceAuthor}
                onChange={(e) => setSourceAuthor(e.target.value)}
                placeholder="Me, Purple Drink, Eliant…"
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
              />
              <datalist id="levels-sources">
                {sourceOptions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </Field>
            <Field label="Timeframe (context)">
              <select
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value as LevelTimeframe | "")}
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
                title="Informational — what horizon the author is talking about. Does NOT auto-expire the level."
              >
                <option value="">—</option>
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </Field>
            <Field label="Expires (auto-deactivate)">
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
                title="Optional. After this date the level is ignored by the scan. Separate from Timeframe, which is informational only."
              />
            </Field>
            <Field label="Thesis (why this level)">
              <input
                type="text"
                value={thesis}
                onChange={(e) => setThesis(e.target.value)}
                placeholder="e.g. 50-day SMA held in March"
                className="w-full bg-canvas border border-edge rounded px-2 py-1 text-xs"
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={loading || (priceSource === "static" && !price)}
              className="px-4 py-1.5 text-xs font-medium rounded-lg bg-gold/20 text-gold hover:bg-gold/30 disabled:opacity-50"
            >
              {loading ? "Saving..." : `Add ${symbol} level`}
            </button>
          </div>
        </form>
      )}

      {/* Provenance filter — derived from distinct authors on this security's
          levels. Hidden when there's nothing to filter (≤1 distinct author). */}
      {(() => {
        const distinctAuthors = Array.from(
          new Set(levels.map((l) => l.source_author).filter((a): a is string => !!a))
        ).sort();
        if (distinctAuthors.length <= 1) return null;
        const pills = ["All", ...distinctAuthors];
        return (
          <div className="flex items-center gap-1 mb-3 flex-wrap">
            {pills.map((p) => (
              <button
                key={p}
                onClick={() => setAuthorFilter(p)}
                className={`px-2 py-0.5 rounded-full text-[10px] transition-colors ${
                  authorFilter === p
                    ? "bg-gold/20 text-gold"
                    : "bg-raised text-ink-faint hover:text-ink-dim"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        );
      })()}

      {(() => {
        const visibleLevels =
          authorFilter === "All"
            ? levels
            : levels.filter((l) => l.source_author === authorFilter);

        if (visibleLevels.length === 0) {
          return (
            <p className="text-[11px] text-ink-faint italic py-4 text-center">
              {levels.length === 0
                ? "No levels set. Add one above."
                : `No levels from ${authorFilter}.`}
            </p>
          );
        }

        return (
          <ul className="divide-y divide-edge">
            {visibleLevels.map((l) => (
            <li key={l.id} className="py-2.5 flex items-start gap-3">
              <div
                className={`text-[10px] uppercase tracking-wider font-medium w-20 shrink-0 ${LEVEL_TYPE_COLOR[l.level_type]}`}
              >
                {LEVEL_TYPE_LABEL[l.level_type]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  {l.price_source === "static" ? (
                    <span className="text-sm font-mono font-medium text-ink">
                      ${l.price.toFixed(2)}
                    </span>
                  ) : (
                    <>
                      <span className="text-sm font-mono font-medium text-ink">
                        {priceSourceLabel(l.price_source)}
                      </span>
                      {l.effective_price !== null ? (
                        <span className="text-[10px] text-ink-faint">
                          ≈ ${l.effective_price.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-[10px] text-amber-400" title="Not enough OHLCV history to compute this MA yet — the level won't fire until bars accumulate.">
                          insufficient history
                        </span>
                      )}
                    </>
                  )}
                  {l.direction && (
                    <span className="text-[10px] text-ink-faint uppercase">
                      {l.direction}
                    </span>
                  )}
                  {l.action_hint && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-raised text-ink-dim">
                      {l.action_hint.replace("_", " ")}
                    </span>
                  )}
                  {l.is_active === 0 && l.triggered_at && (
                    <span className="text-[10px] text-gold">
                      triggered @ ${l.triggered_price?.toFixed(2)}
                    </span>
                  )}
                  {triggeredToday(l.triggered_at) && (
                    <span
                      className="text-[10px] text-amber-400 uppercase"
                      title="Already alerted today. Reactivating now would no-op — the dedup guard suppresses a same-day second alert. Reactivate tomorrow or after the price has moved off the level."
                    >
                      alerted today
                    </span>
                  )}
                  {l.is_active === 0 && !l.triggered_at && (
                    <span className="text-[10px] text-ink-faint">inactive</span>
                  )}
                </div>
                {(l.thesis || l.source_author) && (
                  <p className="text-[11px] text-ink-faint mt-0.5">
                    {l.source_author && (
                      <span className="text-ink-dim">{l.source_author}: </span>
                    )}
                    {l.thesis}
                  </p>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                {l.is_active === 1 ? (
                  <button
                    onClick={() => handleDeactivate(l.id)}
                    className="text-[10px] text-ink-faint hover:text-ink"
                    title="Deactivate"
                  >
                    Pause
                  </button>
                ) : (
                  <button
                    onClick={() => handleReactivate(l.id)}
                    disabled={triggeredToday(l.triggered_at)}
                    className="text-[10px] text-emerald-400 hover:text-emerald-300 disabled:text-ink-faint disabled:cursor-not-allowed disabled:hover:text-ink-faint"
                    title={
                      triggeredToday(l.triggered_at)
                        ? "Already alerted today — reactivation is blocked until tomorrow to prevent duplicate alerts."
                        : "Reactivate"
                    }
                  >
                    Reactivate
                  </button>
                )}
                <button
                  onClick={() => handleDelete(l.id)}
                  className="text-[10px] text-rose-400 hover:text-rose-300 ml-2"
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
        );
      })()}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] text-ink-faint block mb-1">{label}</span>
      {children}
    </label>
  );
}
