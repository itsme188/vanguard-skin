"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { coercePercent, formatEnrichedAtET, formatLargeUSD, parseLargeUSD } from "@/lib/format";
import { parseActualsInput } from "@/lib/earnings/actuals-validation";
import { formatBogeyFields, formatBogeyFieldLine } from "@/lib/earnings/format-bogey-fields";
import { PrivateText } from "@/lib/privacy/components";
import type { EarningsBogey } from "@/lib/queries/earnings-bogeys";
import apiFetch from "@/lib/http/apiFetch";
import {
  isUuidV4,
  parseExtraMetrics,
  MAX_LABEL,
  MAX_DEFINITION,
  type ExtraMetricSpec,
} from "@/lib/print-watch/extra-metrics";

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
 * One desk-defined extra metric line while it is being edited (spec §4.7).
 * Rows hold STRINGS and ship strings: `parseExtraMetrics` reads each number
 * against its row's own unit (usd takes the parseLargeUSD grammar, pct takes a
 * decimal with an optional %), and nothing here coerces. Parsing in the modal
 * would have to duplicate that table — and did, wrongly: parseLargeUSD applied
 * to a `pct` row turned a typed "27.5%" into "no bogey".
 */
interface ExtraRow {
  id: string;
  label: string;
  definition: string;
  unit: ExtraMetricSpec["unit"];
  kind: ExtraMetricSpec["kind"];
  period: ExtraMetricSpec["period"];
  basis: ExtraMetricSpec["basis"];
  consensus: string;
  whisper: string;
}

const EMPTY_EXTRA_ROW = {
  label: "",
  definition: "",
  unit: "usd",
  kind: "point",
  period: "Q",
  basis: "na",
  consensus: "",
  whisper: "",
} satisfies Omit<ExtraRow, "id">;

function extraRowsToJson(rows: ExtraRow[]): string | null {
  if (rows.length === 0) return null;
  return JSON.stringify(rows.map((r) => ({
    id: r.id,
    label: r.label.trim(),
    definition: r.definition.trim(),
    unit: r.unit,
    kind: r.kind,
    period: r.period,
    basis: r.basis,
    consensus: r.consensus.trim() === "" ? null : r.consensus.trim(),
    whisper: r.whisper.trim() === "" ? null : r.whisper.trim(),
  })));
}

/** What GET /api/earnings/bogeys adds to each stored row: its specs already
 *  parsed, so the editor can preserve ids instead of re-minting them. */
type BogeyWithSpecs = EarningsBogey & {
  extraMetrics?: ExtraMetricSpec[];
  extraMetricErrors?: string[];
};

interface ExtraMetricConflict {
  id: string;
  fields: string[];
}

/**
 * Per-event bogeys editor. Lists existing bogey rows from any source
 * (PDF / manual / newsletter) and lets the user add or update a manual
 * entry. Revenue inputs accept "$4.34B" / "4340M" / "4,340,000,000" via
 * parseLargeUSD — same syntax accepted on the email composer side.
 */
