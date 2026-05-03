"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { EarningsEmailViewer } from "../components/EarningsEmailViewer";

interface EarningsRowChipsProps {
  eventId: number;
  previewSent: boolean;
  recapSent: boolean;
  previewSkipped: boolean;
  recapSkipped: boolean;
}

type Phase = "preview" | "recap";

/**
 * Right-side chip cluster on each EarningsHub row.
 *
 * - Sent → solid green chip, opens the email viewer.
 * - Pending + not skipped → faint chip with hover-revealed × button to skip
 *   (skip POSTs to /api/earnings/skip and the next 15-min sweep excludes it).
 * - Skipped → muted chip showing "skipped" with an undo affordance.
 *
 * Skipping never disables the symbol globally — it's a per-event mark.
 */
export function EarningsRowChips({
  eventId,
  previewSent,
  recapSent,
  previewSkipped,
  recapSkipped,
}: EarningsRowChipsProps) {
  const [openPhase, setOpenPhase] = useState<Phase | null>(null);

  return (
    <span className="flex items-center gap-1 shrink-0">
      <PhaseChip
        eventId={eventId}
        phase="preview"
        sent={previewSent}
        skipped={previewSkipped}
        onView={() => setOpenPhase("preview")}
      />
      <PhaseChip
        eventId={eventId}
        phase="recap"
        sent={recapSent}
        skipped={recapSkipped}
        onView={() => setOpenPhase("recap")}
      />
      {openPhase && (
        <EarningsEmailViewer
          eventId={eventId}
          phase={openPhase}
          open={true}
          onClose={() => setOpenPhase(null)}
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
  const [pending, startTransition] = useTransition();
  const label = phase === "preview" ? "pre" : "rec";

  if (sent) {
    return (
      <button
        type="button"
        onClick={onView}
        className="text-[10px] font-mono px-1.5 py-0.5 rounded text-up bg-up/15 hover:bg-up/25 cursor-pointer"
        title={`View ${phase} email`}
      >
        ✓ {label}
      </button>
    );
  }

  async function toggleSkip() {
    if (pending) return;
    if (skipped) {
      await fetch(`/api/earnings/skip?eventId=${eventId}&phase=${phase}`, {
        method: "DELETE",
      });
    } else {
      await fetch("/api/earnings/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, phase }),
      });
    }
    startTransition(() => router.refresh());
  }

  if (skipped) {
    return (
      <button
        type="button"
        onClick={toggleSkip}
        disabled={pending}
        className="text-[10px] font-mono px-1.5 py-0.5 rounded text-ink-faint bg-raised hover:bg-muted disabled:opacity-50 cursor-pointer line-through"
        title={`${phase} skipped — click to un-skip`}
      >
        {label}
      </button>
    );
  }

  return (
    <span className="group relative inline-flex">
      <span
        className="text-[10px] font-mono px-1.5 py-0.5 rounded text-ink-faint bg-raised group-hover:opacity-30 transition-opacity"
        title={`${phase} pending`}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={toggleSkip}
        disabled={pending}
        className="absolute inset-0 flex items-center justify-center text-[10px] font-mono rounded text-down bg-down/15 hover:bg-down/25 opacity-0 group-hover:opacity-100 disabled:opacity-50 transition-opacity cursor-pointer"
        title={`Skip ${phase} for this event`}
        aria-label={`Skip ${phase} email for this event`}
      >
        skip
      </button>
    </span>
  );
}
