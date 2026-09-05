"use client";

/**
 * One row of the live print sheet — moved VERBATIM from `PrintWatchPanel.tsx`
 * (slice F, task 8) with three changes:
 *
 *   1. The delta cell renders inside `<PrivateText>` whenever the line carries
 *      a bogey (M-F19, standing user ruling). The bogey beside it is the
 *      desk's own curated number and is masked; a delta against a masked bogey
 *      hands the bogey back by division, so masking one and not the other was
 *      a leak, not a style choice. The cell's green/red goes neutral on the
 *      same condition (review M-1) — otherwise the mask hid the magnitude and
 *      the colour still announced beat-or-miss.
 *   2. A `retired` line (M-F17) renders dimmed and offers no accept control —
 *      it is the audit trail of a definition that no longer applies, not a
 *      measurement in progress. (`canAcceptLine` already refuses it; the
 *      explicit guard is belt-and-braces and is pinned by a test.)
 *   3. Its helpers come from `./helpers` rather than the panel's file scope.
 */

import { useState } from "react";
import { Chip } from "../../components/Chip";
import { PrivateText } from "@/lib/privacy/components";
import { usePrivacy } from "@/lib/privacy/context";
import {
  acceptableRivals,
  basisNote,
  candidateKey,
  candidateSourceLabel,
  canAcceptLine,
  deltaPct,
  formatContractRange,
  formatContractValue,
  presentState,
} from "./helpers";
import type { PrintWatchLine, TaggedCandidate } from "@/lib/print-watch/types";

