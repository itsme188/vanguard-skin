"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { coercePercent, formatLargeUSD, parseLargeUSD } from "@/lib/format";
import type { EarningsBogey } from "@/lib/queries/earnings-bogeys";

interface Props {
  eventId: number;
  symbol: string;
  open: boolean;
  onClose: () => void;
}

interface FormState {
  source_label: string;
  eps_consensus: string;
  eps_whisper: string;
  revenue_consensus: string;
  revenue_whisper: string;
  expected_move: string;
  guidance_notes: string;
  notes: string;
}

interface ActualsState {
  eps_actual: string;
  revenue_actual: string;
}

const EMPTY: FormState = {
  source_label: "",
  eps_consensus: "",
  eps_whisper: "",
  revenue_consensus: "",
  revenue_whisper: "",
  expected_move: "",
  guidance_notes: "",
  notes: "",
};

const EMPTY_ACTUALS: ActualsState = {
  eps_actual: "",
  revenue_actual: "",
};

/**
 * Per-event bogeys editor. Lists existing bogey rows from any source
 * (PDF / manual / newsletter) and lets the user add or update a manual
 * entry. Revenue inputs accept "$4.34B" / "4340M" / "4,340,000,000" via
 * parseLargeUSD — same syntax accepted on the email composer side.
 */
