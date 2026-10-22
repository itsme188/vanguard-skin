"use client";

/**
 * The per-print model choice for the filing summary, beside the armed
 * worksheet chip in the Earnings Hub (spec §1, owner decisions).
 *
 * A native `<select>` (no caret affordance, project rule) with the five
 * picker choices, each suffixed by the model its family means today
 * ("Fable · high — now 5.1"). Changing it stores the choice for this print
 * only; the choice locks when the summary starts, after which a different
 * model means a re-run from the full summary page.
 *
 * The Hub renders every row twice (DesktopRow and MobileCard; CSS hides one),
 * so this component is mounted in both twins. Only the twin the desk can see
 * reads `GET /api/filing-summary?eventIds=…` (the light PanelView: choice,
 * lock and options), measured with `offsetParent` the way LivePrintSlot does.
 * The select id comes from `useId`, so the two twins never share one.
 *
 * The closed select shows the choice label only ("Opus · high"): the full
 * option text ("Opus · high — now 5.5") was cut off in the narrow Hub row
 * (browser pass, 2026-10-22). A transparent native select sits over that
 * label, so the open list still shows each option with its now-label, and the
 * wrapper's title carries the current one. A print from an earlier day with no
 * summary state (`pastWithoutSummary`) gets a disabled select: nothing will run.
 *
 * Every outcome reaches the user as a toast; a refused or failed change puts
 * the select back.
 */

import { useEffect, useId, useRef, useState } from "react";
import apiFetch from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
import { choiceLabel } from "@/lib/filing-summary/choice";
import type { SummaryChoice } from "@/lib/filing-summary/types";
import type { ChoiceOption, PanelView } from "@/lib/filing-summary/view";
import { useToast } from "../components/Toast";
import { choiceValue, optionText } from "./filing-summary-text";

interface ChoiceState {
  current: SummaryChoice;
  locked: boolean;
  /** An earlier day's print with no summary state: nothing will ever run. */
  past: boolean;
  options: ChoiceOption[];
}

export default function FilingSummaryChoice({ eventId }: { eventId: number }) {
  const { toast } = useToast();
  const selectId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const [isVisibleTwin, setIsVisibleTwin] = useState(false);
  const [state, setState] = useState<ChoiceState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Which twin is on screen. `offsetParent` is null whenever an ancestor is
  // display:none. Re-measured on resize and on the chat rail attribute, which
  // swaps the twins without a page load (same as LivePrintSlot).
  useEffect(() => {
    const measure = () => {
      const visible = rootRef.current !== null && rootRef.current.offsetParent !== null;
      setIsVisibleTwin((was) => (was === visible ? was : visible));
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = new MutationObserver(measure);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-chat-rail"] });
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, []);

  // Read the choice once the twin is visible. A twin that becomes visible
  // later (rail toggle, resize) reads then; the hidden twin never reads.
  useEffect(() => {
    if (!isVisibleTwin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/filing-summary?eventIds=${eventId}`);
        const r = await readMutationResult<{ data?: Record<string, PanelView> }>(res);
        if (cancelled) return;
        const v = r.ok ? r.data.data?.[String(eventId)] : undefined;
        if (!v) {
          setLoadError(r.ok ? "the server sent no choice." : r.message);
          return;
        }
        setState({ current: v.choice, locked: v.locked, past: v.pastWithoutSummary, options: v.choiceOptions });
        setLoadError(null);
      } catch {
        if (!cancelled) setLoadError(networkFailureMessage("read the summary model"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, isVisibleTwin]);

  async function change(value: string): Promise<void> {
    if (!state || saving) return;
    const picked = state.options.find((o) => choiceValue(o.choice) === value);
    if (!picked) return;
    const previous = state.current;
    if (choiceValue(previous) === value) return;
    // Optimistic: show the new choice now, put the old one back on any failure.
    setState({ ...state, current: picked.choice });
    setSaving(true);
    try {
      const res = await apiFetch("/api/filing-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, action: "set_choice", ...picked.choice }),
      });
      const r = await readMutationResult(res);
      if (!r.ok) {
        if (r.status === 409) {
          setState((s) => (s ? { ...s, current: previous, locked: true } : s));
          toast(
            `The filing summary has started, so its model is locked at ${choiceLabel(previous)}. Re-run from the full summary to use another.`,
            "error",
          );
          return;
        }
        setState((s) => (s ? { ...s, current: previous } : s));
        toast(`Couldn't change the summary model: ${r.message} It stays ${choiceLabel(previous)}.`, "error");
        return;
      }
      toast(`Filing summary for this print: ${optionText(picked)}.`, "success");
    } catch {
      setState((s) => (s ? { ...s, current: previous } : s));
      toast(`${networkFailureMessage("change the summary model")} It stays ${choiceLabel(previous)}.`, "error");
    } finally {
      setSaving(false);
    }
  }

  if (!state) {
    return (
      <span
        ref={rootRef}
        className="text-[10px] font-mono text-ink-faint [overflow-wrap:anywhere]"
        title={loadError ? `Couldn't read the summary model: ${loadError}` : undefined}
      >
        {loadError ? "Filing summary: model not read" : "Filing summary: …"}
      </span>
    );
  }

  const currentOption = state.options.find((o) => choiceValue(o.choice) === choiceValue(state.current));
  const currentText = currentOption ? optionText(currentOption) : choiceLabel(state.current);
  const disabled = state.locked || state.past || saving;
  const selectTitle = state.past
    ? `No filing summary for this print: it is from an earlier day. ${currentText}`
    : state.locked
      ? `Locked at ${currentText}: the summary has started. Re-run from the full summary to change the model.`
      : `The model that writes this print's filing summary: ${currentText}`;

  return (
    <span ref={rootRef} className="inline-flex items-center gap-1 flex-wrap min-w-0 max-w-full">
      <label className="text-[10px] font-mono text-ink-dim whitespace-nowrap" htmlFor={selectId}>
        Filing summary
      </label>
      <span
        title={selectTitle}
        className={`relative inline-flex shrink-0 items-center whitespace-nowrap text-[10px] font-mono text-ink bg-raised border border-edge rounded px-1 py-0.5 focus-within:outline focus-within:outline-ink pointer-coarse:min-h-6 ${
          disabled ? "opacity-70" : ""
        }`}
      >
        <span aria-hidden="true">{choiceLabel(state.current)}</span>
        <select
          id={selectId}
          value={choiceValue(state.current)}
          onChange={(e) => void change(e.target.value)}
          disabled={disabled}
          title={selectTitle}
          className="absolute inset-0 h-full w-full opacity-0 cursor-pointer disabled:cursor-default text-[10px] font-mono"
        >
          {state.options.map((o) => (
            <option key={choiceValue(o.choice)} value={choiceValue(o.choice)}>
              {optionText(o)}
            </option>
          ))}
        </select>
      </span>
      {state.locked && <span className="text-[10px] font-mono text-ink-dim whitespace-nowrap">locked — re-run to change</span>}
    </span>
  );
}
