"use client";

/**
 * Inline "+ Add ticker" form for the Earnings Hub. Posts to
 * /api/calendar/events with source='manual' and reloads the page so the
 * new row surfaces in the deduped query immediately.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  weekOf: string;
}

type Slot = "BMO" | "AMC";

export function EarningsHubAddForm({ weekOf: _weekOf }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [date, setDate] = useState(today());
  const [slot, setSlot] = useState<Slot>("AMC");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!symbol.trim()) {
      setError("Symbol is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/calendar/events", {
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
      // Reset + close + reload server component
      setSymbol("");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[12px] font-medium text-gold hover:text-gold/80"
      >
        + Add ticker
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 text-[12px]">
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
        className="bg-gold/20 text-gold border border-gold/40 hover:bg-gold/30 disabled:opacity-50 rounded px-2.5 py-1 font-medium"
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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
