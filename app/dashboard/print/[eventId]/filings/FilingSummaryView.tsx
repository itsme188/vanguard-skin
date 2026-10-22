"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import apiFetch from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
import { Chip, CHIP_TONE_CLASSES } from "@/app/dashboard/components/Chip";
import { CHIP_TONE_TEXT } from "@/app/dashboard/components/chip-tone-text";
import { useConfirmPrompt } from "@/app/dashboard/components/useConfirmPrompt";
import type { FullRun, FullSection, FullView, PublicBogey, ViewClaim } from "@/lib/filing-summary/view";
import {
  bogeyValueText,
  choiceValue,
  comparisonLine,
  countsText,
  modelQuoteLine,
  newRequestKey,
  optionText,
  reasonText,
  sectionErrorSentence,
  statusLabel,
  statusTone,
} from "@/lib/filing-summary/labels";
import {
  claimReasonCodes,
  correctedByText,
  defaultRunId,
  filingLine,
  footnoteWhere,
  numberFootnotes,
  rerunPrompt,
  retryAvailable,
  retryPrompt,
  runPillLabel,
  sectionHeading,
  topContradicted,
} from "./page-text";

/** While a run is reading, the server page is refreshed this often. */
const RUNNING_REFRESH_MS = 15_000;

const BUTTON =
  "rounded-md border border-edge bg-panel px-3 py-1.5 text-sm text-ink hover:bg-raised disabled:cursor-not-allowed disabled:text-ink-dim";

export function FilingSummaryView({ view }: { view: FullView }) {
  const router = useRouter();
  const prompt = useConfirmPrompt();
  const [picked, setPicked] = useState<number | null>(null);
  const [choice, setChoice] = useState<string>(choiceValue(view.choice.current));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const selectedId = defaultRunId(view, picked);
  const run = view.runs.find((r) => r.runId === selectedId) ?? null;
  const anyRunning = view.runs.some((r) => r.status === "running");

  // A run that is still reading fills in on the server; refresh until it settles.
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => router.refresh(), RUNNING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [anyRunning, router]);

  async function rerun() {
    const option = view.choice.options.find((o) => choiceValue(o.choice) === choice);
    if (!option) return;
    // A re-run reads the newest run's filing list again.
    const filingCount = Math.max(0, ...view.runs.map((r) => r.sections.length));
    if (!(await prompt.ask(rerunPrompt(option, filingCount)))) return;
    setBusy(true);
    setMessage(null);
    // A fresh key per confirmed click: a double-submit of this click is one run, a new click is a new run.
    // newRequestKey falls back to getRandomValues where randomUUID is missing (the phone over plain http).
    const requestKey = newRequestKey();
    try {
      let res: Response;
      try {
        res = await apiFetch("/api/filing-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventId: view.event.eventId,
            action: "rerun",
            family: option.choice.family,
            effort: option.choice.effort,
            requestKey,
          }),
        });
      } catch {
        setMessage(networkFailureMessage("start the re-run"));
        return;
      }
      const r = await readMutationResult<{ data?: { runId?: number } }>(res);
      if (!r.ok) {
        setMessage(r.message);
        return;
      }
      const runId = r.data.data?.runId;
      if (typeof runId === "number") setPicked(runId);
      setMessage(`Re-run with ${option.label} started. This page updates while it reads.`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function retry(target: FullRun) {
    if (!(await prompt.ask(retryPrompt(target)))) return;
    setBusy(true);
    setMessage(null);
    try {
      let res: Response;
      try {
        res = await apiFetch("/api/filing-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventId: view.event.eventId,
            action: "retry",
            runId: target.runId,
            requestKey: newRequestKey(),
          }),
        });
      } catch {
        setMessage(networkFailureMessage("retry the run"));
        return;
      }
      const r = await readMutationResult(res);
      if (!r.ok) {
        setMessage(r.message);
        return;
      }
      setMessage(`Run ${target.runNo} is retrying. This page updates while it reads.`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const title = `${view.event.symbol ?? "Print"} · ${view.event.quarterLabel ? `${view.event.quarterLabel} ` : ""}filing summary`;
  const disarmed = view.event.pollState === "cancelled";
  const rerunBlocked = disarmed
    ? "This print was disarmed; re-arm it on Today to re-run."
    : view.inProgressRunId !== null
      ? "A re-run is reading now; wait for it to finish before starting another."
      : null;

  return (
    <div className="space-y-4">
      {prompt.dialog}
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-ink whitespace-nowrap!">{title}</h1>
        <p className="text-sm text-ink-dim [overflow-wrap:anywhere]">
          {[view.event.companyName, `print of ${view.event.eventDate}`].filter(Boolean).join(" · ")}
        </p>
        {view.event.pollDetail && <p className="text-sm text-ink-dim [overflow-wrap:anywhere]">{view.event.pollDetail}</p>}
      </header>

      {view.runs.length > 0 ? (
        <nav aria-label="Summary runs" className="flex flex-wrap gap-2">
          {[...view.runs].reverse().map((r) => {
            const on = r.runId === selectedId;
            return (
              <button
                key={r.runId}
                type="button"
                aria-pressed={on}
                onClick={() => setPicked(r.runId)}
                className={`rounded-full border px-3 py-1 text-left text-sm [overflow-wrap:anywhere] ${
                  on ? "border-ink bg-raised font-medium text-ink" : "border-edge text-ink-dim hover:text-ink"
                }`}
              >
                {runPillLabel(r)}
              </button>
            );
          })}
        </nav>
      ) : (
        <p className="text-sm text-ink-dim">
          No summary has run for this print yet. {view.runSummaryAvailable ? "Use Run summary on Today to start one." : ""}
        </p>
      )}

      {view.runs.length > 0 && (
        <section aria-label="Re-run" className="flex flex-wrap items-center gap-2">
          <label htmlFor="rerun-choice" className="text-sm text-ink-dim">
            Re-run with
          </label>
          <select
            id="rerun-choice"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            disabled={busy || rerunBlocked !== null}
            className="max-w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-sm text-ink"
          >
            {view.choice.options.map((o) => (
              <option key={choiceValue(o.choice)} value={choiceValue(o.choice)}>
                {optionText(o)}
              </option>
            ))}
          </select>
          <button type="button" onClick={rerun} disabled={busy || rerunBlocked !== null} className={BUTTON}>
            Re-run
          </button>
          {rerunBlocked && <p className="w-full text-sm text-ink-dim">{rerunBlocked}</p>}
        </section>
      )}

      {message && (
        <p role="status" className="text-sm text-ink [overflow-wrap:anywhere]">
          {message}
        </p>
      )}

      {run && (
        <RunBlock
          run={run}
          eventId={view.event.eventId}
          canRetry={retryAvailable(run, view.event.pollState) && !busy}
          onRetry={() => retry(run)}
        />
      )}

      <FilingsList view={view} run={run} />
    </div>
  );
}