export function BogeysEditModal({ eventId, symbol, open, onClose }: Props) {
  const router = useRouter();
  const [existing, setExisting] = useState<EarningsBogey[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [actuals, setActuals] = useState<ActualsState>(EMPTY_ACTUALS);
  const [actualsEnrichedAt, setActualsEnrichedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingActuals, setSavingActuals] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setForm(EMPTY);
    setActuals(EMPTY_ACTUALS);
    setActualsEnrichedAt(null);
    Promise.all([
      fetch(`/api/earnings/bogeys?eventId=${eventId}`).then(
        (res) => res.json() as Promise<{ bogeys?: EarningsBogey[]; error?: string }>,
      ),
      fetch(`/api/earnings/actuals?eventId=${eventId}`).then(
        (res) =>
          res.json() as Promise<{
            eps_actual?: number | null;
            revenue_actual_usd?: number | null;
            enriched_at?: string | null;
            error?: string;
          }>,
      ),
    ])
      .then(([bogeysData, actualsData]) => {
        if (cancelled) return;
        if (bogeysData.error) setError(bogeysData.error);
        setExisting(bogeysData.bogeys ?? []);
        if (!actualsData.error) {
          setActuals({
            eps_actual: actualsData.eps_actual != null ? actualsData.eps_actual.toFixed(2) : "",
            revenue_actual:
              actualsData.revenue_actual_usd != null
                ? formatLargeUSD(actualsData.revenue_actual_usd)
                : "",
          });
          setActualsEnrichedAt(actualsData.enriched_at ?? null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Network error");
      });
    return () => {
      cancelled = true;
    };
  }, [open, eventId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const eps_consensus = form.eps_consensus.trim() ? parseLargeUSD(form.eps_consensus) : null;
      const eps_whisper = form.eps_whisper.trim() ? parseLargeUSD(form.eps_whisper) : null;
      const revenue_consensus_usd = form.revenue_consensus.trim()
        ? parseLargeUSD(form.revenue_consensus)
        : null;
      const revenue_whisper_usd = form.revenue_whisper.trim()
        ? parseLargeUSD(form.revenue_whisper)
        : null;
      const expected_move_pct = form.expected_move.trim()
        ? coercePercent(form.expected_move)
        : null;

      const res = await fetch("/api/earnings/bogeys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: eventId,
          source_label: form.source_label.trim() || null,
          eps_consensus,
          eps_whisper,
          revenue_consensus_usd,
          revenue_whisper_usd,
          expected_move_pct,
          guidance_notes: form.guidance_notes.trim() || null,
          notes: form.notes.trim() || null,
        }),
      });
      const data = (await res.json()) as { error?: string; id?: number };
      if (!res.ok || data.error) {
        setError(data.error ?? `Server returned ${res.status}`);
        return;
      }
      router.refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  async function saveActuals(e: React.FormEvent) {
    e.preventDefault();
    setSavingActuals(true);
    setError(null);
    try {
      const eps_actual = actuals.eps_actual.trim() ? parseLargeUSD(actuals.eps_actual) : null;
      const revenue_actual_usd = actuals.revenue_actual.trim()
        ? parseLargeUSD(actuals.revenue_actual)
        : null;
      if (eps_actual == null && revenue_actual_usd == null) {
        setError("Provide at least one actual value (EPS or revenue).");
        return;
      }
      const res = await fetch("/api/earnings/actuals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: eventId,
          eps_actual,
          revenue_actual_usd,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? `Server returned ${res.status}`);
        return;
      }
      router.refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSavingActuals(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this bogey?")) return;
    const res = await fetch(`/api/earnings/bogeys?id=${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? `Server returned ${res.status}`);
      return;
    }
    setExisting((prev) => prev.filter((b) => b.id !== id));
    router.refresh();
  }

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-xl mx-auto my-8 electron:mt-12 max-h-[85dvh] overflow-y-auto rounded-xl border border-edge bg-panel shadow-2xl">
        <div className="sticky top-0 z-10 flex items-baseline justify-between px-5 py-3.5 border-b border-edge bg-panel/95 backdrop-blur-sm rounded-t-xl">
          <h2 className="text-sm font-medium text-ink">
            Bogeys for <span className="font-mono text-gold-ink">{symbol}</span>
          </h2>
          <button
            onClick={onClose}
            className="relative text-ink-faint hover:text-ink text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-raised pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* Existing bogeys — render an explicit empty state so users
              don't mistake the modal for partially loaded. */}
          {existing.length === 0 ? (
            <section>
              <h3 className="text-[11px] uppercase tracking-widest text-ink-dim mb-2">
                Existing bogeys
              </h3>
              <p className="text-[12px] text-ink-faint italic">
                None yet. Use the manual-entry form below or the multi-symbol PDF upload on the Today page to add bogeys for this event.
              </p>
            </section>
          ) : (
            <section>
              <h3 className="text-[11px] uppercase tracking-widest text-ink-dim mb-2">
                Existing bogeys ({existing.length})
              </h3>
              <ul className="space-y-2">
                {existing.map((b) => (
                  <li
                    key={b.id}
                    className="rounded border border-edge bg-raised/40 px-3 py-2 text-[13px]"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium text-ink truncate">
                        {b.source_label ?? `${b.source}`}
                      </span>
                      <button
                        type="button"
                        onClick={() => remove(b.id)}
                        className="text-[11px] text-ink-faint hover:text-down"
                      >
                        delete
                      </button>
                    </div>
                    <div className="text-[12px] text-ink-dim mt-1 space-x-2 font-mono">
                      {b.eps_consensus != null && <span>EPS {b.eps_consensus.toFixed(2)}</span>}
                      {b.eps_whisper != null && <span>· whisper {b.eps_whisper.toFixed(2)}</span>}
                      {b.revenue_consensus_usd != null && (
                        <span>· rev {formatLargeUSD(b.revenue_consensus_usd)}</span>
                      )}
                      {b.revenue_whisper_usd != null && (
                        <span>· rev whisper {formatLargeUSD(b.revenue_whisper_usd)}</span>
                      )}
                      {b.expected_move_pct != null && (
                        <span>· move ±{b.expected_move_pct.toFixed(1)}%</span>
                      )}
                    </div>
                    {b.guidance_notes && (
                      <p className="text-[12px] text-ink-faint mt-1 italic">{b.guidance_notes}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Actuals — manual override of the reported numbers */}
          <form onSubmit={saveActuals} className="space-y-3 border-t border-edge pt-4">
            <div className="flex items-baseline justify-between">
              <h3 className="text-[11px] uppercase tracking-widest text-ink-dim">
                Reported actuals (manual override)
              </h3>
              {actualsEnrichedAt && (
                <span className="text-[10px] font-mono text-ink-faint">
                  enriched {actualsEnrichedAt.slice(0, 16)}
                </span>
              )}
            </div>
            <p className="text-[11px] text-ink-faint">
              Type these in directly when enrichment misses or you want to lock the print
              numbers manually. Saves to the recap email scoreboard.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Actual EPS">
                <input
                  type="text"
                  value={actuals.eps_actual}
                  onChange={(e) => setActuals({ ...actuals, eps_actual: e.target.value })}
                  placeholder="0.91"
                  className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold"
                />
              </Field>
              <Field label="Actual revenue">
                <input
                  type="text"
                  value={actuals.revenue_actual}
                  onChange={(e) => setActuals({ ...actuals, revenue_actual: e.target.value })}
                  placeholder="$4.34B"
                  className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold"
                />
              </Field>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="submit"
                disabled={savingActuals}
                className="relative text-[14px] font-medium bg-up/15 text-up border border-up/40 hover:bg-up/25 disabled:opacity-50 rounded px-3 py-1 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
              >
                {savingActuals ? "Saving…" : "Save actuals"}
              </button>
            </div>
          </form>

          {/* Manual entry form */}
          <form onSubmit={save} className="space-y-3 border-t border-edge pt-4">
            <h3 className="text-[11px] uppercase tracking-widest text-ink-dim">
              Add manual bogeys
            </h3>
            <Field label="Source label (optional)">
              <input
                type="text"
                value={form.source_label}
                onChange={(e) => setForm({ ...form, source_label: e.target.value })}
                placeholder="e.g. TMT Breakout 2026-04-28"
                className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:border-gold"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="EPS consensus">
                <input
                  type="text"
                  value={form.eps_consensus}
                  onChange={(e) => setForm({ ...form, eps_consensus: e.target.value })}
                  placeholder="0.46"
                  className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold"
                />
              </Field>
              <Field label="EPS whisper">
                <input
                  type="text"
                  value={form.eps_whisper}
                  onChange={(e) => setForm({ ...form, eps_whisper: e.target.value })}
                  placeholder="0.50"
                  className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold"
                />
              </Field>
              <Field label="Revenue consensus">
                <input
                  type="text"
                  value={form.revenue_consensus}
                  onChange={(e) => setForm({ ...form, revenue_consensus: e.target.value })}
                  placeholder="$3.85B or 3.85B"
                  className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold"
                />
              </Field>
              <Field label="Revenue whisper">
                <input
                  type="text"
                  value={form.revenue_whisper}
                  onChange={(e) => setForm({ ...form, revenue_whisper: e.target.value })}
                  placeholder="$3.90B"
                  className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold"
                />
              </Field>
              <Field label="Expected move %">
                <input
                  type="text"
                  value={form.expected_move}
                  onChange={(e) => setForm({ ...form, expected_move: e.target.value })}
                  placeholder="±6%"
                  className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold"
                />
              </Field>
            </div>
            <Field label="Guidance bogeys">
              <input
                type="text"
                value={form.guidance_notes}
                onChange={(e) => setForm({ ...form, guidance_notes: e.target.value })}
                placeholder="FY26 revenue guide $19.5–20.0B"
                className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:border-gold"
              />
            </Field>
            <Field label="Notes">
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
                placeholder="Catalysts, key call topics, asymmetry…"
                className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:border-gold resize-none"
              />
            </Field>
            {error && (
              <p className="text-[12px] text-down">{error}</p>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="relative text-[14px] text-ink-faint hover:text-ink-dim pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="relative text-[14px] font-medium bg-gold/20 text-gold-ink border border-gold/40 hover:bg-gold/30 disabled:opacity-50 rounded px-3 py-1 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-ink-faint block mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
