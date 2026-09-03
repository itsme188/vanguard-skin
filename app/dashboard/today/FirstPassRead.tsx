"use client";

// The first-pass read block under the print-watch sheet (spec §4.4; §2 "The
// first output is the on-screen first-pass read"). Privacy (controller ruling
// on Codex #20): model prose, model-derived labels and vs_bogey_text render
// inside <PrivateText> — one span per line, inside the block element; facts,
// bogeys and deltas are public market data and render like the sheet's own
// actuals. Slice F re-lays the panel; this block is self-contained.
import { useState } from "react";
import apiFetch from "@/lib/http/apiFetch";
import { PrivateText } from "@/lib/privacy/components";
import { formatValue } from "@/lib/print-watch/callouts";
import { sanitizeProseLines } from "@/lib/print-watch/first-pass-prompt";
import type { CalloutView, ReadErrorCode, ReadFact, ReadProse, ReadVerdict } from "@/lib/print-watch/first-pass-types";

export interface FirstPassReadDto { id: number; status: "done"; nonce: number; model_id: string | null; generated_at: string | null; facts: ReadFact[]; prose: ReadProse }
export interface ActiveReadDto { id: number; status: "generating" | "failed"; nonce: number; attempts: number; error_code: ReadErrorCode | null; error: string | null; next_retry_at: string | null; claimed_at: string | null }

function etClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function readStatusLabel(read: FirstPassReadDto | null, active: ActiveReadDto | null): string {
  const tail = !active ? "" : active.status === "generating" ? "updating…" : `update failed — ${active.error_code ?? "unknown"}`;
  if (!read) {
    if (!active) return "no read yet — generates after the first parse";
    return active.status === "generating" ? "reading…" : `read failed — ${active.error_code ?? "unknown"}`;
  }
  const base = `read · ${read.generated_at ? etClock(read.generated_at) : "?"} ET`;
  return tail ? `${base} · ${tail}` : base;
}

export function verdictGlyph(v: ReadVerdict): string {
  return v === "beat" ? "▲" : v === "miss" ? "▼" : v === "inline" ? "▬" : v === "range" ? "↔" : "·";
}

export function calloutStateLabel(c: CalloutView): string {
  if (c.effective_state === "revoked") return "revoked — document withdrawn";
  if (c.effective_state === "superseded") return "superseded by a newer read";
  if (c.effective_state === "accepted") return "accepted";
  return "proposed · single source — verify";
}

function fmtRange(low: number, high: number | null, unit: ReadFact["unit"] | CalloutView["unit"]): string {
  return high !== null ? `${formatValue(low, unit)}–${formatValue(high, unit)}` : formatValue(low, unit);
}

export function factRow(f: ReadFact): { label: string; actual: string; bogey: string; delta: string; verdict: ReadVerdict } {
  const actual = fmtRange(f.actual, f.actual_high, f.unit);
  const bogeyNum = f.expected_consensus !== null ? formatValue(f.expected_consensus, f.unit) : f.expected_consensus_vendor !== null ? formatValue(f.expected_consensus_vendor, f.unit) : "—";
  const bogey = f.expected_source ? `${bogeyNum} (${f.expected_source})` : bogeyNum;
  const delta = f.verdict === "range" ? "range" : f.delta_pct === null ? "—" : Math.abs(f.delta_pct) <= 0.5 ? "in-line" : `${f.delta_pct > 0 ? "+" : ""}${f.delta_pct.toFixed(1)}%`;
  return { label: f.label, actual, bogey, delta, verdict: f.verdict };
}

