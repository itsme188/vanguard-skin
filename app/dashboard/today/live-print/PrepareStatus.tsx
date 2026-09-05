"use client";

/**
 * The prepare-step line for one armed event (M-F15).
 *
 * The status route returns no prepare state at all — the only route that does
 * is `GET /api/earnings/worksheet?eventIds=…`, which the Hub's controller
 * polls every 60 s. So `steps` is `undefined` until that first response lands,
 * and this component says NOTHING rather than guessing: an empty line is
 * honest, "ready" would not be.
 *
 * The word this line never uses is "stuck". Per the slice-B deferred-minors
 * note in docs/plans/TODO.md, an armed symbol with no stored IR page carries a
 * permanently `pending` `ir_baseline` row — that is the NORMAL resting state,
 * not a stall, and the `IrPageField` right below is the fix. A `pending` step
 * is therefore always "waiting", and when `ir_baseline` is the only one left
 * the line names the fix by name.
 */

import type { PrepareStepWire } from "../hub-live/types";

/** The registered steps (`lib/earnings/prepare-steps/index.ts`) plus
 *  `ir_baseline`, in desk language. An unregistered future step falls back to
 *  its own id rather than disappearing. */
const STEP_LABELS: Record<string, string> = {
  con_id: "contract id",
  consensus_row: "consensus row",
  intel: "intel",
  newsletter_rescan: "newsletter re-scan",
  ir_baseline: "IR baseline",
};

export default function PrepareStatus({ steps }: { steps: PrepareStepWire[] | undefined }) {
  if (!steps) return null; // not fetched yet — say nothing
  if (steps.length === 0) return null;

  const failed = steps.filter((s) => s.status === "failed");
  const waiting = steps.filter((s) => s.status === "pending" || s.status === "claimed");

  if (failed.length === 0 && waiting.length === 0) {
    return <p className="text-[11px] font-mono text-ink-faint">prep · ready</p>;
  }

  const irOnly = waiting.length === 1 && waiting[0].step === "ir_baseline" && failed.length === 0;

  return (
    <p className="text-[11px] font-mono text-ink-faint">
      prep ·{" "}
      {failed
        .map((s) => `${STEP_LABELS[s.step] ?? s.step} failed — ${s.last_error ?? "no reason recorded"}`)
        .join(" · ")}
      {failed.length > 0 && waiting.length > 0 ? " · " : ""}
      {irOnly
        ? "waiting on an IR page"
        : waiting.length > 0
          ? `waiting: ${waiting.map((s) => STEP_LABELS[s.step] ?? s.step).join(", ")}`
          : ""}
    </p>
  );
}
