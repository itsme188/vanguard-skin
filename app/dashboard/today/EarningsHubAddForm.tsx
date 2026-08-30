"use client";

/**
 * Inline "+ Add ticker" form for the Earnings Hub. Posts to
 * /api/calendar/events with source='manual' and reloads the page so the
 * new row surfaces in the deduped query immediately.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addDays, defaultDateWithinWeek, mondayOf } from "@/lib/calendar/date-utils";
import apiFetch from "@/lib/http/apiFetch";

interface Props {
  weekOf: string;
}

type Slot = "BMO" | "AMC";

/**
 * Copy for a non-blocking notice shown after a successful save whose date
 * falls outside the week the hub currently displays ([weekOf, weekOf+6]).
 * The date input has no min/max — saving to another week is a legitimate
 * action (e.g. adding a ticker that reports next week) — but the new row
 * then silently vanishes from view after `router.refresh()` re-queries the
 * deduped-for-this-week list, which reads as the save having failed.
 * Returns null when `date` IS within the shown week (no note needed).
 */
export function outOfWeekSaveNote(date: string, weekOf: string): string | null {
  const weekEnd = addDays(weekOf, 6);
  if (date >= weekOf && date <= weekEnd) return null;
  // mondayOf(date), not weekOf itself — this names the week the row will
  // ACTUALLY file under (POST /api/calendar/events stores
  // week_of: mondayOf(body.event_date)), so the note points somewhere real.
  return `Saved to the week of ${mondayOf(date)} — not the week shown here.`;
}

export function EarningsHubAddForm({ weekOf }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [date, setDate] = useState(() => defaultDateWithinWeek(weekOf));
  const [slot, setSlot] = useState<Slot>("AMC");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outOfWeekNote, setOutOfWeekNote] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!symbol.trim()) {
      setError("Symbol is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: symbol.trim().toUpperCase(),
          event_date: date,
          event_time: slot,
          event_type: "earnings",
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) {
        setError(data.error ?? `Server returned ${res.status}`);
        setSubmitting(false);
        return;
      }
      // Reset + close + reload server component; the cockpit is a client
      // poller and needs its own signal to pick up the new reporter now.
      setOutOfWeekNote(outOfWeekSaveNote(date, weekOf));
      setSymbol("");
      setOpen(false);
      window.dispatchEvent(new Event("earnings-data-changed"));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => {
            // NOT because the hub can navigate weeks without remounting
            // this form — EarningsHub.tsx hardcodes
            // `weekOf = getCurrentMonday()` per render, so weekOf itself is
            // fixed for the page's lifetime. The real reason: this form's
            // client state can persist across a long-lived tab, and
            // defaultDateWithinWeek reads "today" at CALL time — re-deriving
            // on every open (not just at mount) picks up a day rollover
            // (tab left open past midnight) instead of defaulting to a
            // stale mount-time date.
            setDate(defaultDateWithinWeek(weekOf));
            setOpen(true);
          }}
          className="text-[14px] font-medium text-gold-ink hover:text-gold"
        >
          + Add ticker
        </button>
        {outOfWeekNote && (
          <span className="text-[11px] text-ink-faint italic">{outOfWeekNote}</span>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 text-[14px]">
      <input
        type="text"
        value={symbol}
        onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        placeholder="TICKER"
        autoFocus
        className="font-mono uppercase bg-raised border border-edge rounded px-2 py-1 w-20 text-ink focus:outline-none focus:border-gold"
        maxLength={10}
      />
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="bg-raised border border-edge rounded px-2 py-1 text-ink focus:outline-none focus:border-gold"
      />
      <select
        value={slot}
        onChange={(e) => setSlot(e.target.value as Slot)}
        className="bg-raised border border-edge rounded px-2 py-1 text-ink focus:outline-none focus:border-gold"
      >
        <option value="BMO">BMO (08:00)</option>
        <option value="AMC">AMC (16:15)</option>
      </select>
      <button
        type="submit"
        disabled={submitting}
        className="bg-gold/20 text-gold-ink border border-gold/40 hover:bg-gold/30 disabled:opacity-50 rounded px-2.5 py-1 font-medium"
      >
        {submitting ? "…" : "Add"}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setError(null);
        }}
        disabled={submitting}
        className="text-ink-faint hover:text-ink-dim"
      >
        Cancel
      </button>
      {error && <span className="text-[11px] text-down w-full">{error}</span>}
    </form>
  );
}
