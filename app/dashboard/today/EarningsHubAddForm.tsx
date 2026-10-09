"use client";

/**
 * Inline "+ Add ticker" form for the Earnings Hub. Posts to
 * /api/calendar/events with source='manual' and reloads the page so the
 * new row surfaces in the deduped query immediately.
 */

import { CHIP_TONE_CLASSES } from "@/app/dashboard/components/Chip";
import { CHIP_TONE_TEXT } from "@/app/dashboard/components/chip-tone-text";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { addDays, defaultDateWithinWeek, mondayOf } from "@/lib/calendar/date-utils";
import apiFetch, { type ApiFetch } from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";

interface Props {
  weekOf: string;
}

export type Slot = "BMO" | "AMC";
/** The slot a freshly opened form shows. */
export const DEFAULT_SLOT: Slot = "AMC";

// The server's MAX_TICKER_LENGTH (lib/calendar/manual-event-input.ts), which a
// client file may not value-import; a test pins the two together.
export const TICKER_INPUT_MAX_LENGTH = 12;

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
 * Where the row from an out-of-week save can be seen: the week-ahead view for
 * the week it filed under (same URL shape as WeekAheadView's own week links).
 * Null when the date is within the shown week — the row is already in view.
 */
export function outOfWeekSaveLink(
  date: string,
  weekOf: string,
): { href: string; label: string } | null {
  if (outOfWeekSaveNote(date, weekOf) === null) return null;
  const monday = mondayOf(date);
  return {
    href: `/dashboard/today?view=week-ahead&weekOf=${monday}`,
    label: `View week of ${monday}`,
  };
}

/**
 * The question asked before a Saturday or Sunday date is saved (owner ruling
 * 2026-08-18: warn, never block). Null on a weekday, so a normal add is never
 * interrupted. Asked in the form itself, before any request is sent; it is
 * not one of the server's guards and sends no flag.
 */
export function weekendSaveWarning(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  // Noon UTC: the weekday of a calendar date, whatever the browser's zone.
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (day !== 0 && day !== 6) return null;
  return (
    `${date} is a ${day === 6 ? "Saturday" : "Sunday"}. US markets are closed, and weekend ` +
    `earnings prints are almost unheard of. Save anyway?`
  );
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

/**
 * The chosen BMO/AMC slot contradicts the symbol's known release time — the
 * 409 `slot_contradicts_known_time` refusal (user ruling 2026-10-05). Nothing
 * was written; the same add with `forceSlot: true` goes through and stores
 * the slot's default time instead of the contradicting remembered one.
 */
export interface SlotContradictionRefusal {
  /** The server's plain-English sentence — rendered as-is. */
  message: string;
  knownTime: string;
  slotDefaultTime: string;
}

export type ManualAddOutcome =
  | { kind: "saved"; id: number | null }
  | { kind: "supersede_refused"; refusal: VendorSupersedeRefusal }
  | { kind: "slot_refused"; refusal: SlotContradictionRefusal }
  | { kind: "failed"; message: string };

interface ManualAddInput {
  symbol: string;
  date: string;
  slot: Slot;
  /** Skip ONLY the would-supersede-a-vendor-date check (the user confirmed it). */
  force?: boolean;
  /** Skip ONLY the slot-contradicts-known-time check (the user confirmed it). */
  forceSlot?: boolean;
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
        ...(input.forceSlot ? { forceSlot: true } : {}),
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
      knownTime?: string;
      slotDefaultTime?: string;
    } | null;

    if (
      res.status === 409 &&
      data?.code === "slot_contradicts_known_time" &&
      typeof data.error === "string"
    ) {
      return {
        kind: "slot_refused",
        refusal: {
          message: data.error,
          knownTime: data.knownTime ?? "",
          slotDefaultTime: data.slotDefaultTime ?? "",
        },
      };
    }

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

/**
 * Undo an add: DELETE the manual row just created, through the same route the
 * row's own remove control uses. Honest result handling: a refusal carries the
 * server's words, an unreachable server is named as such.
 */
export async function undoManualEarningsAdd(
  eventId: number,
  fetchImpl: ApiFetch = apiFetch,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetchImpl("/api/calendar/events", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: eventId }),
    });
    const result = await readMutationResult(res);
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true };
  } catch {
    return { ok: false, message: networkFailureMessage("undo that entry") };
  }
}

/** Which of the two server warnings the user has answered for THIS add. */
interface GuardAcks {
  force: boolean;
  forceSlot: boolean;
}
const NO_ACKS: GuardAcks = { force: false, forceSlot: false };

