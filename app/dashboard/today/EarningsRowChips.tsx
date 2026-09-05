"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "../components/Toast";
import {
  EarningsEmailViewer,
  type InlineEmailData,
} from "../components/EarningsEmailViewer";
import { BogeysEditModal } from "./BogeysEditModal";
import { StageChipStrip, RowIntelLine, fmtCountdown } from "./hub-live/send-state-chips";
import { useHubLive } from "./EarningsHubLive";
import apiFetch from "@/lib/http/apiFetch";

interface EarningsRowChipsProps {
  eventId: number;
  previewSent: boolean;
  recapSent: boolean;
  previewSkipped: boolean;
  recapSkipped: boolean;
  worksheetArmed: boolean;
  worksheetPrinted: boolean;
}

type Phase = "preview" | "recap";

/**
 * Right-side chip cluster on each EarningsHub row.
 *
 * Two wrap groups (2026-08-04 legibility pass — labels are full words and
 * the worksheet chip SAYS its state instead of only tinting the glyph):
 * emails ("preview" / "recap") and actions ("⎙ arm|armed|printed",
 * "gen recap"). The root flex-wraps between groups only (each group is
 * shrink-0), so in the 160px Email grid column the cluster breaks into two
 * neat lines instead of mashing; in the roomier mobile card it stays inline.
 *
 * - Sent → solid green chip, opens the email viewer.
 * - Pending + not skipped → faint chip with hover-revealed skip button
 *   (skip POSTs to /api/earnings/skip and the next 15-min sweep excludes it).
 *   On coarse pointers the overlay is removed entirely and an always-visible
 *   ✕ renders beside the chip instead (hover doesn't exist on touch, and an
 *   invisible opacity-0 overlay would eat stray taps).
 * - Skipped → muted strikethrough chip with an undo affordance.
 *
 * Skipping never disables the symbol globally — it's a per-event mark.
 */
