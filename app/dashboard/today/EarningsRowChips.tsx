"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "../components/Toast";
import {
  EarningsEmailViewer,
  type InlineEmailData,
} from "../components/EarningsEmailViewer";

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
  const [inlineData, setInlineData] = useState<InlineEmailData | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Show "Generate" only when the recap hasn't fired and isn't skipped —
  // otherwise the user already has a path to view it (the sent ✓-chip)
  // or has explicitly muted it.
  const showGenerate = !recapSent && !recapSkipped;

  async function generateRecap() {
    if (generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await fetch("/api/earnings/recap-modal", {
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
        setGenerateError(json.error ?? "Not reported yet.");
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
    } catch (err) {
      setGenerateError(
        err instanceof Error ? err.message : "Generate failed",
      );
    } finally {
      setGenerating(false);
    }
  }

  return (
    <span className="flex items-center gap-1 shrink-0">
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
      {showGenerate && (
        <button
          type="button"
          onClick={generateRecap}
          disabled={generating}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded text-gold bg-gold/15 hover:bg-gold/25 disabled:opacity-50 cursor-pointer"
          title="Compose a fresh recap now (runs enrichment + AI; ~30-60s)"
        >
          {generating ? "…" : "gen"}
        </button>
      )}
      {generateError && (
        <span
          className="text-[10px] font-mono text-down truncate max-w-[12ch]"
          title={generateError}
        >
          ✗ {generateError}
        </span>
      )}
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
    try {
      const res = skipped
        ? await fetch(`/api/earnings/skip?eventId=${eventId}&phase=${phase}`, {
            method: "DELETE",
          })
        : await fetch("/api/earnings/skip", {
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