export default function FirstPassRead({ eventId, read, activeRead, callouts, onChanged }: { eventId?: number; read: FirstPassReadDto | null; activeRead: ActiveReadDto | null; callouts: CalloutView[]; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function regenerate() {
    if (!eventId) { setNote("No event id on this print — cannot regenerate"); return; }
    setBusy("read"); setNote(null);
    try {
      const res = await apiFetch("/api/print-watch/read", { method: "POST", body: JSON.stringify({ eventId }) });
      const data = await res.json();
      if (!res.ok || !data.success) { setNote(data.error ?? `regenerate failed (${res.status})`); return; }
      setNote(data.data.status === "no_facts" ? "Nothing to read yet — the sheet has no accepted values" : "Regenerating…");
      await onChanged();
    } catch (e) { setNote(e instanceof Error ? e.message : "regenerate failed"); }
    finally { setBusy(null); }
  }

  async function setAccept(c: CalloutView, accept: boolean) {
    setBusy(`callout-${c.id}`); setNote(null);
    try {
      const res = await apiFetch("/api/print-watch/callouts/accept", { method: "POST", body: JSON.stringify({ calloutId: c.id, accept }) });
      const data = await res.json();
      if (!res.ok || !data.success) { setNote(data.error ?? `accept failed (${res.status})`); return; }
      await onChanged();
    } catch (e) { setNote(e instanceof Error ? e.message : "accept failed"); }
    finally { setBusy(null); }
  }

  const prose = read ? { read: sanitizeProseLines(read.prose.read, 10), call_watch: sanitizeProseLines(read.prose.call_watch, 3), caveats: sanitizeProseLines(read.prose.caveats, 6) } : null;
  const facts = read && Array.isArray(read.facts) ? read.facts : [];

  return (
    <section className="mt-4 border-t border-edge pt-3" aria-label="First-pass read">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-mono uppercase text-ink-faint whitespace-nowrap!" style={{ letterSpacing: "0.14em" }}>First-pass read</h3>
        <span className="text-[11px] font-mono text-ink-faint">{readStatusLabel(read, activeRead)}</span>
        <button type="button" className="text-[11px] font-mono underline text-ink-dim disabled:opacity-50" disabled={busy !== null || activeRead?.status === "generating"} onClick={regenerate}>
          {busy === "read" ? "requesting…" : "regenerate"}
        </button>
      </div>
      {note && <p className="text-[12px] text-ink-dim mt-1">{note}</p>}
      {facts.length > 0 && (
        <table className="w-full text-[12px] mt-2" style={{ borderCollapse: "collapse" }}>
          <tbody>
            {facts.map((f) => { const r = factRow(f); return (
              <tr key={f.metric_id}>
                <td className="py-0.5 pr-3">{r.label}</td>
                <td className="py-0.5 pr-3 font-mono">{r.actual}</td>
                <td className="py-0.5 pr-3 font-mono text-ink-dim">{r.bogey}</td>
                <td className="py-0.5 pr-3 font-mono text-right">{r.delta}</td>
                <td className="py-0.5 font-mono" aria-label={r.verdict}>{verdictGlyph(r.verdict)} {r.verdict}</td>
              </tr>
            ); })}
          </tbody>
        </table>
      )}
      {prose && (
        <div className="mt-2 text-[13px] leading-snug">
          <ul className="list-disc pl-4">{prose.read.map((l, i) => <li key={i}><PrivateText>{l}</PrivateText></li>)}</ul>
          <p className="mt-2 text-[11px] font-mono uppercase text-ink-faint">Call watch</p>
          <ol className="list-decimal pl-4">{prose.call_watch.map((l, i) => <li key={i}><PrivateText>{l}</PrivateText></li>)}</ol>
          {prose.caveats.length > 0 && <p className="mt-1 text-[12px] text-ink-dim"><PrivateText>{prose.caveats.join(" · ")}</PrivateText></p>}
        </div>
      )}
      {callouts.length > 0 && (
        <ul className="mt-2 text-[12px]">
          {callouts.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 py-0.5">
              <PrivateText>{c.label}</PrivateText>
              <span className="font-mono">{fmtRange(c.value, c.value_high, c.unit)}</span>
              <span className="text-ink-dim"><PrivateText>{c.vs_bogey_text ?? ""}</PrivateText></span>
              <span className="text-[11px] font-mono text-ink-faint">{calloutStateLabel(c)}{c.doc_kind ? ` · ${c.doc_kind}` : ""}</span>
              {(c.effective_state === "proposed" || c.effective_state === "accepted") && (
                <button type="button" className="text-[11px] font-mono underline text-ink-dim disabled:opacity-50" disabled={busy !== null} onClick={() => setAccept(c, c.effective_state !== "accepted")}>
                  {busy === `callout-${c.id}` ? "…" : c.effective_state === "accepted" ? "un-accept" : "accept"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
