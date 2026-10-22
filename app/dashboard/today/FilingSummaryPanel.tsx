"use client";

/**
 * The armed-print filing summary inside the print row (spec §9, §11).
 *
 * Shows the status line, the model that wrote the summary (with its fallback
 * note), the counts, a call-out when a Top 3 claim is contradicted, the Top 3
 * claims with a status chip and footnote links to sec.gov, and a link to the
 * full summary page. **Run summary** (a late arm) and **Retry** (a failed run)
 * spend money, so each asks first through the app dialog and names the model
 * and the rough cost.
 *
 * `readOnly` (the finished-print record) renders no buttons at all.
 *
 * Privacy: filing text and the app's checks are public market data and render
 * plain. Bogey figures are never shown here (they live on the full page).
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import apiFetch from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
import type { FullView, PanelView, ViewClaim } from "@/lib/filing-summary/view";
import { CHIP_TONE_CLASSES, Chip } from "../components/Chip";
import { CHIP_TONE_TEXT } from "../components/chip-tone-text";
import { useConfirmPrompt } from "../components/useConfirmPrompt";
import {
  FILING_SUMMARY_POLL_MS,
  countsText,
  footnoteTitle,
  needsPolling,
  newRequestKey,
  pollStateText,
  readingDocs,
  retryConfirmMessage,
  runConfirmMessage,
  sectionNotes,
  statusLabel,
  statusTone,
  type ReadingDocs,
} from "./filing-summary-text";

type Busy = "run" | "retry" | null;

const BUTTON_CLASS =
  "relative text-[12px] font-mono text-ink-dim hover:text-ink border border-edge rounded px-2.5 py-1 disabled:opacity-50 pointer-coarse:min-h-6 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']";

export default function FilingSummaryPanel({
  eventId,
  readOnly = false,
}: {
  eventId: number;
  /** The finished-print record: no Run or Retry buttons. */
  readOnly?: boolean;
}) {
  const [view, setView] = useState<PanelView | null>(null);
  const [reading, setReading] = useState<ReadingDocs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Bumped after a mutation so the poll loop restarts with a fresh read. */
  const [reloadNonce, setReloadNonce] = useState(0);
  /** The last view read, for the poll loop to decide on without re-rendering it. */
  const viewRef = useRef<PanelView | null>(null);
  /** The request key of the click in flight; a second click is ignored. */
  const requestKeyRef = useRef<string | null>(null);
  const prompt = useConfirmPrompt();

  // The poll loop: read once, then every 30 s while needsPolling says
  // something can still change. It depends on the event and the nonce only;
  // the last view sits in a ref so no state feeds the effect (the
  // useCallback render-loop gotcha).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function readOnce(): Promise<void> {
      try {
        const res = await apiFetch(`/api/filing-summary?eventIds=${eventId}`);
        const r = await readMutationResult<{ data?: Record<string, PanelView> }>(res);
        if (cancelled) return;
        if (!r.ok) {
          setLoadError(`Couldn't read the filing summary: ${r.message}`);
          return;
        }
        const next = r.data.data?.[String(eventId)] ?? null;
        viewRef.current = next;
        setView(next);
        setLoadError(next ? null : "No filing summary state was found for this print.");
        const active = next?.inProgress?.status === "running" ? next.inProgress : next?.shown?.status === "running" ? next.shown : null;
        const docs = active ? await readDocs(active.runId) : null;
        if (!cancelled) setReading(docs);
      } catch {
        if (!cancelled) setLoadError(networkFailureMessage("read the filing summary"));
      }
    }

    async function readDocs(runId: number): Promise<ReadingDocs | null> {
      // The document count is a nicety on the status line; when the full view
      // cannot be read the line falls back to the form alone.
      try {
        const res = await apiFetch(`/api/filing-summary/${eventId}`);
        const r = await readMutationResult<{ data?: FullView }>(res);
        return r.ok && r.data.data ? readingDocs(r.data.data, runId) : null;
      } catch {
        return null;
      }
    }

    async function tick(): Promise<void> {
      await readOnce();
      if (cancelled) return;
      const last = viewRef.current;
      // Keep trying after a failed first read; stop once nothing will change.
      if (!last || needsPolling(last)) timer = setTimeout(tick, FILING_SUMMARY_POLL_MS);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [eventId, reloadNonce]);

  async function post(
    kind: Exclude<Busy, null>,
    body: Record<string, unknown>,
    doneText: string,
    failVerb: string,
  ): Promise<void> {
    if (requestKeyRef.current) return;
    const requestKey = newRequestKey();
    requestKeyRef.current = requestKey;
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      const res = await apiFetch("/api/filing-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, requestKey, ...body }),
      });
      const r = await readMutationResult<{ data?: { runId?: number; created?: boolean } }>(res);
      if (!r.ok) {
        setError(`Couldn't ${failVerb}: ${r.message}`);
        return;
      }
      setNote(r.data.data?.created === false ? "Already started — this click was the same request." : doneText);
      setReloadNonce((n) => n + 1);
    } catch {
      setError(networkFailureMessage(failVerb));
    } finally {
      requestKeyRef.current = null;
      setBusy(null);
    }
  }

  async function onRun(): Promise<void> {
    if (!view) return;
    const ok = await prompt.ask({
      title: "Run the filing summary?",
      message: runConfirmMessage(view.choice, view.nowLabel),
      confirmLabel: "Run summary",
    });
    if (!ok) {
      setNote("Not run — nothing was spent.");
      setError(null);
      return;
    }
    await post(
      "run",
      { action: "run", family: view.choice.family, effort: view.choice.effort },
      "Summary started — this panel updates as it reads.",
      "start the summary",
    );
  }

  async function onRetry(): Promise<void> {
    const run = view?.shown;
    if (!run) return;
    const ok = await prompt.ask({
      title: "Retry the filing summary?",
      message: retryConfirmMessage(run),
      confirmLabel: "Retry",
    });
    if (!ok) {
      setNote("Not retried — nothing was spent.");
      setError(null);
      return;
    }
    await post("retry", { action: "retry", runId: run.runId }, "Retry started — this panel updates as it reads.", "retry the summary");
  }

  if (!view) {
    return (
      <section className="mt-3 border-t border-edge pt-2">
        <h4 className="text-[11px] font-mono uppercase tracking-wider text-ink-faint whitespace-nowrap!">Filing summary</h4>
        <p className={`text-[12px] ${loadError ? CHIP_TONE_TEXT.down : "text-ink-dim"}`}>{loadError ?? "Loading…"}</p>
      </section>
    );
  }

  return (
    <>
      <FilingSummaryPanelBody
        view={view}
        reading={reading}
        readOnly={readOnly}
        busy={busy}
        error={error ?? loadError}
        note={note}
        onRun={() => void onRun()}
        onRetry={() => void onRetry()}
      />
      {prompt.dialog}
    </>
  );
}