function RunBlock({
  run,
  eventId,
  canRetry,
  onRetry,
}: {
  run: FullRun;
  eventId: number;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const contradicted = topContradicted(run);
  const hasDone = run.sections.some((s) => s.status === "done");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">{countsText(run.counts)}</p>
        {hasDone && (
          <a
            href={`/api/filing-summary/${eventId}/share?runId=${run.runId}`}
            download
            className="text-sm text-ink underline underline-offset-2"
          >
            Make shareable page
          </a>
        )}
      </div>

      {contradicted.length > 0 && (
        <div role="alert" className={`rounded-lg px-3 py-2 text-sm ${CHIP_TONE_CLASSES.down}`}>
          <p className="font-medium">
            {contradicted.length === 1
              ? "A Top claim is contradicted by the filing's own figures."
              : `${contradicted.length} Top claims are contradicted by the filing's own figures.`}
          </p>
          <ul className="mt-1 list-disc pl-5">
            {contradicted.map((c) => (
              <li key={c.claimId} className="[overflow-wrap:anywhere]">
                {c.renderedText}
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.status === "running" && (
        <p className="text-sm text-ink-dim">
          Run {run.runNo} is still reading with {run.modelLabel} {run.effort}. Sections appear as they finish.
        </p>
      )}
      {run.fallbackNote && <Banner>{run.fallbackNote}</Banner>}
      {run.incomplete && (
        <Banner>Incomplete: at least one filing was only partly read. The coverage lists say what was skipped and why.</Banner>
      )}
      {run.excludesAfterEt && <Banner>Does not include filings found after {run.excludesAfterEt}.</Banner>}
      {(run.status === "failed" || run.status === "waiting_retry") && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-ink">
            {run.status === "failed"
              ? "This run did not finish every filing."
              : "A later filing waits for Retry and is not in this run yet."}
          </p>
          {canRetry && (
            <button type="button" onClick={onRetry} className={BUTTON}>
              Retry
            </button>
          )}
        </div>
      )}

      {run.sections.map((s) => (
        <SectionBlock key={s.sectionId} section={s} />
      ))}

      <BogeyList bogeys={run.bogeys} />
    </div>
  );
}

/** "Bogeys before the print": the run's frozen snapshot, public fields only (R15). */
function BogeyList({ bogeys }: { bogeys: PublicBogey[] }) {
  return (
    <section className="space-y-2 rounded-xl bg-panel p-4 card-elev">
      <h2 className="text-base font-semibold text-ink whitespace-nowrap!">Bogeys before the print</h2>
      {bogeys.length === 0 ? (
        <p className="text-sm text-ink-dim">No bogeys were on file before the print.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {bogeys.map((b) => (
            <li key={b.key} className="text-ink-dim [overflow-wrap:anywhere]">
              <span className="text-ink">{b.label}</span>: {bogeyValueText(b)} · {b.provenance} · {b.asOf}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <p className={`rounded-lg px-3 py-2 text-sm [overflow-wrap:anywhere] ${CHIP_TONE_CLASSES.warn}`}>{children}</p>
  );
}

function SectionBlock({ section }: { section: FullSection }) {
  const numbers = numberFootnotes(section);
  return (
    <section className="space-y-2 rounded-xl bg-panel p-4 card-elev">
      <h2 className="text-base font-semibold text-ink whitespace-nowrap!">{sectionHeading(section)}</h2>

      {section.status === "done" ? (
        <>
          {section.headline && <p className="text-sm text-ink [overflow-wrap:anywhere]">{section.headline}</p>}
          {section.counts && <p className="text-sm text-ink-dim">{countsText(section.counts)}</p>}
        </>
      ) : (
        <p className="text-sm text-ink">
          {section.status === "waiting_retry"
            ? sectionErrorSentence("awaiting_retry")
            : section.status === "failed"
              ? sectionErrorSentence(section.errorClass)
              : section.status === "running"
                ? "Reading now."
                : "Waiting its turn."}
        </p>
      )}

      {section.incomplete && (
        <Banner>Incomplete: part of this filing was skipped or could not be read (see coverage).</Banner>
      )}

      {section.coverage.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-dim">Coverage ({section.coverage.length} documents)</summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {section.coverage.map((e) => (
              <li key={`${e.fileName}:${e.docType}`} className="text-ink-dim [overflow-wrap:anywhere]">
                {e.fileName} ({e.docType}): {e.status}
                {e.reason ? ` — ${e.reason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      {section.status === "done" && section.claims.length > 0 && (
        <ol className="space-y-3">
          {section.claims.map((c) => (
            <ClaimRow key={c.claimId} claim={c} section={section} numbers={numbers} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ClaimRow({
  claim,
  section,
  numbers,
}: {
  claim: ViewClaim;
  section: FullSection;
  numbers: Map<string, number>;
}) {
  const reasons = claimReasonCodes(claim);
  const comparisons = claim.comparisonChecks;
  return (
    <li className="grid gap-2 border-t border-edge pt-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-4">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={statusTone(claim.status)}>{statusLabel(claim.status)}</Chip>
          {claim.top && <Chip tone="neutral">Top</Chip>}
          {claim.routine && <Chip tone="neutral">Routine</Chip>}
        </div>
        <p className="text-sm text-ink [overflow-wrap:anywhere]">
          {claim.renderedText}
          {claim.footnotes.map((f) => {
            const n = numbers.get(`${claim.claimId}:${f.citationId}`);
            return n === undefined ? null : (
              <a
                key={f.citationId}
                href={`#fn-${section.sectionId}-${n}`}
                className="ml-0.5 align-super text-xs text-ink-dim underline"
              >
                [{n}]
              </a>
            );
          })}
        </p>
        {claim.correctedBy && <p className="text-sm text-ink-dim">{correctedByText(claim.correctedBy)}</p>}
        {comparisons.length > 0 && (
          <ul className="space-y-0.5 text-sm text-ink">
            {comparisons.map((cc, i) => (
              <li
                key={i}
                className={`[overflow-wrap:anywhere] ${cc.verdict === "contradicted" ? CHIP_TONE_TEXT.down : ""}`}
              >
                {comparisonLine(cc)}
              </li>
            ))}
          </ul>
        )}
        {reasons.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-dim">
            {reasons.map((code) => (
              <li key={code}>{reasonText(code)}</li>
            ))}
          </ul>
        )}
      </div>

      {claim.footnotes.length > 0 && (
        <ol className="min-w-0 space-y-2 text-sm">
          {claim.footnotes.map((f) => {
            const n = numbers.get(`${claim.claimId}:${f.citationId}`);
            return (
              <li key={f.citationId} id={n === undefined ? undefined : `fn-${section.sectionId}-${n}`} className="text-ink-dim">
                <span className="text-ink [overflow-wrap:anywhere]">
                  [{n}] {f.document}
                </span>
                {" · "}
                {footnoteWhere(f)}
                {f.sentence && <span className="block text-ink [overflow-wrap:anywhere]">“{f.sentence}”</span>}
                {f.status !== "found" && f.modelQuote && (
                  <span className="block text-ink [overflow-wrap:anywhere]">{modelQuoteLine(f.modelQuote)}</span>
                )}
                {f.url && " "}
                {f.url && (
                  <a href={f.url} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
                    open on sec.gov
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}

function FilingsList({ view, run }: { view: FullView; run: FullRun | null }) {
  if (view.filings.length === 0) return null;
  const inRun = new Set(run ? run.sections.filter((s) => s.status === "done").map((s) => s.filingId) : []);
  return (
    <section className="space-y-2 rounded-xl bg-panel p-4 card-elev">
      <h2 className="text-base font-semibold text-ink whitespace-nowrap!">Filings found</h2>
      <ul className="space-y-1 text-sm">
        {view.filings.map((f) => (
          <li key={f.filingId} className="text-ink-dim [overflow-wrap:anywhere]">
            {filingLine(f, inRun.has(f.filingId))}
            {f.indexUrl && (
              <>
                {" · "}
                <a href={f.indexUrl} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
                  filing on sec.gov
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
