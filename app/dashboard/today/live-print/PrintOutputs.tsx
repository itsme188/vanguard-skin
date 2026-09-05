"use client";

/**
 * The three things a desk does with a finished print: print the sheet, promote
 * the headline pair, send the recap (cross-slice contract §2/§3).
 *
 * Slice E owns `/api/print-watch/print-sheet` and `/api/print-watch/send-recap`
 * AND the `outputs` block on the status payload. Until E merges, that block is
 * simply absent — and the honest render for "the server has not told us what
 * these buttons may do" is NO buttons, no error and no claim, not a row of
 * controls that 404 on click.
 *
 * `Promote` is NOT re-implemented here. It posts the accept route with the
 * promote-headline flag, which is the same call that owns the three 409
 * confirms (pre-print, superseded-promote, superseded-accept) — so
 * `LivePrintRow` keeps that handler and hands this row the finished control
 * (F-S8). Two copies of a confirm are two copies that can disagree.
 */

import { useState } from "react";
import apiFetch from "@/lib/http/apiFetch";
import type { PrintOutputsWire } from "../hub-live/types";

/** The promote control's finished shape — built by `LivePrintRow`, which owns
 *  the accept route and its three 409 confirms (F-S8). */
export interface PromoteControl {
  label: string;
  disabled: boolean;
  title: string;
  busy: boolean;
  onClick: () => void;
}

/**
 * The promote button's ONE piece of markup. It is rendered from inside the
 * outputs row when slice E is on the payload, and directly by `LivePrintRow`
 * when it is not — a print must never be un-promotable just because the
 * outputs block has not shipped yet. Exported (rather than nested) so both
 * call sites render the identical control.
 */
export function PromoteButton({ promote }: { promote: PromoteControl }) {
  return (
    <button
      type="button"
      onClick={promote.onClick}
      disabled={promote.disabled || promote.busy}
      title={promote.title}
      className="relative text-[13px] font-semibold bg-up/15 text-up border border-up/40 hover:bg-up/25 disabled:opacity-50 rounded px-2.5 py-1 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
    >
      {promote.busy ? "Promoting…" : promote.label}
    </button>
  );
}

export default function PrintOutputs({
  printId,
  outputs,
  onChanged,
  promote,
}: {
  printId: number;
  outputs: PrintOutputsWire | undefined;
  onChanged: () => Promise<void>;
  /** The promote control, owned by LivePrintRow so the three 409 confirms stay
   *  in ONE place (F-S8). */
  promote: PromoteControl;
}) {
  const [busy, setBusy] = useState<"sheet" | "recap" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Slice E owns these routes. Until it merges, the status payload has no
  // `outputs` and this whole row is absent — no buttons, no error, no claim.
  if (!outputs) return null;

  async function printSheet() {
    setBusy("sheet");
    setNote(null);
    try {
      const res = await apiFetch("/api/print-watch/print-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printId }),
      });
      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; data?: { road?: string; pages?: number | null; symbol?: string } }
        | null;
      if (!res.ok || !data?.success) {
        // A 409 here is the gate refusing in its own words (a sheet with no
        // reported value on any line). Rendering it verbatim is the whole
        // point — a generic "failed" would send the desk hunting.
        setNote(data?.error ?? `Print sheet failed (HTTP ${res.status}).`);
        return;
      }
      const pages = data.data?.pages;
      setNote(
        `Sent to the printer — ${data.data?.road ?? "unknown road"}, ${
          typeof pages === "number" ? `${pages} page(s)` : "page count unknown"
        }`,
      );
      await onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function sendRecap() {
    setBusy("recap");
    setNote(null);
    try {
      const res = await apiFetch("/api/print-watch/send-recap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printId }),
      });
      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; data?: Record<string, unknown> }
        | null;
      if (!res.ok || !data?.success) {
        setNote(data?.error ?? `Recap failed (HTTP ${res.status}).`);
        return;
      }
      // Every coordination outcome is a 200 (contract §3), so the outcome word
      // IS the answer. `reason` carries a refusal or a failure; `note` carries
      // why a delivery_unknown is unknown. Both are the server's own words and
      // are rendered verbatim — never re-phrased, never swallowed.
      const outcome = String(data.data?.outcome ?? "");
      const detail = data.data?.reason ?? data.data?.note;
      setNote(detail === undefined ? outcome : `${outcome} — ${String(detail)}`);
      await onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  const sheetReason = outputs.printSheet.reason;
  const recapReason = outputs.sendRecap.reason;
  const recap = outputs.sendRecap;

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => void printSheet()}
          disabled={!outputs.printSheet.enabled || busy !== null}
          title={sheetReason ?? "Print the verified sheet on the desk printer"}
          className="relative text-[13px] font-mono text-ink-dim hover:text-ink border border-edge rounded px-2.5 py-1 disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
        >
          {busy === "sheet" ? "Printing…" : "Print sheet"}
        </button>

        <PromoteButton promote={promote} />

        <button
          type="button"
          onClick={() => void sendRecap()}
          disabled={!recap.enabled || busy !== null}
          title={recapReason ?? "Send the recap email for this print now"}
          className="relative text-[13px] font-mono text-ink-dim hover:text-ink border border-edge rounded px-2.5 py-1 disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
        >
          {busy === "recap" ? "Sending…" : "Send recap now"}
        </button>
      </div>

      {/* A disabled control has to SAY why, in words — colour and a tooltip are
          not readable on a phone and are not readable at all to a screen
          reader that never hovers. */}
      {sheetReason && <p className="text-[11px] text-ink-faint mt-1">Print sheet: {sheetReason}</p>}
      {recapReason && <p className="text-[11px] text-ink-faint mt-1">Send recap: {recapReason}</p>}
      <p className="text-[11px] text-ink-faint mt-1">
        recap · {recap.state}
        {recap.providerMessageId ? ` · message ${recap.providerMessageId}` : ""}
      </p>
      {note && <p className="text-[12px] text-ink-dim mt-1">{note}</p>}
    </div>
  );
}