function FootnoteMarker({ n, fn }: { n: number; fn: ViewClaim["footnotes"][number] }) {
  const warn = fn.status === "not_found" || fn.status === "ambiguous";
  const cls = `relative inline-flex items-center justify-center font-mono text-[11px] pointer-coarse:min-h-6 pointer-coarse:min-w-6 ${
    warn ? CHIP_TONE_TEXT.warn : "text-ink-dim"
  }`;
  const title = footnoteTitle(fn);
  if (!fn.url) {
    return (
      <span className={cls} title={`${title} (no link)`}>
        [{n}]
      </span>
    );
  }
  return (
    <a href={fn.url} target="_blank" rel="noreferrer" title={title} className={`${cls} underline underline-offset-2`}>
      [{n}]
    </a>
  );
}

/**
 * The panel's presentational body: no state, no fetches, so it renders on the
 * server in tests. Buttons appear only when `readOnly` is false.
 */
export function FilingSummaryPanelBody({
  view,
  reading,
  readOnly,
  busy,
  error,
  note,
  onRun,
  onRetry,
}: {
  view: PanelView;
  reading: ReadingDocs | null;
  readOnly: boolean;
  busy: Busy;
  error: string | null;
  note: string | null;
  onRun: () => void;
  onRetry: () => void;
}) {
  const shown = view.shown;
  const top = shown?.top ?? [];
  const contradictedTop = top.some((c) => c.status === "contradicted");
  const canRetry =
    !readOnly &&
    view.pollState !== "cancelled" &&
    (shown?.status === "failed" || shown?.status === "waiting_retry");
  const canRun = !readOnly && view.runSummaryAvailable;
  const notes = shown && shown.status !== "done" ? sectionNotes(shown) : [];
  const hasRun = !!(shown || view.inProgress);
  const hasDone = !!shown?.sectionStates.some((s) => s.status === "done");

  return (
    <section className="mt-3 border-t border-edge pt-2 min-w-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h4 className="text-[11px] font-mono uppercase tracking-wider text-ink-faint whitespace-nowrap!">Filing summary</h4>
        <p className="text-[12px] text-ink [overflow-wrap:anywhere]">{pollStateText(view, reading)}</p>
      </div>

      {contradictedTop && (
        <p className={`mt-1.5 rounded px-2 py-1 text-[12px] ${CHIP_TONE_CLASSES.down}`}>
          A Top 3 claim is contradicted by the filing. Read it below before relying on the summary.
        </p>
      )}

      {shown && hasDone && (
        <p className="mt-1 text-[11px] text-ink-dim [overflow-wrap:anywhere]">
          Written by {shown.modelLabel} at {shown.effort} effort
          {shown.counts.claims > 0 ? ` · ${countsText(shown.counts)}` : ""}
        </p>
      )}
      {shown?.fallbackNote && (
        <p className={`text-[11px] ${CHIP_TONE_TEXT.warn} [overflow-wrap:anywhere]`}>{shown.fallbackNote}</p>
      )}
      {shown?.incomplete && (
        <p className={`text-[11px] ${CHIP_TONE_TEXT.warn}`}>
          Some documents were left out; the full summary lists which and why.
        </p>
      )}
      {shown?.excludesAfterEt && (
        <p className="text-[11px] text-ink-dim">Does not include filings found after {shown.excludesAfterEt}.</p>
      )}
      {notes.length > 0 && (
        <ul className="mt-1 text-[11px] text-ink-dim">
          {notes.map((n) => (
            <li key={n} className="[overflow-wrap:anywhere]">
              {n}
            </li>
          ))}
        </ul>
      )}

      {top.length > 0 && (
        <ol className="mt-2 space-y-1.5">
          {top.map((c) => (
            <li key={c.claimId} className="text-[13px] text-ink min-w-0">
              <Chip tone={statusTone(c.status)} size="xs" className="mr-1.5 align-middle">
                {statusLabel(c.status)}
              </Chip>
              <span className="[overflow-wrap:anywhere]">{c.renderedText}</span>
              {c.footnotes.map((fn, i) => (
                <span key={fn.citationId} className="ml-0.5">
                  <FootnoteMarker n={i + 1} fn={fn} />
                </span>
              ))}
              {c.correctedBy && (
                <span className={`block text-[11px] ${CHIP_TONE_TEXT.warn}`}>
                  Corrected by {c.correctedBy.form}
                  {c.correctedBy.acceptedAtEt ? ` at ${c.correctedBy.acceptedAtEt}` : ""}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      {error && <p className={`mt-1.5 text-[12px] ${CHIP_TONE_TEXT.down} [overflow-wrap:anywhere]`}>{error}</p>}
      {note && !error && <p className="mt-1.5 text-[12px] text-ink-dim">{note}</p>}

      <div className="mt-2 flex items-center gap-3 flex-wrap">
        {hasRun && (
          <Link
            href={`/dashboard/print/${view.eventId}/filings`}
            className="relative text-[12px] font-mono text-ink-dim hover:text-ink underline underline-offset-2 pointer-coarse:min-h-6 inline-flex items-center"
          >
            Open full summary
          </Link>
        )}
        {canRun && (
          <button type="button" onClick={onRun} disabled={busy !== null} className={BUTTON_CLASS}>
            {busy === "run" ? "Starting…" : "Run summary"}
          </button>
        )}
        {canRetry && (
          <button type="button" onClick={onRetry} disabled={busy !== null} className={BUTTON_CLASS}>
            {busy === "retry" ? "Retrying…" : "Retry"}
          </button>
        )}
      </div>
    </section>
  );
}
