"use client";

import { CHIP_TONE_TEXT } from "@/app/dashboard/components/chip-tone-text";
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addDays, MAX_EARNINGS_DAYS_AHEAD, todayET } from "@/lib/calendar/date-utils";
import apiFetch from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
import { EARNINGS_DATE_CORRECTED_EVENT } from "./EarningsHubDateCorrectionNote";
import { Chip } from "../components/Chip";
import { ConfirmDialog } from "../components/ConfirmDialog";

interface Props {
  symbol: string;
  eventDate: string; // the canonical (Nasdaq, on conflict) date
  releaseTime: string | null;
  dateStatus: "confirmed" | "conflict" | "single" | "user_confirmed" | null | undefined;
  dateConflictWith: string | null | undefined; // "finnhub:YYYY-MM-DD"
  /**
   * The row's `calendar_events.source`. A hand-entered (`manual`) row with no
   * date status still gets a chip; see `earningsDateChipKind`.
   */
  source?: string | null;
  /**
   * When set, the chip is wrapped in a span with this class. The wrapper is
   * rendered only when a chip is, so a server-component caller needs no gate
   * of its own (and cannot disagree with `earningsDateChipKind`).
   */
  wrapperClassName?: string;
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

export type EarningsDateChipKind =
  | "confirmed"
  | "single"
  | "user_confirmed"
  | "conflict"
  | "hand_entered";

/**
 * Which chip a row gets. A stored date status always decides. With none, a
 * hand-entered row gets the neutral "hand_entered" chip so its date, slot and
 * release time stay editable; any other row gets no chip, as before.
 *
 * The calendar sync never writes `user_confirmed` (owner ruling 2026-09-14),
 * so an unconfirmed hand-entered row has an empty status. "hand_entered" is a
 * DISPLAY kind only: it is never stored and never claims a confirmation.
 */
export function earningsDateChipKind(
  source: string | null | undefined,
  dateStatus: Props["dateStatus"],
): EarningsDateChipKind | null {
  if (dateStatus) return dateStatus;
  return source === "manual" ? "hand_entered" : null;
}

export const HAND_ENTERED_LABEL = "Entered by you";
export const HAND_ENTERED_LINE = "You entered this date by hand";

function fmtShort(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export interface ReleaseTimeState {
  resolved: { time: string; source: string } | null;
  override: StandingOverride | null;
  /**
   * How the resolver treats the standing row for this row's slot, as GET
   * /api/earnings/release-time returns it. Absent or "in_effect" = used.
   */
  overrideUse?: "in_effect" | "suspect_call_time" | "not_in_effect" | null;
}

/** The symbol's standing release-time row, as GET /api/earnings/release-time returns it. */
export interface StandingOverride {
  source: string;
  release_time: string;
  note?: string | null;
  verified_for_date?: string | null;
}

/**
 * The editor writes ONE standing time per ticker, so a Save on one row also
 * re-times the ticker's other upcoming rows. Said in the editor before the
 * Save (decision 2026-10-07).
 */
export function symbolWideNote(symbol: string): string {
  const prints = symbol.trim() ? `every ${symbol.trim().toUpperCase()} print` : "every print of this ticker";
  return `One standing time for ${prints}, not only this row.`;
}

/**
 * The standing override a Save would replace: its time, who set it, the date
 * it was verified for and its note. Null when the ticker has none. The store
 * keeps one row per ticker and a Save overwrites the note and the verified
 * date with it, so the line says so.
 */
export function standingOverrideLine(override: StandingOverride | null | undefined): string | null {
  if (!override) return null;
  const who =
    override.source === "user"
      ? "set by you"
      : override.source === "web_verified"
        ? "web-verified"
        : override.source;
  const parts = [override.release_time, who];
  if (override.verified_for_date) parts.push(`verified for ${override.verified_for_date}`);
  const note = override.note?.trim();
  if (note) parts.push(`“${note}”`);
  return `Standing: ${parts.join(" · ")}. Save changes the time and keeps the note.`;
}

/**
 * The time the "Reports at" line shows: the ROW'S OWN stored time, else the
 * ticker's resolved time. The row comes first (unit 17, 2026-10-08): a row can
 * keep a time the ticker-wide resolution does not give it (a reported row is
 * not re-timed by a Save; a row can carry its own explicit time), and the
 * popover used to show the ticker's time against a row reading another.
 */
export function reportsAtTime(rt: ReleaseTimeState | null, releaseTime: string | null): string | null {
  return releaseTime ?? rt?.resolved?.time ?? null;
}

/** The source tag beside the shown time: only when it IS the resolved time. */
export function reportsAtSource(rt: ReleaseTimeState | null, releaseTime: string | null): string | null {
  const resolved = rt?.resolved;
  if (!resolved) return null;
  return resolved.time === reportsAtTime(rt, releaseTime) ? resolved.source : null;
}

/** True when the standing row is one the resolver actually uses. */
function standingIsUsed(rt: ReleaseTimeState | null): boolean {
  if (!rt?.override) return false;
  return rt.overrideUse !== "suspect_call_time" && rt.overrideUse !== "not_in_effect";
}

/**
 * Said under the standing line when the app does not use the standing time.
 * A web-verified after-close time at or after 17:00 is a suspect call time
 * and is never trusted.
 */
export function standingNotUsedLine(rt: ReleaseTimeState | null): string | null {
  if (!rt?.override || standingIsUsed(rt)) return null;
  return rt.overrideUse === "suspect_call_time"
    ? "Not used: 17:00 or later after the close is usually the call, not the release."
    : "Not used for this row.";
}

/**
 * Said when the ticker's standing time is in use but this row keeps another
 * time, so the two times on screen are explained rather than contradictory.
 */
export function standingNotAppliedLine(
  rt: ReleaseTimeState | null,
  releaseTime: string | null,
): string | null {
  const resolved = rt?.resolved;
  if (!resolved || !releaseTime) return null;
  if (resolved.source !== "user" && resolved.source !== "web_verified") return null;
  if (resolved.time === releaseTime) return null;
  return `The standing time ${resolved.time} is not applied to this row.`;
}

/** Mirrors WOULD_REPLACE_WEB_VERIFIED (lib/earnings/wire-times.ts); a test pins the pair. */
export const REPLACE_WEB_VERIFIED_CODE = "would_replace_web_verified";

/**
 * The question a Save must put first: the server's 409 with the named code.
 * Null for every other reply, which the shared mutation reader then handles.
 */
export function releaseTimeAskFirst(status: number, body: unknown): { message: string } | null {
  if (status !== 409 || !body || typeof body !== "object") return null;
  const { code, error } = body as { code?: unknown; error?: unknown };
  if (code !== REPLACE_WEB_VERIFIED_CODE) return null;
  if (typeof error !== "string" || !error.trim()) return null;
  return { message: error.trim() };
}

/**
 * What the override time input holds. `edited` is what the user typed, or
 * null when they have not typed since the last load or save. Untouched, the
 * input FOLLOWS the standing override when the app uses it, else the very time
 * the "Reports at" line shows, so the two cannot disagree. A standing time the
 * app ignores (a suspect call time above all) never seeds it: one Save would
 * turn it into the user's own trusted time. It used to be seeded once from the
 * row's release time, which after a Clear was still the pre-refresh value: the
 * line read the fallback while the input kept the cleared time, one Save away
 * from re-applying it.
 */
export function releaseTimeInputValue(
  edited: string | null,
  rt: ReleaseTimeState | null,
  releaseTime: string | null,
): string {
  const standing = standingIsUsed(rt) ? rt?.override?.release_time : null;
  return edited ?? standing ?? reportsAtTime(rt, releaseTime) ?? "";
}

/** The pointer-coarse hit extension the hub chrome carries on its small buttons. */
const TOUCH_EXTENSION =
  "relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5";

/**
 * "Reports at" wire-time editor (spec 2026-08-04, Task 5; hoisted for Task 4
 * so both the passive-status popover AND the conflict popover can render it
 * without a component-in-component remount trap). Pure display + delegates
 * to the parent's loadReleaseTime/saveReleaseTime — no fetch logic here.
 */
function ReleaseTimeEditor({
  symbol,
  rt,
  releaseTime,
  rtEdit,
  onRtEditChange,
  rtSaving,
  rtMsg,
  onSave,
  settling,
  ask,
  onAskConfirm,
  onAskCancel,
}: {
  symbol: string;
  rt: ReleaseTimeState | null;
  releaseTime: string | null;
  rtEdit: string;
  onRtEditChange: (value: string) => void;
  rtSaving: boolean;
  rtMsg: string | null;
  onSave: (value: string | null) => void;
  /** A save or the refresh after it is still running: the row prop may be stale. */
  settling: boolean;
  /** The server's question before a Save that would replace a web-verified time. */
  ask: string | null;
  onAskConfirm: () => void;
  onAskCancel: () => void;
}) {
  const source = reportsAtSource(rt, releaseTime);
  const notUsed = standingNotUsedLine(rt);
  const notApplied = settling ? null : standingNotAppliedLine(rt, releaseTime);
  return (
    <div className="mt-2 pt-1.5 border-t border-edge">
      <p className="text-[11px] text-ink mb-1">
        Reports at{" "}
        <span className="font-mono">{reportsAtTime(rt, releaseTime) ?? "—"}</span>
        {source && <span className="text-ink-dim"> · {source}</span>}
      </p>
      <p className="text-[10px] text-ink-dim mb-1">{symbolWideNote(symbol)}</p>
      {standingOverrideLine(rt?.override) && (
        <p className="text-[10px] text-ink-dim mb-1">{standingOverrideLine(rt?.override)}</p>
      )}
      {notUsed && <p className="text-[10px] text-ink-dim mb-1">{notUsed}</p>}
      {notApplied && <p className="text-[10px] text-ink-dim mb-1">{notApplied}</p>}
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
          className={`${TOUCH_EXTENSION} text-[10px] font-mono px-1.5 py-0.5 rounded ${CHIP_TONE_TEXT.up} bg-up/15 hover:bg-up/25 disabled:opacity-40 whitespace-nowrap`}
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
      <ConfirmDialog
        open={ask !== null}
        title="Replace the web-verified time?"
        message={ask ?? ""}
        confirmLabel="Save anyway"
        onConfirm={onAskConfirm}
        onCancel={onAskCancel}
      />
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
 * - null            → "Entered by you" on a hand-entered row (same fix-date
 *                     popover; says nothing about a confirmation), else
 *                     nothing (row not reconciled yet)
 *
 * Every non-null status is tappable (feedback #7, 2026-08-03): the three
 * passive statuses open a "Date is wrong?" popover — date (pre-filled) +
 * BMO/AMC + Fix date → POST /api/earnings/correct-date, which wraps
 * correctEarningsEventDate (suppress+delete wrong rows, manual-row mint or
 * vendor-row adoption, bogeys migration, refusal on captured actuals). The
 * refusal message renders inline verbatim; the popover stays open on failure.
 */
export function EarningsDateChip(props: Props) {
  const kind = earningsDateChipKind(props.source, props.dateStatus);
  if (!kind) return null;
  const chip = <EarningsDateChipInner {...props} kind={kind} />;
  return props.wrapperClassName ? <span className={props.wrapperClassName}>{chip}</span> : chip;
}

function EarningsDateChipInner({
  symbol,
  eventDate,
  releaseTime,
  kind,
  dateConflictWith,
  onConfirmed,
  popoverAlign = "left",
}: Props & { kind: EarningsDateChipKind }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // A sentence the confirm route wants read even though the date was locked
  // (several hand-entered dates; an old entry kept because a preview was sent).
  const [confirmNotice, setConfirmNotice] = useState<string | null>(null);
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
  // null = not typed in since the last load/save: the input follows the shown time.
  const [rtEdited, setRtEdited] = useState<string | null>(null);
  const [rtSaving, setRtSaving] = useState(false);
  const [rtMsg, setRtMsg] = useState<string | null>(null);
  // The server's question before a Save that would replace a web-verified
  // time (409 would_replace_web_verified), with the time it was asked about.
  const [rtAsk, setRtAsk] = useState<{ value: string; message: string } | null>(null);

  // Viewport-aware popover alignment (QA 2026-08-07): popoverAlign is a
  // static hint from the call site, but the chip's actual position decides
  // whether that edge fits — a conflict chip near the LEFT gutter with
  // popoverAlign="right" pushed the 240px popover to x=-142 on a 390px
  // viewport, leaving the date options unreadable mid-correction. Measure on
  // open and flip the alignment when the requested edge would overflow while
  // the opposite edge fits.
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [alignOverride, setAlignOverride] = useState<"left" | "right" | null>(null);
  // Placement above vs. below the anchor (QA deep-sweep, mobile 390x844):
  // opening below unconditionally ran the popover under the fixed mobile
  // bottom nav, deadening 4/5 nav slots and sitting "Analysis" directly on
  // top of the mutating Save button.
  const [verticalFlip, setVerticalFlip] = useState(false);
  const POPOVER_W = 240; // matches w-60
  const EDGE_PAD = 8;
  useLayoutEffect(() => {
    if (!open) {
      setAlignOverride(null);
      setVerticalFlip(false);
      return;
    }
    const measure = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const vw = window.innerWidth;
      if (
        popoverAlign === "right" &&
        (rect.right - POPOVER_W < EDGE_PAD || vw - rect.right < EDGE_PAD) &&
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

      // Vertical clamp: measure the ACTUAL mobile-nav element rather than a
      // hardcoded height — its rendered height already bakes in the
      // safe-area inset (pb-safe), which varies by device. Falls back to
      // the plain viewport bottom when the nav isn't mounted/visible
      // (desktop, `md:hidden` collapses it to a zero-height rect).
      const navRect = document
        .querySelector('nav[aria-label="Mobile navigation"]')
        ?.getBoundingClientRect();
      const lowerBoundary = navRect && navRect.height > 0 ? navRect.top : window.innerHeight;
      const popRect = popoverRef.current?.getBoundingClientRect();
      if (popRect) {
        const overflowsBelow = popRect.bottom > lowerBoundary - EDGE_PAD;
        const fitsAbove = rect.top - popRect.height - EDGE_PAD >= 0;
        setVerticalFlip(overflowsBelow && fitsAbove);
      } else {
        setVerticalFlip(false);
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

  // Dismissal (QA deep-sweep, sibling finding): previously only re-tapping
  // the chip closed the popover — no Escape, no outside click/tap, and on
  // desktop multiple popovers could stack. `wrapRef` wraps BOTH the anchor
  // button and the popover, so a single containment check ignores clicks on
  // either without double-toggling the anchor's own onClick handler.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      // While the replace question is up, Escape answers IT (the dialog's
      // own cancel), not the popover underneath.
      if (rtAsk) return;
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, rtAsk]);

  const slotParam = releaseTime && releaseTime < "12:00" ? "bmo" : "amc";
  const rtEdit = releaseTimeInputValue(rtEdited, rt, releaseTime);

  async function loadReleaseTime() {
    // Every popover open starts message-clean — otherwise a stale
    // success/error from a prior save lingers beside freshly-fetched data
    // after close → reopen.
    setRtMsg(null);
    setRtAsk(null);
    try {
      const res = await fetch(
        `/api/earnings/release-time?symbol=${encodeURIComponent(symbol)}&slot=${slotParam}`,
      );
      const body = await res.json().catch(() => null);
      if (body?.success) {
        setRt(body.data);
        setRtEdited(null);
      }
    } catch {
      /* popover shows the stored releaseTime fallback */
    }
  }

  async function saveReleaseTime(value: string | null, replaceWebVerified = false) {
    if (rtSaving) return;
    setRtSaving(true);
    setRtMsg(null);
    try {
      const res = await apiFetch("/api/earnings/release-time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          replaceWebVerified
            ? { symbol, releaseTime: value, replaceWebVerified: true }
            : { symbol, releaseTime: value },
        ),
      });
      // A Save over a web-verified time is asked about first: nothing was
      // stored, and the answer re-sends with the acknowledgement.
      if (value !== null && !replaceWebVerified) {
        const ask = releaseTimeAskFirst(res.status, await res.clone().json().catch(() => null));
        if (ask) {
          setRtAsk({ value, message: ask.message });
          return;
        }
      }
      const result = await readMutationResult<{ data?: { updatedEvents?: unknown } }>(res);
      if (!result.ok) {
        setRtMsg(`Nothing was saved. ${result.message}`);
        return;
      }
      const updated = Number(result.data.data?.updatedEvents ?? 0);
      setRtMsg(
        value === null
          ? `Override cleared · ${updated} upcoming event(s) re-resolved`
          : `Saved · ${updated} upcoming event(s) updated`,
      );
      await loadReleaseTime();
      startTransition(() => router.refresh());
    } catch {
      setRtMsg(networkFailureMessage(value === null ? "clear the release time" : "save the release time"));
    } finally {
      setRtSaving(false);
    }
  }

  function confirmReplaceWebVerified() {
    const asked = rtAsk;
    setRtAsk(null);
    if (asked) void saveReleaseTime(asked.value, true);
  }

  function cancelReplaceWebVerified() {
    setRtAsk(null);
    setRtMsg("Nothing was saved. The web-verified time stands.");
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
      const res = await apiFetch("/api/earnings/correct-date", {
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
      // This row may vanish from the shown week after the refresh; the hub's
      // note component (which survives) tells the user where it went.
      window.dispatchEvent(
        new CustomEvent(EARNINGS_DATE_CORRECTED_EVENT, { detail: { date: fixDate } }),
      );
      onConfirmed?.();
      startTransition(() => router.refresh());
    } catch {
      setConfirmError("Fix failed: could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  if (kind !== "conflict") {
    // Same bounds as the conflict popover's custom-date input below (the
    // server refuses a date more than MAX_EARNINGS_DAYS_AHEAD days out).
    const todayIso = todayET();
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
      // No stored status: neutral <Chip>, no lock, no "confirmed".
      hand_entered: {
        label: HAND_ENTERED_LABEL,
        cls: "",
        line: HAND_ENTERED_LINE,
      },
    }[kind];

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
          {kind === "hand_entered" ? (
            <Chip tone="neutral" size="xs">
              {passive.label}
            </Chip>
          ) : (
            passive.label
          )}
        </button>
        {open && (
          // z-[55]: must paint above the fixed chat rail (z-50) — same
          // rail-tie family as the conflict popover below.
          <div
            ref={popoverRef}
            className={`absolute z-[55] ${
              verticalFlip ? "bottom-full mb-1" : "top-full mt-1"
            } w-60 rounded-lg border border-edge bg-panel p-2 shadow-lg text-left ${
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
                min={todayIso}
                max={addDays(todayIso, MAX_EARNINGS_DAYS_AHEAD)}
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
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${CHIP_TONE_TEXT.up} bg-up/15 hover:bg-up/25 disabled:opacity-40 whitespace-nowrap`}
              >
                Fix date
              </button>
            </div>
            <ReleaseTimeEditor
              symbol={symbol}
              rt={rt}
              releaseTime={releaseTime}
              rtEdit={rtEdit}
              onRtEditChange={setRtEdited}
              rtSaving={rtSaving}
              rtMsg={rtMsg}
              onSave={saveReleaseTime}
              settling={rtSaving || pending}
              ask={rtAsk?.message ?? null}
              onAskConfirm={confirmReplaceWebVerified}
              onAskCancel={cancelReplaceWebVerified}
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
  // A stale prior-quarter vendor date is not a live option — offering it lets
  // one tap move an upcoming print into the past (the server refuses too).
  const todayIso = todayET();
  const isPast = (d: string) => d < todayIso;

  async function confirm(date: string, time: "bmo" | "amc") {
    if (submitting) return;
    setSubmitting(true);
    setConfirmError(null);
    setConfirmNotice(null);
    try {
      const res = await apiFetch("/api/earnings/confirm-date", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, confirmedDate: date, confirmedTime: time }),
      });
      const result = await readMutationResult<{ data?: { notice?: unknown } }>(res);
      if (!result.ok) {
        // Keep the popover open — closing on a rejected confirm makes the
        // chip look resolved when the conflict is still live.
        setConfirmError(`Confirm failed: ${result.message}`);
        return;
      }
      const rawNotice = result.data.data?.notice;
      const notice = typeof rawNotice === "string" ? rawNotice.trim() : "";
      onConfirmed?.();
      if (notice) {
        // The refresh below would replace this chip, so a notice keeps the
        // popover open until the user dismisses it.
        setConfirmNotice(notice);
        return;
      }
      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      setConfirmError(networkFailureMessage("confirm the date"));
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
        className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${CHIP_TONE_TEXT.gold} bg-gold/15 hover:bg-gold/25 disabled:opacity-50 cursor-pointer`}
        title="Sources disagree on the date — confirm against IBKR"
      >
        ⚠ confirm
      </button>
      {open && (
        // z-[55]: must paint above the fixed chat rail (z-50) — same
        // rail-tie family as the Analysis drawer fix (trust-strip precedent).
        <div
          ref={popoverRef}
          className={`absolute z-[55] ${
            verticalFlip ? "bottom-full mb-1" : "top-full mt-1"
          } w-60 rounded-lg border border-edge bg-panel p-2 shadow-lg text-left ${
            resolvedAlign === "right" ? "right-0" : "left-0"
          }`}
        >
          <p className="text-[11px] text-ink-dim mb-1.5">
            Sources disagree — pick the IBKR date:
          </p>
          <div className="space-y-1">
            <button
              type="button"
              disabled={submitting || isPast(eventDate)}
              onClick={() => confirm(eventDate, defaultTime)}
              title={isPast(eventDate) ? "Past date — stale prior-quarter entry, not a live option" : undefined}
              className="w-full text-left text-[11px] font-mono px-2 py-1 rounded bg-raised hover:bg-muted disabled:opacity-50"
            >
              Nasdaq · {fmtShort(eventDate)}{isPast(eventDate) ? " (past)" : ""}
            </button>
            {finnDate && (
              <button
                type="button"
                disabled={submitting || isPast(finnDate)}
                onClick={() => confirm(finnDate, defaultTime)}
                title={isPast(finnDate) ? "Past date — stale prior-quarter entry, not a live option" : undefined}
                className="w-full text-left text-[11px] font-mono px-2 py-1 rounded bg-raised hover:bg-muted disabled:opacity-50"
              >
                Finnhub · {fmtShort(finnDate)}{isPast(finnDate) ? " (past)" : ""}
              </button>
            )}
            <div className="flex items-center gap-1 pt-1.5 mt-1 border-t border-edge">
              <input
                type="date"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                className="text-[10px] bg-raised rounded px-1 py-0.5 flex-1 min-w-0 text-ink"
                min={todayIso}
                max={addDays(todayIso, MAX_EARNINGS_DAYS_AHEAD)}
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
                disabled={submitting || !customDate || isPast(customDate)}
                onClick={() => customDate && confirm(customDate, customTime)}
                className={`${TOUCH_EXTENSION} ml-1 text-[10px] font-mono px-1.5 py-0.5 rounded ${CHIP_TONE_TEXT.up} bg-up/15 hover:bg-up/25 disabled:opacity-40`}
              >
                ok
              </button>
            </div>
          </div>
          <ReleaseTimeEditor
            symbol={symbol}
            rt={rt}
            releaseTime={releaseTime}
            rtEdit={rtEdit}
            onRtEditChange={setRtEdited}
            rtSaving={rtSaving}
            rtMsg={rtMsg}
            onSave={saveReleaseTime}
            settling={rtSaving || pending}
            ask={rtAsk?.message ?? null}
            onAskConfirm={confirmReplaceWebVerified}
            onAskCancel={cancelReplaceWebVerified}
          />
          {confirmError && (
            <p className="text-[10px] text-down pt-1">{confirmError}</p>
          )}
          {confirmNotice && (
            <div role="status" className="pt-1 space-y-1">
              <p className="text-[11px] text-ink-dim">{confirmNotice}</p>
              <button
                type="button"
                onClick={() => {
                  setConfirmNotice(null);
                  setOpen(false);
                  startTransition(() => router.refresh());
                }}
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${CHIP_TONE_TEXT.up} bg-up/15 hover:bg-up/25`}
              >
                Got it
              </button>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