export function EarningsHubAddForm({ weekOf }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [date, setDate] = useState(() => defaultDateWithinWeek(weekOf));
  const [slot, setSlot] = useState<Slot>(DEFAULT_SLOT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outOfWeekNote, setOutOfWeekNote] = useState<string | null>(null);
  const [outOfWeekLink, setOutOfWeekLink] = useState<{ href: string; label: string } | null>(null);
  // The id of the row an out-of-week save just created, so the notice can offer
  // Undo. Null for an in-week save (the row is in view) or once undone.
  const [undoId, setUndoId] = useState<number | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  // Set only by a 409 would_supersede_vendor: the add was REFUSED and nothing
  // was written, so the form stays open with the typed values and asks. Same
  // shape as the alerts inbox's arm-refusal confirm.
  const [supersede, setSupersede] = useState<VendorSupersedeRefusal | null>(null);
  // Same contract for a 409 slot_contradicts_known_time: refused, nothing
  // written, the form asks inline (never a browser dialog).
  const [slotRefusal, setSlotRefusal] = useState<SlotContradictionRefusal | null>(null);
  // Each warning has its own acknowledgement. One already given is carried
  // into the resend if the OTHER guard then fires, so the user clicks at most
  // once per warning — and never answers a warning they were not shown.
  const [acks, setAcks] = useState<GuardAcks>(NO_ACKS);
  // The weekend question for the date now in the form, or null. Asked before
  // the request, so it is answered before either server guard can fire.
  const [weekendAsk, setWeekendAsk] = useState<string | null>(null);

  // A refusal (and any acknowledgement of it) is about the exact ticker, date
  // and slot that were checked. Changing any of them is a new question: drop
  // BOTH stored refusals and both acks, so "Add anyway" can never force-add a
  // symbol or date the server did not check.
  function resetGuards() {
    setWeekendAsk(null);
    setSupersede(null);
    setSlotRefusal(null);
    setAcks(NO_ACKS);
  }

  async function save(nextAcks: GuardAcks) {
    if (!symbol.trim()) {
      setError("Symbol is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setWeekendAsk(null);
    setSupersede(null);
    setSlotRefusal(null);
    setAcks(nextAcks);
    try {
      const outcome = await postManualEarningsEvent({ symbol, date, slot, ...nextAcks });
      if (outcome.kind === "slot_refused") {
        setSlotRefusal(outcome.refusal);
        return;
      }
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
      setOutOfWeekLink(outOfWeekSaveLink(date, weekOf));
      setUndoError(null);
      setUndoId(outOfWeekSaveNote(date, weekOf) !== null ? outcome.id : null);
      setAcks(NO_ACKS);
      setSymbol("");
      setOpen(false);
      window.dispatchEvent(new Event("earnings-data-changed"));
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function undo() {
    if (undoId === null) return;
    setUndoing(true);
    setUndoError(null);
    try {
      const result = await undoManualEarningsAdd(undoId);
      if (!result.ok) {
        // The row is still there: keep the notice and Undo, say why.
        setUndoError(result.message);
        return;
      }
      setUndoId(null);
      setOutOfWeekNote(null);
      setOutOfWeekLink(null);
      window.dispatchEvent(new Event("earnings-data-changed"));
      router.refresh();
    } finally {
      setUndoing(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // A weekend date is confirmed first; "Save anyway" below then sends the
    // same plain add. Skipped with no ticker so "Symbol is required" shows.
    const weekend = symbol.trim() ? weekendSaveWarning(date) : null;
    if (weekend) {
      setError(null);
      resetGuards();
      setWeekendAsk(weekend);
      return;
    }
    // A plain "Add" is a fresh question — it carries no acknowledgement.
    await save(NO_ACKS);
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
            // The slot resets with the ticker and the date: a second add must
            // not inherit the previous entry's BMO/AMC choice.
            setSlot(DEFAULT_SLOT);
            setOpen(true);
          }}
          className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3 pointer-coarse:after:-inset-x-2 text-[14px] font-medium text-gold-ink hover:text-gold"
        >
          + Add ticker
        </button>
        {outOfWeekNote && (
          <span className="text-[11px] text-ink-faint italic">{outOfWeekNote}</span>
        )}
        {outOfWeekNote && outOfWeekLink && (
          <Link
            href={outOfWeekLink.href}
            className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3 pointer-coarse:after:-inset-x-2 text-[12px] font-medium text-gold-ink underline underline-offset-2 hover:text-gold whitespace-nowrap"
          >
            {outOfWeekLink.label}
          </Link>
        )}
        {outOfWeekNote && undoId !== null && (
          <button
            type="button"
            onClick={undo}
            disabled={undoing}
            className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3 pointer-coarse:after:-inset-x-2 text-[12px] font-medium text-gold-ink underline underline-offset-2 hover:text-gold disabled:opacity-50 whitespace-nowrap"
          >
            {undoing ? "Undoing…" : "Undo"}
          </button>
        )}
        {undoError && <span className="text-[11px] text-down w-full">{undoError}</span>}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 text-[14px]">
      <input
        type="text"
        value={symbol}
        onChange={(e) => {
          setSymbol(e.target.value.toUpperCase());
          resetGuards();
        }}
        placeholder="TICKER"
        autoFocus
        className="font-mono uppercase bg-raised border border-edge rounded px-2 py-1 w-20 text-ink focus:outline-none focus:border-gold"
        maxLength={TICKER_INPUT_MAX_LENGTH}
      />
      <input
        type="date"
        value={date}
        onChange={(e) => {
          setDate(e.target.value);
          resetGuards();
        }}
        className="bg-raised border border-edge rounded px-2 py-1 text-ink focus:outline-none focus:border-gold"
      />
      <select
        value={slot}
        onChange={(e) => {
          setSlot(e.target.value as Slot);
          resetGuards();
        }}
        className="bg-raised border border-edge rounded px-2 py-1 text-ink focus:outline-none focus:border-gold"
      >
        {/* Labels carry no clock time (user ruling 2026-10-05): the stored
            time is the symbol's own when it agrees with the slot, so a
            printed default here was a promise the server did not keep. */}
        <option value="BMO">BMO</option>
        <option value="AMC">AMC</option>
      </select>
      <button
        type="submit"
        disabled={submitting}
        className={`${CHIP_TONE_CLASSES.gold} border border-gold/40 hover:bg-gold/30 disabled:opacity-50 rounded px-2.5 py-1 font-medium`}
      >
        {submitting ? "…" : "Add"}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setError(null);
          resetGuards();
        }}
        disabled={submitting}
        className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3 pointer-coarse:after:-inset-x-2 text-ink-faint hover:text-ink-dim"
      >
        Cancel
      </button>
      {error && <span className="text-[11px] text-down w-full">{error}</span>}
      {weekendAsk && (
        <div className={`w-full rounded-lg border border-gold/30 bg-gold/10 p-2 text-[11px] ${CHIP_TONE_TEXT.gold}`}>
          {weekendAsk}
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => save(NO_ACKS)}
              disabled={submitting}
              className="px-3 py-1 text-[11px] font-semibold rounded border border-gold-ink/40 text-gold-ink hover:bg-gold/10 disabled:opacity-50"
            >
              {submitting ? "Adding…" : "Save anyway"}
            </button>
            <button
              type="button"
              onClick={resetGuards}
              disabled={submitting}
              className="px-3 py-1 text-[11px] rounded text-ink-dim hover:text-ink disabled:opacity-50"
            >
              Change the date
            </button>
          </div>
        </div>
      )}
      {slotRefusal && (
        <div className={`w-full rounded-lg border border-gold/30 bg-gold/10 p-2 text-[11px] ${CHIP_TONE_TEXT.gold}`}>
          {slotRefusal.message}
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => save({ ...acks, forceSlot: true })}
              disabled={submitting}
              className="px-3 py-1 text-[11px] font-semibold rounded border border-gold-ink/40 text-gold-ink hover:bg-gold/10 disabled:opacity-50"
            >
              {submitting ? "Adding…" : `Add anyway as ${slot}`}
            </button>
            <button
              type="button"
              onClick={resetGuards}
              disabled={submitting}
              className="px-3 py-1 text-[11px] rounded text-ink-dim hover:text-ink disabled:opacity-50"
            >
              Change the slot
            </button>
          </div>
        </div>
      )}
      {supersede && (
        // gold-ink, not amber-*: the amber palette is dark-tuned and washes
        // out on the light theme's panel; gold-ink is the house pair for
        // readable small gold text in BOTH themes (see the same confirm on
        // app/dashboard/alerts/page.tsx).
        <div className={`w-full rounded-lg border border-gold/30 bg-gold/10 p-2 text-[11px] ${CHIP_TONE_TEXT.gold}`}>
          {supersede.message}
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => save({ ...acks, force: true })}
              disabled={submitting}
              className="px-3 py-1 text-[11px] font-semibold rounded border border-gold-ink/40 text-gold-ink hover:bg-gold/10 disabled:opacity-50"
            >
              {submitting ? "Adding…" : "Add anyway (replaces the vendor date)"}
            </button>
            <button
              type="button"
              onClick={resetGuards}
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
