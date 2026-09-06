"use client";

/**
 * Inline "+ Add ticker" form for the Earnings Hub. Posts to
 * /api/calendar/events with source='manual' and reloads the page so the
 * new row surfaces in the deduped query immediately.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addDays, defaultDateWithinWeek, mondayOf } from "@/lib/calendar/date-utils";
import apiFetch, { type ApiFetch } from "@/lib/http/apiFetch";

interface Props {
  weekOf: string;
}

export type Slot = "BMO" | "AMC";

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

/**
 * A vendor earnings date this add would knock off the calendar — the 409
 * `would_supersede_vendor` refusal from POST /api/calendar/events (user ruling
 * 2026-09-02). Nothing was written; the same add with `force: true` goes
 * through.
 */
export interface VendorSupersedeRefusal {
  /** The server's plain-English sentence — rendered as-is, never re-worded here. */
  message: string;
  vendorDate: string;
  vendorSource: string;
  vendorEventId: number | null;
}

export type ManualAddOutcome =
  | { kind: "saved"; id: number | null }
  | { kind: "supersede_refused"; refusal: VendorSupersedeRefusal }
  | { kind: "failed"; message: string };

interface ManualAddInput {
  symbol: string;
  date: string;
  slot: Slot;
  /** Skip the would-supersede-a-vendor-date check (the user confirmed). */
  force?: boolean;
}

/**
 * POST the "+ Add ticker" row and classify the reply into the three outcomes
 * the form can act on. Extracted from the component so the network contract is
 * directly testable in Node (this repo has no DOM harness) — including that the
 * confirm path re-sends the identical add with `force: true`.
 *
 * Honest-button rules (CLAUDE.md): a 2xx is not success on its own —
 * `data.success !== true` is a failure with the server's own words; a thrown
 * fetch is reported, never swallowed.
 */
export async function postManualEarningsEvent(
  input: ManualAddInput,
  fetchImpl: ApiFetch = apiFetch,
): Promise<ManualAddOutcome> {
  try {
    const res = await fetchImpl("/api/calendar/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: input.symbol.trim().toUpperCase(),
        event_date: input.date,
        event_time: input.slot,
        event_type: "earnings",
        ...(input.force ? { force: true } : {}),
      }),
    });
    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
      id?: number;
      code?: string;
      vendorDate?: string;
      vendorSource?: string;
      vendorEventId?: number;
    } | null;

    if (
      res.status === 409 &&
      data?.code === "would_supersede_vendor" &&
      typeof data.error === "string"
    ) {
      return {
        kind: "supersede_refused",
        refusal: {
          message: data.error,
          vendorDate: data.vendorDate ?? "",
          vendorSource: data.vendorSource ?? "",
          vendorEventId: data.vendorEventId ?? null,
        },
      };
    }
    if (!res.ok || data?.success !== true) {
      return { kind: "failed", message: data?.error ?? `Server returned ${res.status}` };
    }
    return { kind: "saved", id: data.id ?? null };
  } catch (err) {
    return { kind: "failed", message: err instanceof Error ? err.message : "Network error" };
  }
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
  // Set only by a 409 would_supersede_vendor: the add was REFUSED and nothing
  // was written, so the form stays open with the typed values and asks. Same
  // shape as the alerts inbox's arm-refusal confirm.
  const [supersede, setSupersede] = useState<VendorSupersedeRefusal | null>(null);

  async function save(force: boolean) {
    if (!symbol.trim()) {
      setError("Symbol is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setSupersede(null);
    try {
      const outcome = await postManualEarningsEvent({ symbol, date, slot, force });
      if (outcome.kind === "supersede_refused") {
        setSupersede(outcome.refusal);
        return;
      }
      if (outcome.kind === "failed") {
        setError(outcome.message);
        return;
      }
      // Reset + close + reload server component; the cockpit is a client
      // poller and needs its own signal to pick up the new reporter now.
      setOutOfWeekNote(outOfWeekSaveNote(date, weekOf));
      setSymbol("");
      setOpen(false);
      window.dispatchEvent(new Event("earnings-data-changed"));
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await save(false);
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
          setSupersede(null);
        }}
        disabled={submitting}
        className="text-ink-faint hover:text-ink-dim"
      >
        Cancel
      </button>
      {error && <span className="text-[11px] text-down w-full">{error}</span>}
      {supersede && (
        // gold-ink, not amber-*: the amber palette is dark-tuned and washes
        // out on the light theme's panel; gold-ink is the house pair for
        // readable small gold text in BOTH themes (see the same confirm on
        // app/dashboard/alerts/page.tsx).
        <div className="w-full rounded-lg border border-gold/30 bg-gold/10 p-2 text-[11px] text-gold-ink">
          {supersede.message}
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => save(true)}
              disabled={submitting}
              className="px-3 py-1 text-[11px] font-semibold rounded border border-gold-ink/40 text-gold-ink hover:bg-gold/10 disabled:opacity-50"
            >
              {submitting ? "Adding…" : "Add anyway (replaces the vendor date)"}
            </button>
            <button
              type="button"
              onClick={() => setSupersede(null)}
              disabled={submitting}
              className="px-3 py-1 text-[11px] rounded text-ink-dim hover:text-ink disabled:opacity-50"
            >
              Keep the vendor date
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
