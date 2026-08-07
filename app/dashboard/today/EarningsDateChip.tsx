"use client";

import { useLayoutEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  symbol: string;
  eventDate: string; // the canonical (Nasdaq, on conflict) date
  releaseTime: string | null;
  dateStatus: "confirmed" | "conflict" | "single" | "user_confirmed" | null | undefined;
  dateConflictWith: string | null | undefined; // "finnhub:YYYY-MM-DD"
  /**
   * Called after a successful confirm, alongside router.refresh(). Client
   * components holding the conflict list in fetch-state (the Alerts inbox
   * Conflicts view) need this — router.refresh() only re-renders server
   * components, so their list would stay stale without it.
   */
  onConfirmed?: () => void;
  /**
   * Which edge the confirm popover anchors to. Default "left" (EarningsHub —
   * chip sits at the row's left, popover opens rightward). Pass "right" when
   * the chip sits at a row's RIGHT edge (Alerts Conflicts view) — a rightward
   * popover there runs off a 390px viewport and forces page-wide horizontal
   * scroll.
   */
  popoverAlign?: "left" | "right";
}

function fmtShort(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

interface ReleaseTimeState {
  resolved: { time: string; source: string } | null;
  override: { source: string; release_time: string } | null;
}

/**
 * "Reports at" wire-time editor (spec 2026-08-04, Task 5; hoisted for Task 4
 * so both the passive-status popover AND the conflict popover can render it
 * without a component-in-component remount trap). Pure display + delegates
 * to the parent's loadReleaseTime/saveReleaseTime — no fetch logic here.
 */
function ReleaseTimeEditor({
  rt,
  releaseTime,
  rtEdit,
  onRtEditChange,
  rtSaving,
  rtMsg,
  onSave,
}: {
  rt: ReleaseTimeState | null;
  releaseTime: string | null;
  rtEdit: string;
  onRtEditChange: (value: string) => void;
  rtSaving: boolean;
  rtMsg: string | null;
  onSave: (value: string | null) => void;
}) {
  return (
    <div className="mt-2 pt-1.5 border-t border-edge">
      <p className="text-[11px] text-ink mb-1">
        Reports at{" "}
        <span className="font-mono">{rt?.resolved?.time ?? releaseTime ?? "—"}</span>
        {rt?.resolved && <span className="text-ink-faint"> · {rt.resolved.source}</span>}
      </p>
      <div className="flex items-center gap-1">
        <input
          type="time"
          value={rtEdit}
          onChange={(e) => onRtEditChange(e.target.value)}
          className="text-[10px] bg-raised rounded px-1 py-0.5 flex-1 min-w-0 text-ink"
          aria-label="Standing release-time override (ET)"
        />
        <button
          type="button"
          disabled={rtSaving || !rtEdit}
          onClick={() => onSave(rtEdit)}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded text-up bg-up/15 hover:bg-up/25 disabled:opacity-40 whitespace-nowrap"
        >
          Save
        </button>
        {rt?.override?.source === "user" && (
          <button
            type="button"
            disabled={rtSaving}
            onClick={() => onSave(null)}
            className="text-[10px] font-mono px-1.5 py-0.5 rounded text-ink-dim bg-raised hover:bg-muted disabled:opacity-40"
          >
            Clear
          </button>
        )}
      </div>
      {rtMsg && <p className="text-[10px] text-ink-dim pt-1">{rtMsg}</p>}
    </div>
  );
}

/**
 * Earnings date trust chip + popovers.
 *
 * - confirmed       → "✓ 2 src" (Finnhub + Nasdaq agree)
 * - single          → "1 src"
 * - user_confirmed  → "🔒" (you locked the IBKR-definitive date)
 * - conflict        → "⚠ confirm" → popover: pick Nasdaq / Finnhub / your own
 *                     date → POST /api/earnings/confirm-date → locked forever.
 * - null            → nothing (row not reconciled yet)
 *
 * Every non-null status is tappable (feedback #7, 2026-08-03): the three
 * passive statuses open a "Date is wrong?" popover — date (pre-filled) +
 * BMO/AMC + Fix date → POST /api/earnings/correct-date, which wraps
 * correctEarningsEventDate (suppress+delete wrong rows, manual-row mint or
 * vendor-row adoption, bogeys migration, refusal on captured actuals). The
 * refusal message renders inline verbatim; the popover stays open on failure.
 */
export function EarningsDateChip({
  symbol,
  eventDate,
  releaseTime,
  dateStatus,
  dateConflictWith,
  onConfirmed,
  popoverAlign = "left",
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState<"bmo" | "amc">(
    releaseTime && releaseTime < "12:00" ? "bmo" : "amc",
  );
  // Fix-date form (non-conflict statuses, feedback #7). Pre-filled with the
  // current event date so a slot-only fix is one select away.
  const [fixDate, setFixDate] = useState(eventDate);
  const [fixSlot, setFixSlot] = useState<"bmo" | "amc">(
    releaseTime && releaseTime < "12:00" ? "bmo" : "amc",
  );
  // "Reports at" wire-time editor (spec 2026-08-04, Task 5): standing
  // per-symbol release-time override, fetched lazily on popover open.
  const [rt, setRt] = useState<ReleaseTimeState | null>(null);
  const [rtEdit, setRtEdit] = useState("");
  const [rtSaving, setRtSaving] = useState(false);
  const [rtMsg, setRtMsg] = useState<string | null>(null);

  // Viewport-aware popover alignment (QA 2026-08-07): popoverAlign is a
  // static hint from the call site, but the chip's actual position decides
  // whether that edge fits — a conflict chip near the LEFT gutter with
  // popoverAlign="right" pushed the 240px popover to x=-142 on a 390px
  // viewport, leaving the date options unreadable mid-correction. Measure on
  // open and flip the alignment when the requested edge would overflow while
  // the opposite edge fits.
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const [alignOverride, setAlignOverride] = useState<"left" | "right" | null>(null);
  const POPOVER_W = 240; // matches w-60
  const EDGE_PAD = 8;
  useLayoutEffect(() => {
    if (!open) {
      setAlignOverride(null);
      return;
    }
    const measure = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const vw = window.innerWidth;
      if (
        popoverAlign === "right" &&
        rect.right - POPOVER_W < EDGE_PAD &&
        rect.left + POPOVER_W <= vw - EDGE_PAD
      ) {
        setAlignOverride("left");
      } else if (
        popoverAlign === "left" &&
        rect.left + POPOVER_W > vw - EDGE_PAD &&
        rect.right - POPOVER_W >= EDGE_PAD
      ) {
        setAlignOverride("right");
      } else {
        setAlignOverride(null);
      }
    };
    measure();
    // Re-measure while open: phone rotation changes the viewport under a
    // popover that has no dismiss handler, re-creating the offscreen bug
    // with a stale alignment.
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [open, popoverAlign]);
  const resolvedAlign = alignOverride ?? popoverAlign;

  const slotParam = releaseTime && releaseTime < "12:00" ? "bmo" : "amc";

  async function loadReleaseTime() {
    // Every popover open starts message-clean — otherwise a stale
    // success/error from a prior save lingers beside freshly-fetched data
    // after close → reopen.
    setRtMsg(null);
    try {
      const res = await fetch(
        `/api/earnings/release-time?symbol=${encodeURIComponent(symbol)}&slot=${slotParam}`,
      );
      const body = await res.json().catch(() => null);
      if (body?.success) {
        setRt(body.data);
        setRtEdit(body.data.override?.release_time ?? body.data.resolved?.time ?? releaseTime ?? "");
      }
    } catch {
      /* popover shows the stored releaseTime fallback */
    }
  }

  async function saveReleaseTime(value: string | null) {
    if (rtSaving) return;
    setRtSaving(true);
    setRtMsg(null);
    try {
      const res = await fetch("/api/earnings/release-time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, releaseTime: value }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        setRtMsg(body?.error ?? `Save failed: server returned ${res.status}.`);
        return;
      }
      setRtMsg(
        value === null
          ? `Override cleared · ${body.data.updatedEvents} upcoming event(s) re-resolved`
          : `Saved · ${body.data.updatedEvents} upcoming event(s) updated`,
      );
      await loadReleaseTime();
      startTransition(() => router.refresh());
    } catch {
      setRtMsg("Save failed: could not reach the server.");
    } finally {
      setRtSaving(false);
    }
  }

  // Submitting the pre-filled form unchanged used to doom the vendor row and
  // write a permanent sync suppression for zero semantic change — the server
  // now 400s it (code no_change) and the button stays disabled client-side.
  const noChange = fixDate === eventDate && fixSlot === slotParam;

  async function submitCorrection() {
    if (submitting || !fixDate) return;
    setSubmitting(true);
    setConfirmError(null);
    try {
      const res = await fetch("/api/earnings/correct-date", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          wrongDate: eventDate,
          correctDate: fixDate,
          slot: fixSlot,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        // Keep the popover open — the server's reason (e.g. the
        // captured-actuals refusal) must stay readable.
        setConfirmError(body?.error ?? `Fix failed: server returned ${res.status}.`);
        return;
      }
      setOpen(false);
      onConfirmed?.();
      startTransition(() => router.refresh());
    } catch {
      setConfirmError("Fix failed: could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!dateStatus) return null;

  if (dateStatus !== "conflict") {
    const passive = {
      confirmed: {
        label: "✓ 2 src",
        cls: "text-up/80",
        line: "Confirmed by Finnhub + Nasdaq",
      },
      single: {
        label: "1 src",
        cls: "text-ink-faint",
        line: "Only one calendar source has this date",
      },
      user_confirmed: {
        label: "🔒",
        cls: "text-ink-dim",
        line: "You confirmed this date (locked)",
      },
    }[dateStatus];

    return (
      <span ref={wrapRef} className="relative inline-flex">
        <button
          type="button"
          onClick={() => {
            setOpen((o) => !o);
            if (!open) void loadReleaseTime();
          }}
          disabled={pending}
          className={`text-[10px] font-mono cursor-pointer disabled:opacity-50 ${passive.cls} relative pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 pointer-coarse:after:content-['']`}
          title={`${passive.line} — tap to fix a wrong date/slot`}
        >
          {passive.label}
        </button>
        {open && (
          // z-[55]: must paint above the fixed chat rail (z-50) — same
          // rail-tie family as the conflict popover below.
          <div
            className={`absolute z-[55] top-full mt-1 w-60 rounded-lg border border-edge bg-panel p-2 shadow-lg text-left ${
              resolvedAlign === "right" ? "right-0" : "left-0"
            }`}
          >
            <p className="text-[11px] text-ink-dim">
              {fmtShort(eventDate)} · {passive.line}
            </p>
            <p className="text-[11px] text-ink mt-1.5 mb-1">Date is wrong?</p>
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={fixDate}
                onChange={(e) => setFixDate(e.target.value)}
                className="text-[10px] bg-raised rounded px-1 py-0.5 flex-1 min-w-0 text-ink"
                aria-label="Corrected earnings date"
              />
              <select
                value={fixSlot}
                onChange={(e) => setFixSlot(e.target.value as "bmo" | "amc")}
                className="text-[10px] bg-raised rounded px-0.5 py-0.5 text-ink"
                aria-label="Corrected release slot"
              >
                <option value="bmo">BMO</option>
                <option value="amc">AMC</option>
              </select>
              <button
                type="button"
                disabled={submitting || !fixDate || noChange}
                title={noChange ? "Change the date or slot first" : undefined}
                onClick={submitCorrection}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded text-up bg-up/15 hover:bg-up/25 disabled:opacity-40 whitespace-nowrap"
              >
                Fix date
              </button>
            </div>
            <ReleaseTimeEditor
              rt={rt}
              releaseTime={releaseTime}
              rtEdit={rtEdit}
              onRtEditChange={setRtEdit}
              rtSaving={rtSaving}
              rtMsg={rtMsg}
              onSave={saveReleaseTime}
            />
            {confirmError && (
              <p className="text-[10px] text-down pt-1">{confirmError}</p>
            )}
          </div>
        )}
      </span>
    );
  }

  // conflict
  const finnDate = dateConflictWith?.split(":")[1] ?? null;
  const defaultTime = customTime;

  async function confirm(date: string, time: "bmo" | "amc") {
    if (submitting) return;
    setSubmitting(true);
    setConfirmError(null);
    try {
      const res = await fetch("/api/earnings/confirm-date", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, confirmedDate: date, confirmedTime: time }),
      });
      if (!res.ok) {
        // Keep the popover open — closing on a rejected confirm makes the
        // chip look resolved when the conflict is still live.
        const body = await res.json().catch(() => null);
        setConfirmError(`Confirm failed: ${body?.error ?? `server returned ${res.status}`}.`);
        return;
      }
      setOpen(false);
      onConfirmed?.();
      startTransition(() => router.refresh());
    } catch {
      setConfirmError("Confirm failed: could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void loadReleaseTime();
        }}
        disabled={pending}
        className="text-[10px] font-mono px-1.5 py-0.5 rounded text-gold-ink bg-gold/15 hover:bg-gold/25 disabled:opacity-50 cursor-pointer"
        title="Sources disagree on the date — confirm against IBKR"
      >
        ⚠ confirm
      </button>
      {open && (
        // z-[55]: must paint above the fixed chat rail (z-50) — same
        // rail-tie family as the Analysis drawer fix (trust-strip precedent).
        <div
          className={`absolute z-[55] top-full mt-1 w-60 rounded-lg border border-edge bg-panel p-2 shadow-lg text-left ${
            resolvedAlign === "right" ? "right-0" : "left-0"
          }`}
        >
          <p className="text-[11px] text-ink-dim mb-1.5">
            Sources disagree — pick the IBKR date:
          </p>
          <div className="space-y-1">
            <button
              type="button"
              disabled={submitting}
              onClick={() => confirm(eventDate, defaultTime)}
              className="w-full text-left text-[11px] font-mono px-2 py-1 rounded bg-raised hover:bg-muted disabled:opacity-50"
            >
              Nasdaq · {fmtShort(eventDate)}
            </button>
            {finnDate && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => confirm(finnDate, defaultTime)}
                className="w-full text-left text-[11px] font-mono px-2 py-1 rounded bg-raised hover:bg-muted disabled:opacity-50"
              >
                Finnhub · {fmtShort(finnDate)}
              </button>
            )}
            <div className="flex items-center gap-1 pt-1.5 mt-1 border-t border-edge">
              <input
                type="date"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                className="text-[10px] bg-raised rounded px-1 py-0.5 flex-1 min-w-0 text-ink"
                aria-label="Custom earnings date"
              />
              <select
                value={customTime}
                onChange={(e) => setCustomTime(e.target.value as "bmo" | "amc")}
                className="text-[10px] bg-raised rounded px-0.5 py-0.5 text-ink"
                aria-label="Release time"
              >
                <option value="bmo">BMO</option>
                <option value="amc">AMC</option>
              </select>
              <button
                type="button"
                disabled={submitting || !customDate}
                onClick={() => customDate && confirm(customDate, customTime)}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded text-up bg-up/15 hover:bg-up/25 disabled:opacity-40"
              >
                ok
              </button>
            </div>
          </div>
          <ReleaseTimeEditor
            rt={rt}
            releaseTime={releaseTime}
            rtEdit={rtEdit}
            onRtEditChange={setRtEdit}
            rtSaving={rtSaving}
            rtMsg={rtMsg}
            onSave={saveReleaseTime}
          />
          {confirmError && (
            <p className="text-[10px] text-down pt-1">{confirmError}</p>
          )}
        </div>
      )}
    </span>
  );
}
