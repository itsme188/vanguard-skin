"use client";

/**
 * One live print, rendered as the Hub row's expansion (M-F6).
 *
 * This is `PrintWatchPanel`'s `PrintCard` moved wholesale — the drop zone, the
 * accept / un-accept / per-candidate-accept handlers and the three 409 confirms
 * are verbatim, because they are the part of this subsystem that has been
 * fixed the most times and re-typing them is how a fix gets lost. What the
 * card gains here is what the panel never had: the go paste box, the IR-page
 * field, the prepare-step line and slice E's output buttons.
 *
 * `postAccept` stays HERE rather than moving into `PrintOutputs` (F-S8): the
 * promote button posts the same accept route as the line-level and
 * per-candidate accepts, and all three share one 409 handler. Two copies of a
 * confirm are two copies that can disagree, so `PrintOutputs` is handed a
 * finished promote control instead.
 *
 * Privacy: the bogey column and the delta against it are the desk's own
 * curated numbers and render masked (M-F19, inside `LineRow`); the reported
 * actual is public press-release data and renders plain.
 */

import { useCallback, useState, type DragEvent as ReactDragEvent } from "react";
import { useRouter } from "next/navigation";
import apiFetch from "@/lib/http/apiFetch";
import { Chip } from "../components/Chip";
import { ScrollFade } from "../components/ScrollFade";
import FirstPassRead from "./FirstPassRead";
import GoControls from "./live-print/GoControls";
import IrPageField from "./live-print/IrPageField";
import LineRow from "./live-print/LineRow";
import PrepareStatus from "./live-print/PrepareStatus";
import PrintOutputs, { PromoteButton } from "./live-print/PrintOutputs";
import {
  PRE_GATE_DISCLOSURE,
  SUPERSEDED_ACCEPT_CONFIRM_COPY,
  SUPERSEDED_CANDIDATE_CONFIRM_COPY,
  SUPERSEDED_CONFIRM_COPY,
  dropOutcomeMessage,
  fileToBase64,
  firstDroppedFile,
  goStatusText,
  ladderText,
  printStateLabel,
  promoteSummary,
  windowText,
} from "./live-print/helpers";
import type { PrepareStepWire, PrintStatusEntry } from "./hub-live/types";

interface AcceptResponse {
  success?: boolean;
  error?: string;
  code?: string;
}

interface DropResponse {
  success?: boolean;
  data?: {
    docId: number;
    isNew: boolean;
    outcome?: import("./live-print/helpers").DropOutcome;
    rejectReason?: string | null;
  };
  error?: string;
}