export function EarningsRowChips({
  eventId,
  previewSent,
  recapSent,
  previewSkipped,
  recapSkipped,
  worksheetArmed,
  worksheetPrinted,
}: EarningsRowChipsProps) {
  // Task 9: the live cockpit row comes from the Hub's ONE controller through
  // context, not as a prop the server-rendered row would have to thread down.
  // `useHubLive()` returns null outside the provider (and on the very first
  // paint before hydration), so every control below renders from its server
  // props exactly as it did before the cockpit chips existed.
  const live = useHubLive();
  const cockpitRow = live?.cockpitByEvent[eventId] ?? null;
  const { toast } = useToast();
  const router = useRouter();
  const [openPhase, setOpenPhase] = useState<Phase | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [actualsOpen, setActualsOpen] = useState(false);

  // Worksheet chip (feedback #6): tap toggles the auto-print arm; the armed
  // state prints once at the preview tick (printed → ✓ styling). Honest
  // feedback per convention — every outcome reaches a toast.
  async function toggleWorksheet() {
    if (sheetBusy) return;
    setSheetBusy(true);
    try {
      const res = await apiFetch("/api/earnings/worksheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, action: worksheetArmed ? "disarm" : "arm" }),
      });
      const data = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !data?.success) {
        toast(
          `Couldn't ${worksheetArmed ? "disarm" : "arm"} the worksheet (${data?.error ?? `server returned ${res.status}`}).`,
          "error",
        );
        return;
      }
      toast(
        worksheetArmed
          ? "Worksheet disarmed."
          : "Worksheet armed — prints automatically at the preview tick.",
        "success",
      );
      router.refresh();
    } catch {
      toast("Couldn't reach the server to toggle the worksheet.", "error");
    } finally {
      setSheetBusy(false);
    }
  }
  const [inlineData, setInlineData] = useState<InlineEmailData | null>(null);
  const [generating, setGenerating] = useState(false);

  // Cockpit chips (StageChipStrip) reuse this component's existing view/modal
  // machinery: preview/recap open the same email viewer as the ✓-chips below,
  // actuals opens the same BogeysEditModal wired the way EarningsCockpit.tsx
  // wires it today.
  function handleCockpitOpen(what: "preview" | "recap" | "actuals") {
    if (what === "actuals") {
      setActualsOpen(true);
      return;
    }
    setInlineData(null);
    setOpenPhase(what);
  }

  // Show "Generate" only when the recap hasn't fired and isn't skipped —
  // otherwise the user already has a path to view it (the sent ✓-chip)
  // or has explicitly muted it.
  const showGenerate = !recapSent && !recapSkipped;

  // R9: the row's headline figures (RecapFigureButton cells) open the same
  // viewer this component owns — they dispatch a scoped custom event rather
  // than mounting a viewer of their own.
  //
  // INVARIANT (4th recurrence fix, 2026-08-21): EarningsHub renders a
  // desktop grid row (`hidden md:block`) and a mobile card row
  // (`block md:hidden`) for every event — both are mounted in the DOM at
  // once, CSS just hides one via the responsive breakpoint. That means BOTH
  // EarningsRowChips instances for a given eventId receive this window
  // event and both match on eventId. Only the instance whose ancestor
  // chain is actually visible (not `display:none`) may open the viewer,
  // or two identical modals stack and each fires its own email fetch.
  // `offsetParent` is null whenever any ancestor is `display:none`
  // (that's the CSS-hidden responsive twin), so it's a direct, structural
  // visibility check — no viewport-width heuristics to keep in sync with
  // the Tailwind breakpoint.
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { eventId?: number; phase?: Phase }
        | undefined;
      if (detail?.eventId !== eventId) return;
      if (rootRef.current === null || rootRef.current.offsetParent === null) return;
      setInlineData(null);
      setOpenPhase(detail.phase === "preview" ? "preview" : "recap");
    };
    window.addEventListener("open-earnings-email", onOpen);
    return () => window.removeEventListener("open-earnings-email", onOpen);
  }, [eventId]);

  async function generateRecap() {
    if (generating) return;
    setGenerating(true);
    try {
      const res = await apiFetch("/api/earnings/recap-modal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, runEnrichmentFirst: true }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        notReady?: boolean;
        html?: string;
        title?: string;
        symbol?: string;
        eventDate?: string | null;
        error?: string;
      };
      if (json.notReady) {
        // Expected pre-report state — friendly copy, no thrown error.
        toast(json.error ?? "Not reported yet.", "info");
        return;
      }
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setInlineData({
        title: json.title!,
        fullHtml: json.html!,
        symbol: json.symbol!,
        eventDate: json.eventDate ?? null,
        phase: "recap",
      });
      setOpenPhase("recap");
      // runEnrichmentFirst may have just captured consensus/actuals/reaction —
      // re-render the server-side hub row so it agrees with the modal instead
      // of showing "no actuals" until a manual reload.
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Generate failed", "error");
    } finally {
      setGenerating(false);
    }
  }

  return (
    /* min-w-0 + NO shrink-0 on the root: the root must be allowed to shrink
       to its grid cell so flex-wrap actually engages. A shrink-0 root sizes
       to max-content (~236px), never wraps, and spills leftward over the
       Bogeys button — an invisible click-stealer on pending rows (the exact
       2026-07-27 "+ BOG silently skipped the recap" bug, re-caught by
       elementFromPoint verification 2026-08-04). */
    <span ref={rootRef} className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1 min-w-0">
      {/* Cockpit chips (M-F4): the stage-chip strip, its release countdown and
          the intel/exposure line, ahead of the row's own controls. Additive —
          absent whenever the caller has no live cockpit row for this event
          (outside the cockpit's coverage set), so every existing action below
          renders exactly as it did before this prop existed. */}
      {cockpitRow && (
        /* min-w-0 + max-w-full and NO shrink-0, for exactly the reason the
           root above carries them. A shrink-0 lane sizes to max-content
           (~267px of chips); inside a 160px Email grid cell a `justify-end`
           flex line lays that out from the RIGHT edge leftwards, so the strip
           escaped its own cell and painted over the Δ and Bogeys columns
           (sandbox E2E 2026-09-04: 4 of the 5 rows carrying a Δ were
           overprinted at BOTH 1440 and 1920 — a grid defect, not a
           narrow-viewport artifact). Letting the lane shrink to its cell is
           what makes its own flex-wrap engage, so the chips stack onto a
           second line INSIDE the cell instead of spilling out of it. Nothing
           is hidden: `Chip` carries no whitespace-nowrap, so even the longest
           chip text ("rec ? delivery unknown") has a small min-content and
           wraps rather than forcing the lane wide again. */
        <span className="flex flex-col items-end gap-0.5 min-w-0 max-w-full">
          <span className="flex flex-wrap items-center justify-end gap-1.5 min-w-0 max-w-full">
            <StageChipStrip row={cockpitRow} onOpen={handleCockpitOpen} />
            {/* The chips paint on the SERVER (EarningsHub seeds the provider
                with a server-built cockpit payload), but a second-granular
                countdown cannot: the server's clock would go into the HTML and
                the browser's into hydration, and every row inside an hour of
                its release would hydrate with a text mismatch. `nowMs` is 0
                until the client clock starts, so this renders from the first
                client tick onwards — milliseconds after paint. */}
            {cockpitRow.stages.released.state === "upcoming" &&
              cockpitRow.stages.released.releaseInstant &&
              !!live?.nowMs && (
                <span className="text-[10px] font-mono text-ink-faint whitespace-nowrap">
                  {fmtCountdown(
                    new Date(cockpitRow.stages.released.releaseInstant).getTime() - live.nowMs,
                  )}
                </span>
              )}
          </span>
          <RowIntelLine row={cockpitRow} />
        </span>
      )}
      {/* Group 1 — email lifecycle chips. shrink-0 so wrapping only ever
          happens BETWEEN groups, never mid-group. */}
      <span className="inline-flex items-center gap-1.5 shrink-0">
        <PhaseChip
          eventId={eventId}
          phase="preview"
          sent={previewSent}
          skipped={previewSkipped}
          onView={() => {
            setInlineData(null);
            setOpenPhase("preview");
          }}
        />
        <PhaseChip
          eventId={eventId}
          phase="recap"
          sent={recapSent}
          skipped={recapSkipped}
          onView={() => {
            setInlineData(null);
            setOpenPhase("recap");
          }}
        />
      </span>
      {/* Group 2 — actions: worksheet arm toggle + on-demand recap compose. */}
      <span className="inline-flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={toggleWorksheet}
          disabled={sheetBusy}
          className={`relative text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap disabled:opacity-50 cursor-pointer active:scale-[0.96] transition-transform pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 ${
            worksheetPrinted
              ? "text-up bg-up/15 hover:bg-up/25"
              : worksheetArmed
                ? "text-gold-ink bg-gold/20 hover:bg-gold/30"
                : "text-ink-faint bg-raised hover:bg-muted"
          }`}
          title={
            worksheetPrinted
              ? "Worksheet printed — tap to disarm/reset"
              : worksheetArmed
                ? "Worksheet armed — auto-prints ~30 min before the release. Tap to disarm."
                : "Not armed. Tap to arm the printable one-page worksheet for this print."
          }
          aria-label="Toggle printable earnings worksheet"
        >
          {worksheetPrinted ? "⎙ printed" : worksheetArmed ? "⎙ armed" : "⎙ arm"}
        </button>
        {showGenerate && (
          <button
            type="button"
            onClick={generateRecap}
            disabled={generating}
            className="relative text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap text-gold-ink bg-gold/15 hover:bg-gold/25 disabled:opacity-50 cursor-pointer active:scale-[0.96] transition-transform pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
            title="Compose a fresh recap email right now (runs enrichment + AI, ~30–60s) instead of waiting for the next sweep"
          >
            {generating ? "…" : "gen recap"}
          </button>
        )}
      </span>
      {/* Generate outcomes surface as toasts, never as an inline span: the
          message used to render INSIDE this fixed-width right-aligned cell,
          which slid the pre/rec chip group left over the neighboring + BOG
          button — whose taps then landed on the chips' invisible skip
          overlays (2026-07-27 sweep: aiming at + BOG silently skipped the
          recap email). A toast also shows the full sentence, which the old
          span clipped to 12ch with a hover-only title. */}
      {openPhase && (
        <EarningsEmailViewer
          eventId={eventId}
          phase={openPhase}
          open={true}
          onClose={() => {
            setOpenPhase(null);
            setInlineData(null);
          }}
          inlineData={
            openPhase === "recap" && inlineData ? inlineData : null
          }
        />
      )}
      {cockpitRow && (
        <BogeysEditModal
          eventId={cockpitRow.eventId}
          symbol={cockpitRow.symbol}
          open={actualsOpen}
          onClose={() => {
            setActualsOpen(false);
            router.refresh();
          }}
        />
      )}
    </span>
  );
}