export function BogeysEditModal({ eventId, symbol, open, onClose }: Props) {
  const router = useRouter();
  const [existing, setExisting] = useState<BogeyWithSpecs[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [actuals, setActuals] = useState<ActualsState>(EMPTY_ACTUALS);
  const [actualsEnrichedAt, setActualsEnrichedAt] = useState<string | null>(null);
  const [actualsManualAt, setActualsManualAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [printedOk, setPrintedOk] = useState(false);
  const [printedRoad, setPrintedRoad] = useState<"pdf" | "monospace" | null>(null);
  const [savingActuals, setSavingActuals] = useState(false);
  const [clearingActuals, setClearingActuals] = useState(false);
  const [clearedActualsMsg, setClearedActualsMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [extraRows, setExtraRows] = useState<ExtraRow[]>([]);
  const [extraErrors, setExtraErrors] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<ExtraMetricConflict[]>([]);
  const [reuseId, setReuseId] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** The source label whose stored metrics are already in the editor, so a
   *  hydration can never overwrite the desk's own edits mid-typing. */
  const hydratedLabelRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setForm(EMPTY);
    setActuals(EMPTY_ACTUALS);
    setActualsEnrichedAt(null);
    setActualsManualAt(null);
    setClearedActualsMsg(null);
    // A reopened modal must not show a stale "Sent to printer queue" claim
    // from a previous open/close cycle.
    setPrintedOk(false);
    setPrintedRoad(null);
    setExtraRows([]);
    setExtraErrors([]);
    setConflicts([]);
    setReuseId("");
    setCopiedId(null);
    hydratedLabelRef.current = null;
    Promise.all([
      fetch(`/api/earnings/bogeys?eventId=${eventId}`).then(
        (res) =>
          res.json() as Promise<{
            success?: boolean;
            bogeys?: BogeyWithSpecs[];
            extraMetricConflicts?: ExtraMetricConflict[];
            error?: string;
          }>,
      ),
      fetch(`/api/earnings/actuals?eventId=${eventId}`).then(
        (res) =>
          res.json() as Promise<{
            eps_actual?: number | null;
            revenue_actual_usd?: number | null;
            enriched_at?: string | null;
            manual_actuals_at?: string | null;
            error?: string;
          }>,
      ),
    ])
      .then(([bogeysData, actualsData]) => {
        if (cancelled) return;
        // Additive envelope (the route keeps its `bogeys` key): a failure
        // carries `error` and no rows, so say so rather than rendering an
        // empty modal that reads as "this event has no bogeys".
        if (!bogeysData.success) {
          setError(bogeysData.error ?? "Could not load this event's bogeys.");
          setExisting([]);
          setConflicts([]);
        } else {
          setExisting(bogeysData.bogeys ?? []);
          setConflicts(bogeysData.extraMetricConflicts ?? []);
        }
        if (!actualsData.error) {
          setActuals({
            eps_actual: actualsData.eps_actual != null ? actualsData.eps_actual.toFixed(2) : "",
            revenue_actual:
              actualsData.revenue_actual_usd != null
                ? formatLargeUSD(actualsData.revenue_actual_usd)
                : "",
          });
          setActualsEnrichedAt(actualsData.enriched_at ?? null);
          setActualsManualAt(actualsData.manual_actuals_at ?? null);
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

  /**
   * Editing an existing sheet must not re-mint its ids: a new id retires the
   * live line and starts a fresh one, losing its continuity (R-F2). The manual
   * form always upserts (event, 'manual', source_label), so it hydrates from
   * the MANUAL row with that label — the row this save will overwrite — and
   * only ONCE per label, so the desk's own edits are never clobbered.
   */
  useEffect(() => {
    const label = (form.source_label ?? "").trim();
    if (hydratedLabelRef.current === label) return;
    const match = existing.find(
      (b) => b.source === "manual" && (b.source_label ?? "").trim() === label,
    );
    if (!match) return;
    hydratedLabelRef.current = label;
    setExtraRows(
      (match.extraMetrics ?? []).map((sp) => ({
        id: sp.id,
        label: sp.label,
        definition: sp.definition,
        unit: sp.unit,
        kind: sp.kind,
        period: sp.period,
        basis: sp.basis,
        consensus: sp.consensus === null || sp.consensus === undefined ? "" : String(sp.consensus),
        whisper: sp.whisper === null || sp.whisper === undefined ? "" : String(sp.whisper),
      })),
    );
  }, [form.source_label, existing]);

  /**
   * The id is minted at add-row time and immutable after that (M-F8). A pasted
   * id is how the desk points a SECOND sheet at the same metric — the compiler
   * then requires the two to agree on unit/kind/period/basis, which is what the
   * conflict banner above the rows reports.
   */
  function addExtraRow() {
    const pasted = reuseId.trim().toLowerCase();
    const id = isUuidV4(pasted) ? pasted : crypto.randomUUID();
    setReuseId("");
    setExtraRows((rows) => [...rows, { id, ...EMPTY_EXTRA_ROW }]);
  }

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
    } catch {
      // A browser that refuses clipboard access is not a failure worth a modal —
      // the id is already on screen and selectable. Say so instead of nothing.
      setCopiedId(null);
      setExtraErrors([`Could not reach the clipboard — select the id (${id}) and copy it by hand.`]);
    }
  }

  // Print the deterministic desk worksheet immediately (feedback #6) —
  // independent of the auto-print arm; honest outcome via inline error.
  async function printNow() {
    if (printing) return;
    setPrinting(true);
    setPrintedOk(false);
    setPrintedRoad(null);
    setError(null);
    try {
      const res = await apiFetch("/api/earnings/worksheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, action: "print" }),
      });
      const data = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
        road?: "pdf" | "monospace";
      } | null;
      if (!res.ok || !data?.success) {
        setError(data?.error ?? `Print failed: server returned ${res.status}.`);
        return;
      }
      // lp exit 0 means QUEUED, not paper-out — say exactly that, and say
      // which sheet went out: the email-identical PDF road, or the plain
      // text fallback (no local preview yet, or Chrome/PDF render failed).
      setPrintedOk(true);
      setPrintedRoad(data.road ?? null);
    } catch {
      setError("Print failed: could not reach the server.");
    } finally {
      setPrinting(false);
    }
  }

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

      // The server re-validates with this same parser — the client check is a
      // fast, identical refusal, never the only one.
      const extra_metrics_json = extraRowsToJson(extraRows);
      const { errors } = parseExtraMetrics(extra_metrics_json);
      if (errors.length > 0) {
        setExtraErrors(errors);
        return;
      }
      setExtraErrors([]);

      const res = await apiFetch("/api/earnings/bogeys", {
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
          extra_metrics_json,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; id?: number }
        | null;
      if (!res.ok || !data?.success) {
        setError(data?.error ?? `Server returned ${res.status}`);
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

  // Shared by the form submit and the pre-print confirm-retry — force=true
  // bypasses the server's pre-print floor (POST /api/earnings/actuals
  // refuses a future-dated release with 409 code 'pre_print' otherwise).
  async function submitActuals(force: boolean) {
    setSavingActuals(true);
    setError(null);
    try {
      const { eps_actual, revenue_actual_usd, error: validationError } = parseActualsInput(
        actuals.eps_actual,
        actuals.revenue_actual,
      );
      if (validationError) {
        setError(validationError);
        return;
      }
      const res = await apiFetch("/api/earnings/actuals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: eventId,
          eps_actual,
          revenue_actual_usd,
          force,
        }),
      });
      const data = (await res.json()) as { error?: string; code?: string; success?: boolean };
      if (!res.ok || !data.success) {
        // Pre-print floor: this print's release time is still in the
        // future. Offer a confirm-retry with force:true rather than a bare
        // refusal — the desk sometimes does want to lock in a number early
        // (e.g. a leaked/observed print ahead of the scheduled slot).
        if (res.status === 409 && data.code === "pre_print" && !force) {
          const confirmed = window.confirm(
            `${data.error ?? "This print's release time is still in the future."}\n\nSave anyway?`,
          );
          if (confirmed) {
            await submitActuals(true);
            return;
          }
          setError(data.error ?? "Save cancelled — release time is still in the future.");
          return;
        }
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

  async function saveActuals(e: React.FormEvent) {
    e.preventDefault();
    setClearedActualsMsg(null);
    await submitActuals(false);
  }

  // "Clear actuals" (QA finding
  // today-earningshub-bogeys--save-actuals-empty-silent-noop-cannot-clear,
  // decided 2026-08-03): only rendered when actualsManualAt is set, so this
  // should never hit the server's 409 (sync-owned actuals guard) in normal
  // use — but still honors the honest-button rules (check res.ok AND
  // data.success, explain no-op, no empty catch) in case of a race.
  async function clearActuals() {
    if (clearingActuals) return;
    const confirmed = window.confirm(
      "Clear the manually-entered actuals for this event?\n\n" +
        "Automatic enrichment will re-fetch fresh numbers if the print is " +
        "recent, or the event will show no actuals until you re-enter them.",
    );
    if (!confirmed) return;
    setClearingActuals(true);
    setError(null);
    setClearedActualsMsg(null);
    try {
      const res = await apiFetch("/api/earnings/actuals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: eventId, clear: true }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        code?: string;
        success?: boolean;
      } | null;
      if (!res.ok || !data?.success) {
        setError(data?.error ?? `Clear failed: server returned ${res.status}.`);
        return;
      }
      setActuals(EMPTY_ACTUALS);
      setActualsEnrichedAt(null);
      setActualsManualAt(null);
      setClearedActualsMsg(
        "Cleared — automatic enrichment will re-fetch this print's numbers if it's recent, or this will stay blank.",
      );
      router.refresh();
    } catch {
      setError("Clear failed: could not reach the server.");
    } finally {
      setClearingActuals(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Delete this bogey?")) return;
    const res = await apiFetch(`/api/earnings/bogeys?id=${id}`, { method: "DELETE" });
    const data = (await res.json().catch(() => null)) as
      | { success?: boolean; deleted?: boolean; error?: string }
      | null;
    if (!res.ok || !data?.success) {
      setError(data?.error ?? `Server returned ${res.status}`);
      return;
    }
    if (!data.deleted) {
      // Someone else already removed it. Drop it from the list either way —
      // but say what happened rather than letting the click look effective.
      setError("That bogey was already gone — nothing was deleted.");
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
                    {/* Separator is a JOIN concern, never a per-field prefix —
                        prefixing emitted a dangling "·" whenever the first
                        field was absent (qa: stray-leading-separator). */}
                    {formatBogeyFields(b).length > 0 && (
                      <div className="text-[12px] text-ink-dim mt-1 font-mono">
                        {formatBogeyFieldLine(b)}
                      </div>
                    )}
                    {b.guidance_notes && (
                      <p className="text-[12px] text-ink-faint mt-1 italic">{b.guidance_notes}</p>
                    )}
                    {/* Newsletter/AI-extracted bogeys often carry their whole
                        analytical payload here with the numeric columns NULL —
                        without this the row renders as nothing but a source
                        label and looks like empty data. */}
                    {b.notes && (
                      <p className="text-[12px] text-ink-dim mt-1 whitespace-pre-wrap">
                        <PrivateText>{b.notes}</PrivateText>
                      </p>
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
                  enriched {formatEnrichedAtET(actualsEnrichedAt)}
                </span>
              )}
            </div>
            <p className="text-[11px] text-ink-faint">
              Type these in directly when enrichment misses or you want to lock the print
              numbers manually. Saves to the recap email scoreboard.
            </p>
            {clearedActualsMsg && (
              <p className="text-[12px] text-up">{clearedActualsMsg}</p>
            )}
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
              {actualsManualAt && (
                <button
                  type="button"
                  onClick={clearActuals}
                  disabled={clearingActuals || savingActuals}
                  className="relative mr-auto text-[13px] font-mono text-ink-dim hover:text-down border border-edge rounded px-2 py-1 disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
                  title="Clear this manually-entered actual so enrichment can re-fetch it"
                >
                  {clearingActuals ? "Clearing…" : "Clear actuals"}
                </button>
              )}
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

            {/* Extra metrics — desk-defined sheet lines (spec §4.7). The id is
                the identity: adding one compiles a line, dropping one retires
                it with its evidence, and a re-mint is both. */}
            <div className="mt-4 border-t border-edge pt-3">
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <span className="text-[11px] uppercase tracking-wider text-ink-faint whitespace-nowrap!">
                  Extra metrics
                </span>
                <span className="flex items-center gap-2">
                  <input
                    type="text"
                    value={reuseId}
                    onChange={(e) => setReuseId(e.target.value)}
                    placeholder="paste an id to reuse (optional)"
                    aria-label="Reuse an existing metric id"
                    className="w-[15rem] max-w-full bg-raised border border-edge rounded px-2 py-0.5 font-mono text-[11px] text-ink-dim focus:outline-none focus:border-gold"
                  />
                  <button
                    type="button"
                    onClick={addExtraRow}
                    className="relative text-[11px] text-ink-dim hover:text-gold border border-edge rounded px-2 py-0.5 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
                  >
                    + add metric
                  </button>
                </span>
              </div>
              {conflicts.length > 0 && (
                <p className="mt-2 rounded border border-warn/40 bg-warn/10 px-2 py-1.5 text-[12px] text-warn">
                  {conflicts.map((c) => `${c.id.slice(0, 8)}… — sheets disagree on ${c.fields.join(" and ")}`).join(" · ")}
                  {" "}— no line is compiled for these until every sheet agrees.
                </p>
              )}
              {extraErrors.length > 0 && (
                <ul className="mt-2 text-[12px] text-down list-disc pl-4">
                  {extraErrors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              )}
              {extraRows.map((row, i) => (
                <div key={row.id} className="mt-2 rounded border border-edge p-2">
                  <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <span className="flex items-center gap-2">
                      <input
                        type="text"
                        value={row.id}
                        readOnly
                        aria-label="Metric id"
                        title="Immutable id — the sheet line is keyed on it"
                        className="bg-transparent font-mono text-[11px] text-ink-dim w-[19rem] max-w-full"
                      />
                      <button
                        type="button"
                        onClick={() => void copyId(row.id)}
                        className="relative text-[11px] text-ink-dim hover:text-gold underline pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
                      >
                        {copiedId === row.id ? "copied" : "copy id"}
                      </button>
                    </span>
                    <button
                      type="button"
                      onClick={() => setExtraRows((rows) => rows.filter((r) => r.id !== row.id))}
                      className="relative text-[11px] text-ink-faint hover:text-down pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
                    >
                      remove
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-1">
                    <Field label={`Label (max ${MAX_LABEL})`}>
                      <input type="text" maxLength={MAX_LABEL} value={row.label}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, label: e.target.value } : r))}
                        placeholder="Net new ARR"
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold" />
                    </Field>
                    <Field label="Unit">
                      <select value={row.unit}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, unit: e.target.value as ExtraRow["unit"] } : r))}
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold">
                        <option value="usd">usd</option><option value="per_share">per_share</option>
                        <option value="pct">pct</option><option value="count">count</option>
                      </select>
                    </Field>
                    <Field label="Kind">
                      <select value={row.kind}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, kind: e.target.value as ExtraRow["kind"] } : r))}
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold">
                        <option value="point">point</option><option value="range">range</option>
                      </select>
                    </Field>
                    <Field label="Period">
                      <select value={row.period}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, period: e.target.value as ExtraRow["period"] } : r))}
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold">
                        <option value="Q">Q</option><option value="NQ_guide">NQ_guide</option><option value="FY_guide">FY_guide</option>
                      </select>
                    </Field>
                    <Field label="Basis">
                      <select value={row.basis}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, basis: e.target.value as ExtraRow["basis"] } : r))}
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold">
                        <option value="na">na</option><option value="gaap">gaap</option><option value="non_gaap">non_gaap</option>
                      </select>
                    </Field>
                    <Field label="Consensus">
                      <input type="text" value={row.consensus}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, consensus: e.target.value } : r))}
                        placeholder={row.unit === "pct" ? "27.5%" : row.unit === "usd" ? "$300M" : "0.46"}
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold" />
                    </Field>
                    <Field label="Whisper">
                      <input type="text" value={row.whisper}
                        onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, whisper: e.target.value } : r))}
                        placeholder={row.unit === "pct" ? "28.0%" : row.unit === "usd" ? "$310M" : "0.50"}
                        className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[14px] font-mono text-ink focus:outline-none focus:border-gold" />
                    </Field>
                  </div>
                  <Field label={`Definition (max ${MAX_DEFINITION})`}>
                    <textarea rows={2} maxLength={MAX_DEFINITION} value={row.definition}
                      onChange={(e) => setExtraRows((rows) => rows.map((r, j) => j === i ? { ...r, definition: e.target.value } : r))}
                      placeholder="Sequential change in annual recurring revenue."
                      className="w-full bg-raised border border-edge rounded px-2 py-1.5 text-[13px] text-ink focus:outline-none focus:border-gold" />
                  </Field>
                </div>
              ))}
            </div>
            {error && (
              <p className="text-[12px] text-down">{error}</p>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={printNow}
                disabled={printing}
                className="relative mr-auto text-[13px] font-mono text-ink-dim hover:text-ink border border-edge rounded px-2 py-1 disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
                title="Print the one-page desk worksheet on the default printer now"
              >
                {printing
                  ? "Printing…"
                  : printedOk
                    ? `Sent to printer queue ✓${
                        printedRoad === "pdf"
                          ? " (email-fidelity sheet)"
                          : printedRoad === "monospace"
                            ? " (plain text sheet)"
                            : ""
                      }`
                    : "⎙ Print worksheet"}
              </button>
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