export default function LineRow({
  line,
  documents,
  onUnaccept,
  unaccepting,
  onAccept,
  accepting,
  onAcceptCandidate,
  acceptingCandidateKey,
  noEventId,
}: {
  line: PrintWatchLine;
  documents: Record<number, string> | undefined;
  onUnaccept: () => void;
  unaccepting: boolean;
  onAccept: () => void;
  accepting: boolean;
  onAcceptCandidate: (docId: number, representation: string) => void;
  acceptingCandidateKey: string | null;
  noEventId: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { isPrivate } = usePrivacy();
  const presentation = presentState(line);
  const basis = basisNote(line.contract);
  const delta = deltaPct(line.expected?.value ?? null, line.value);
  const isFlash = line.state === "flash";
  // M-F17: a retired row is the record of a definition that no longer
  // applies. It stays on the sheet as evidence, dimmed, with nothing to
  // accept.
  const isRetired = line.state === "retired";
  /**
   * The delta text is masked whenever the bogey is (M-F19) — but the cell's
   * green/red also came off `delta.sign`, so a masked Δ still said "beat" or
   * "miss" in colour (review M-1). That is one bit of the masked bogey
   * surviving the mask, and it is the "never colour alone" rule in reverse:
   * the colour was carrying information the text refused to. With privacy on
   * and a bogey present, the cell goes neutral and says nothing.
   */
  const maskDelta = isPrivate && line.expected != null;

  let candidates: TaggedCandidate[] = [];
  if (line.state === "conflict") {
    try {
      const parsed = JSON.parse(line.candidates_json) as unknown;
      if (Array.isArray(parsed)) candidates = parsed as TaggedCandidate[];
    } catch {
      candidates = [];
    }
  }

  // Which of the rendered rivals can actually be locked in — one control per
  // distinct figure, flash / not-disclosed entries stay evidence-only.
  const rivalKeys = new Set(acceptableRivals(line).map(candidateKey));

  return (
    <>
      <tr className={`border-t border-edge ${isFlash ? "border-dashed" : ""} ${isRetired ? "opacity-60" : ""}`}>
        <td className="py-2 pr-3 align-top">
          <span className="text-ink">{line.contract.label}</span>
          {basis && <span className="ml-1.5 text-[10px] text-ink-faint uppercase">{basis}</span>}
          {line.contract.segment && (
            <span className="block text-[10px] text-ink-faint">{line.contract.segment}</span>
          )}
        </td>
        <td className="py-2 pr-3 align-top font-mono tabular-nums">
          <PrivateText className="text-ink-dim">
            {line.expected
              ? [
                  formatContractRange(line.contract, line.expected.value, line.expected.value_high),
                  line.expected.whisper !== null
                    ? `whisper ${formatContractValue(line.contract, line.expected.whisper)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "—"}
          </PrivateText>
        </td>
        <td className="py-2 pr-3 align-top font-mono tabular-nums text-ink">
          {formatContractRange(line.contract, line.value, line.value_high)}
        </td>
        <td
          className={`py-2 pr-3 align-top text-right font-mono tabular-nums ${
            delta === null
              ? "text-ink-faint"
              : maskDelta
                ? "text-ink-dim"
                : delta.sign === 1
                  ? "text-up"
                  : delta.sign === -1
                    ? "text-down"
                    : "text-ink-dim"
          }`}
        >
          {/* M-F19: the bogey cell above is the desk's own curated number and
              renders masked. A visible delta against a masked bogey gives the
              bogey back by division, so the delta is masked on exactly the
              same condition. A line with NO bogey has nothing to protect. */}
          {line.expected ? <PrivateText>{delta ? delta.label : "—"}</PrivateText> : delta ? delta.label : "—"}
        </td>
        <td className="py-2 pr-3 align-top">
          <Chip tone={presentation.tone} size="xs">
            <span className="mr-1">{presentation.icon}</span>
            {presentation.text}
          </Chip>
          {/* Accept / unaccept are the SAME cell and mutually exclusive: one
              small always-visible text button under the state chip (never a
              hover-only affordance — that is a tap-trap on touch). */}
          {isRetired ? null : line.state === "accepted" ? (
            <button
              type="button"
              onClick={onUnaccept}
              disabled={unaccepting}
              className="relative block mt-1 text-[11px] text-ink-faint hover:text-down disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
            >
              {unaccepting ? "Un-accepting…" : "unaccept"}
            </button>
          ) : canAcceptLine(line) ? (
            <button
              type="button"
              onClick={onAccept}
              disabled={accepting || noEventId}
              title={
                noEventId
                  ? "This print has no event reference from the server — cannot accept."
                  : `Lock in the reported ${line.contract.label} as verified`
              }
              className="relative block mt-1 text-[11px] text-ink-dim hover:text-up disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
            >
              {accepting ? "Accepting…" : "accept"}
            </button>
          ) : null}
        </td>
        <td className="py-2 align-top">
          {(line.snippet || candidates.length > 0) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="relative text-[11px] text-ink-faint hover:text-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
            >
              {/* On a conflict row the expander is the ONLY road to the
                  per-candidate accept controls, so it names what is behind it
                  rather than reading like an optional snippet. */}
              {expanded ? "hide ▲" : rivalKeys.size > 0 ? `${rivalKeys.size} rival figures ▾` : "snippet ▾"}
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className={`border-t-0 ${isFlash ? "border-dashed" : ""}`}>
          <td colSpan={6} className="pb-2.5 pr-3">
            {line.state === "conflict" && candidates.length > 0 ? (
              <ul className="space-y-1">
                {candidates.map((c, i) => {
                  // Per-candidate accept (QA: unaccept-after-supersede). A
                  // conflict line has no number of its own, so the desk locks
                  // in the reading it verified BY DOCUMENT — and the rivals it
                  // rejected stay listed right here as the audit trail.
                  const key = candidateKey(c);
                  const inFlight = `${line.metric_id}|${c.doc_id}|${c.representation}`;
                  return (
                    <li key={`${c.doc_id}-${c.representation}-${i}`} className="text-[11px] text-ink-dim font-mono">
                      <span className="text-ink-faint">{candidateSourceLabel(c, documents)}:</span>{" "}
                      {c.not_disclosed
                        ? "not disclosed"
                        : formatContractRange(line.contract, c.value, c.value_high)}
                      {c.snippet && <span className="text-ink-faint italic"> — “{c.snippet}”</span>}
                      {rivalKeys.has(key) && (
                        <button
                          type="button"
                          onClick={() => onAcceptCandidate(c.doc_id, c.representation)}
                          disabled={acceptingCandidateKey !== null || noEventId}
                          title={
                            noEventId
                              ? "This print has no event reference from the server — cannot accept."
                              : `Lock in this reading of ${line.contract.label} as the verified figure`
                          }
                          className="relative ml-2 text-[11px] text-ink-dim hover:text-up disabled:opacity-50 underline decoration-dotted underline-offset-2 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
                        >
                          {acceptingCandidateKey === inFlight ? "Accepting…" : "accept this"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : line.snippet ? (
              <p className="text-[11px] text-ink-faint italic">“{line.snippet}”</p>
            ) : (
              <p className="text-[11px] text-ink-faint italic">No snippet captured for this line yet.</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