interface PhaseChipProps {
  eventId: number;
  phase: Phase;
  sent: boolean;
  skipped: boolean;
  onView: () => void;
}

function PhaseChip({ eventId, phase, sent, skipped, onView }: PhaseChipProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  // Full-word labels (2026-08-04): "pre"/"rec" read as noise in a four-chip
  // cluster — the label IS the affordance in a 10px chip, so spell it out.
  const label = phase;

  if (sent) {
    return (
      <button
        type="button"
        onClick={onView}
        className="relative text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap text-up bg-up/15 hover:bg-up/25 cursor-pointer active:scale-[0.96] transition-transform pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
        title={`${phase} email sent — click to read it`}
      >
        ✓ {label}
      </button>
    );
  }

  async function toggleSkip() {
    if (pending) return;
    try {
      const res = skipped
        ? await apiFetch(`/api/earnings/skip?eventId=${eventId}&phase=${phase}`, {
            method: "DELETE",
          })
        : await apiFetch("/api/earnings/skip", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ eventId, phase }),
          });
      if (!res.ok) {
        toast(
          `Couldn't ${skipped ? "un-skip" : "skip"} the ${phase} email (server returned ${res.status}) — the chip state is unchanged.`,
          "error"
        );
        return;
      }
      // Cockpit is a client poller — signal it alongside the server refresh.
      window.dispatchEvent(new Event("earnings-data-changed"));
      startTransition(() => router.refresh());
    } catch {
      toast(`Couldn't ${skipped ? "un-skip" : "skip"} the ${phase} email: could not reach the server.`, "error");
    }
  }

  if (skipped) {
    return (
      <button
        type="button"
        onClick={toggleSkip}
        disabled={pending}
        className="relative text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap text-ink-faint bg-raised hover:bg-muted disabled:opacity-50 cursor-pointer line-through active:scale-[0.96] transition-transform pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
        title={`${phase} email skipped for this event — click to un-skip`}
      >
        {label}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="group relative inline-flex">
        <span
          className="text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap text-ink-faint bg-raised group-hover:opacity-30 transition-opacity"
          title={`${phase} email pending — sends automatically; hover to skip`}
        >
          {label}
        </span>
        {/* Hover-reveal overlay is a fine-pointer affordance only. On touch
            it must be REMOVED, not just unstyled — an opacity-0 button still
            receives taps, so a coarse-pointer tap on the "pending" chip would
            invisibly skip the email. */}
        <button
          type="button"
          onClick={toggleSkip}
          disabled={pending}
          className="pointer-coarse:hidden absolute inset-0 flex items-center justify-center text-[10px] font-mono rounded text-down bg-down/15 hover:bg-down/25 opacity-0 group-hover:opacity-100 disabled:opacity-50 transition-opacity cursor-pointer"
          title={`Skip ${phase} for this event`}
          aria-label={`Skip ${phase} email for this event`}
        >
          skip
        </button>
      </span>
      {/* Touch replacement: always-visible ✕ beside the chip. The after:
          pseudo-element extends the tap target beyond the tiny glyph without
          disturbing the dense row layout (±2px x, ±8px y stays clear of the
          adjacent chips' hit areas at gap-1). */}
      <button
        type="button"
        onClick={toggleSkip}
        disabled={pending}
        className="relative hidden pointer-coarse:inline-flex items-center justify-center text-[10px] font-mono px-1 py-0.5 rounded text-down bg-down/20 disabled:opacity-50 active:scale-[0.96] transition-transform after:absolute after:content-[''] after:-inset-y-2 after:-inset-x-0.5"
        title={`Skip ${phase} for this event`}
        aria-label={`Skip ${phase} email for this event`}
      >
        ✕
      </button>
    </span>
  );
}