export default function LivePrintRow({
  print,
  prepareSteps,
  onChanged,
}: {
  print: PrintStatusEntry;
  prepareSteps: PrepareStepWire[] | undefined;
  onChanged: () => Promise<void>;
}) {
  const router = useRouter();
  const [acceptingAll, setAcceptingAll] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [unacceptingId, setUnacceptingId] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  /** `metric|doc|representation` of the per-candidate accept in flight. */
  const [acceptingCandidateKey, setAcceptingCandidateKey] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);

  // IrPageField reads the stored row in an effect keyed on `onError`, so these
  // must be identity-stable or the read re-runs on every poll tick.
  const note = useCallback((text: string) => {
    setActionNote(text);
    setActionError(null);
  }, []);
  const fail = useCallback((text: string) => {
    setActionError(text);
  }, []);

  const ladder = ladderText(print.sources);
  const summary = promoteSummary(print.lines);
  const agreedIds = print.lines.filter((l) => l.state === "agreed").map((l) => l.metric_id);
  const noEventId = print.eventId === undefined;
  const goLine = goStatusText(print.goRequest ?? null);

  async function postAccept(body: {
    /** A metric id accepts the whole line; the object form accepts ONE named
     *  candidate off a conflict row (see `acceptableRivals`). */
    accept?: Array<string | { metric_id: string; doc_id: number; representation: string }>;
    unaccept?: string[];
    promoteHeadline?: boolean;
    force?: boolean;
    forceSuperseded?: boolean;
  }): Promise<boolean> {
    if (noEventId) {
      setActionError("This print has no event reference from the server — cannot accept.");
      return false;
    }
    try {
      const res = await apiFetch("/api/print-watch/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: print.eventId, ...body }),
      });
      const data = (await res.json().catch(() => null)) as AcceptResponse | null;
      if (!res.ok || !data?.success) {
        if (res.status === 409 && data?.code === "pre_print" && !body.force) {
          const confirmed = window.confirm(
            `${data.error ?? "This print's release time is still in the future."}\n\nPromote anyway?`,
          );
          if (confirmed) return postAccept({ ...body, force: true });
          // The panel's OWN cancellation copy, never the server's. The 409
          // body ends "…Confirm to save anyway" — echoing it back to someone
          // who just declined that confirm reads as an instruction they
          // already followed and leaves them looking for a second button.
          setActionError("Promote cancelled — release time is still in the future.");
          return false;
        }
        // The server rechecked the accepted pair against the evidence that has
        // landed since (fix wave, finding B). Its own confirm, its own
        // override flag — never the pre-print `force`.
        if (res.status === 409 && data?.code === "superseded" && !body.forceSuperseded) {
          // Three gates share the code; only the click that hit them differs,
          // and each one asks a different question of the desk.
          const isPromote = body.promoteHeadline === true;
          const isCandidate =
            !isPromote && (body.accept ?? []).some((entry) => typeof entry === "object");
          const confirmed = window.confirm(
            `${data.error ?? "Newer evidence disagrees with the accepted number."}\n\n${
              isPromote
                ? SUPERSEDED_CONFIRM_COPY
                : isCandidate
                  ? SUPERSEDED_CANDIDATE_CONFIRM_COPY
                  : SUPERSEDED_ACCEPT_CONFIRM_COPY
            }`,
          );
          if (confirmed) return postAccept({ ...body, forceSuperseded: true });
          setActionError(
            isPromote
              ? "Promote cancelled — re-verify the superseded line against the release, then accept the corrected figure."
              : isCandidate
                ? "Accept cancelled — a later document disagrees; re-read the release, then accept the figure it prints."
                : "Accept cancelled — re-verify this line against the release, then accept the corrected figure.",
          );
          return false;
        }
        setActionError(data?.error ?? `Server returned ${res.status}`);
        return false;
      }
      setActionError(null);
      await onChanged();
      return true;
    } catch {
      setActionError("Could not reach the server.");
      return false;
    }
  }

  async function acceptAllAgreed() {
    if (acceptingAll || agreedIds.length === 0) return;
    setAcceptingAll(true);
    setActionNote(null);
    try {
      const ok = await postAccept({ accept: agreedIds });
      if (ok) setActionNote(`Accepted ${agreedIds.length} agreed line${agreedIds.length === 1 ? "" : "s"}.`);
    } finally {
      setAcceptingAll(false);
    }
  }

  async function promote() {
    if (promoting || !summary) return;
    setPromoting(true);
    setActionNote(null);
    try {
      const ok = await postAccept({ promoteHeadline: true });
      if (ok) {
        setActionNote("Promoted to the earnings recap scoreboard.");
        // A promote writes calendar_events.actual_value, which the
        // server-rendered hub / Today's releases / cockpit strip display —
        // re-render them so the page doesn't keep showing superseded actuals.
        router.refresh();
      }
    } finally {
      setPromoting(false);
    }
  }

  /** Per-line accept — the recovery path out of an un-accept, and the only
   *  way to accept a line the bulk button skips by design (single_source /
   *  flash, which the route allows as eyes-on overrides). Same route, same
   *  body shape and the same 409 handling as the bulk path. An accept-only
   *  request never reaches saveManualActuals, so `pre_print` cannot fire on
   *  it — but `superseded` NOW CAN: the route runs the promote gate's own
   *  comparison when the line being accepted is an un-accepted one whose
   *  number is residue, and `postAccept` answers it with the accept-side
   *  confirm. */
  async function acceptLine(metricId: string) {
    if (acceptingId) return;
    setAcceptingId(metricId);
    setActionNote(null);
    try {
      const ok = await postAccept({ accept: [metricId] });
      if (ok) setActionNote(`Accepted ${metricId} — verify it against the release before promoting.`);
    } finally {
      setAcceptingId(null);
    }
  }

  /**
   * Per-CANDIDATE accept — how a conflict row gets resolved (QA finding
   * `…unaccept-after-supersede…`). The desk names the document whose figure it
   * read, so the sheet records WHICH disclosure it verified rather than a bare
   * number; the rejected rivals stay in the evidence list underneath.
   *
   * The route refuses this with 409 `superseded` only when a LATER document
   * disagrees with the one picked — `postAccept` answers that with the
   * candidate-side confirm, never the promote copy.
   */
  async function acceptCandidate(metricId: string, docId: number, representation: string) {
    const key = `${metricId}|${docId}|${representation}`;
    if (acceptingCandidateKey) return;
    setAcceptingCandidateKey(key);
    setActionNote(null);
    try {
      const ok = await postAccept({ accept: [{ metric_id: metricId, doc_id: docId, representation }] });
      if (ok) {
        setActionNote(
          `Accepted ${metricId} from doc #${docId} — the other readings stay on the sheet as evidence.`,
        );
      }
    } finally {
      setAcceptingCandidateKey(null);
    }
  }

  async function unaccept(metricId: string) {
    if (unacceptingId) return;
    setUnacceptingId(metricId);
    setActionNote(null);
    try {
      const ok = await postAccept({ unaccept: [metricId] });
      if (ok) setActionNote(`Un-accepted ${metricId} — re-verify before accepting again.`);
    } finally {
      setUnacceptingId(null);
    }
  }

  async function handleDrop(file: File) {
    if (uploading) return;
    if (noEventId) {
      setActionError("This print has no event reference from the server — cannot upload.");
      return;
    }
    setUploading(true);
    setActionError(null);
    setActionNote(null);
    try {
      const contentBase64 = await fileToBase64(file);
      const res = await apiFetch("/api/print-watch/drop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: print.eventId, filename: file.name, contentBase64 }),
      });
      const data = (await res.json().catch(() => null)) as DropResponse | null;
      if (!res.ok || !data?.success) {
        setActionError(data?.error ?? `Upload failed: server returned ${res.status}.`);
        return;
      }
      // The server's verdict, verbatim — a 200 covers three outcomes and only
      // one of them is "the sheet moved".
      const message = dropOutcomeMessage(data.data?.outcome, data.data?.rejectReason);
      if (message.tone === "error") setActionError(message.text);
      else setActionNote(message.text);
      await onChanged();
    } catch {
      setActionError("Upload failed: could not reach the server.");
    } finally {
      setUploading(false);
    }
  }

  // A file dragged onto the card must land IN the card. Without these two
  // handlers the browser takes the drop itself and navigates the tab to the
  // dropped file — mid-print, with the sheet on screen. `preventDefault` on
  // dragover is what marks the card as a valid drop target in the first place
  // (the drop event never fires without it).
  function onDragOver(e: ReactDragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (uploading || noEventId) return;
    if (!dragActive) setDragActive(true);
  }

  function onDragLeave(e: ReactDragEvent<HTMLDivElement>) {
    // Ignore the moves BETWEEN children — only a leave that exits the card
    // itself should drop the cue.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(false);
  }

  function onDrop(e: ReactDragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = firstDroppedFile(e.dataTransfer);
    if (!file) {
      setActionError("That drop carried no file — drag the saved release (HTML or text) itself.");
      return;
    }
    void handleDrop(file);
  }

  const stateChip = printStateLabel(print.state);

  /** doc id -> the roads that produced it, in desk language. */
  const roadLines = Object.entries(print.documentRoads ?? {}).map(
    ([docId, roads]) =>
      `doc #${docId}: ${roads.map((r) => `${r.kind} via ${r.source} — ${r.verdict}`).join(" · ")}`,
  );

  /** The promote control, finished here and handed to `PrintOutputs`, so the
   *  three 409 confirms in `postAccept` stay the only copy (F-S8). */
  const promoteControl = {
    label: summary ? summary.label : "Promote EPS+Rev",
    disabled: !summary || noEventId,
    title: summary
      ? "Promote the accepted EPS + revenue pair to the recap scoreboard"
      : "Needs a complete accepted pair — an EPS line (adjusted or GAAP) AND revenue_q, both accepted",
    busy: promoting,
    onClick: () => void promote(),
  };

  return (
    <div
      className={`px-5 py-4 transition-colors ${dragActive ? "bg-raised ring-1 ring-inset ring-gold/60" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1.5">
        <div className="flex items-baseline gap-2">
          <span className="font-mono font-medium text-ink" style={{ fontSize: "15px" }}>
            {print.symbol}
          </span>
          <Chip tone={stateChip.tone} size="xs" uppercase>
            {stateChip.text}
          </Chip>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <GoControls
            eventId={print.eventId}
            goRequest={print.goRequest ?? null}
            hasWindow={print.effectiveWindow !== null && print.effectiveWindow !== undefined}
            onChanged={onChanged}
            onNote={note}
            onError={fail}
          />
          <label
            className={`relative text-[12px] font-mono border border-edge rounded px-2 py-1 cursor-pointer hover:bg-raised pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 ${
              uploading ? "opacity-60 pointer-events-none" : ""
            }`}
            title={noEventId ? "This print has no event reference from the server — cannot upload." : "Drop or choose the release document (HTML/text)"}
          >
            {uploading ? "Uploading… (may take up to 30s)" : "⇪ Drop release"}
            <input
              type="file"
              accept=".html,.htm,.txt,text/html,text/plain"
              className="hidden"
              disabled={uploading || noEventId}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void handleDrop(file);
              }}
            />
          </label>
        </div>
        {/* R-F23 — the standing pre-gate disclosure, which the panel showed
            ONCE in a section header above every print. Its home is here now,
            and this is a better home than the old one: it sits directly above
            the sheet and the accept controls it is talking about, once per
            expansion, so the desk reads it at the moment it is deciding
            whether to trust a machine-read number. Same caption treatment as
            the panel's (`text-ink-faint`, 11px) — a standing condition of the
            build, not an alarm. */}
        <p className="basis-full text-ink-faint" style={{ fontSize: "11px" }}>
          {PRE_GATE_DISCLOSURE}
        </p>
      </div>

      <p className="text-[11px] font-mono text-ink-faint mb-3">
        {ladder || "awaiting first poll — sources reset after a server restart"}
        {print.coverage.length > 0 && (
          <span className="block mt-0.5 text-ink-faint italic" style={{ fontSize: "10px" }}>
            {print.coverage.join(" · ")}
          </span>
        )}
      </p>

      <p className="text-[12px] font-mono text-ink-dim">
        {windowText(print.effectiveWindow ?? null, Date.now())}
        {goLine ? ` · ${goLine}` : ""}
      </p>

      {actionError && <p className="text-[12px] text-down mb-2">{actionError}</p>}
      {actionNote && !actionError && <p className="text-[12px] text-up mb-2">{actionNote}</p>}

      <div className="mt-2 mb-3 space-y-1.5">
        <IrPageField symbol={print.symbol} onNote={note} onError={fail} />
        <PrepareStatus steps={prepareSteps} />
        {/* Which document each road actually produced. The status route has
            sent this since slice B and nothing consumed it: "EDGAR: ok" in the
            ladder above says a road ran, not WHICH filing it handed over. */}
        {roadLines.length > 0 && (
          <p className="text-[11px] font-mono text-ink-faint">
            {roadLines.map((l) => (
              <span key={l} className="block">
                {l}
              </span>
            ))}
          </p>
        )}
      </div>

      <ScrollFade>
        <table className="w-full text-[13px]" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr className="text-ink-faint font-mono uppercase" style={{ fontSize: "10px", letterSpacing: "0.14em" }}>
              <th className="text-left py-1.5 pr-3">Metric</th>
              <th className="text-left py-1.5 pr-3">Bogey</th>
              <th className="text-left py-1.5 pr-3">Actual</th>
              <th className="text-right py-1.5 pr-3">Δ vs bogey</th>
              <th className="text-left py-1.5 pr-3">State</th>
              <th className="text-left py-1.5">Detail</th>
            </tr>
          </thead>
          <tbody>
            {print.lines.length === 0 && (
              <tr className="border-t border-edge">
                <td colSpan={6} className="py-2 text-[11px] text-ink-faint italic">
                  No sheet lines compiled yet — the bogeys on the worksheet define them.
                </td>
              </tr>
            )}
            {print.lines.map((line) => (
              <LineRow
                key={line.metric_id}
                line={line}
                documents={print.documents}
                onUnaccept={() => unaccept(line.metric_id)}
                unaccepting={unacceptingId === line.metric_id}
                onAccept={() => acceptLine(line.metric_id)}
                accepting={acceptingId === line.metric_id}
                onAcceptCandidate={(docId, representation) =>
                  acceptCandidate(line.metric_id, docId, representation)
                }
                acceptingCandidateKey={acceptingCandidateKey}
                noEventId={noEventId}
              />
            ))}
          </tbody>
        </table>
      </ScrollFade>
      <FirstPassRead eventId={print.eventId} read={print.read ?? null} activeRead={print.activeRead ?? null} lastAttempt={print.lastAttempt ?? null} callouts={print.callouts ?? []} onChanged={onChanged} />

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <button
          type="button"
          onClick={acceptAllAgreed}
          disabled={acceptingAll || agreedIds.length === 0 || noEventId}
          title={
            agreedIds.length === 0
              ? "No lines are in the agreed state yet."
              : `Accept ${agreedIds.length} agreed line(s)`
          }
          className="relative text-[13px] font-mono text-ink-dim hover:text-ink border border-edge rounded px-2.5 py-1 disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
        >
          {acceptingAll ? "Accepting…" : `Accept all agreed (${agreedIds.length})`}
        </button>
        {/* Promote lives in the outputs row once slice E is on the payload.
            Until then that row renders nothing at all (contract §2), and the
            desk would otherwise lose the single most important button on the
            sheet — so the SAME control renders here instead. Exactly one of
            the two is ever on screen. */}
        {!print.outputs && <PromoteButton promote={promoteControl} />}
      </div>

      <PrintOutputs
        printId={print.printId}
        outputs={print.outputs}
        onChanged={onChanged}
        promote={promoteControl}
      />
    </div>
  );
}
