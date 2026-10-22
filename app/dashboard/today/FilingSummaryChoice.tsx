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
 * Every outcome reaches the user as a toast; a refused or failed change puts
 * the select back.
 */

import { useEffect, useState } from "react";
import apiFetch from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
import { choiceLabel } from "@/lib/filing-summary/choice";
import type { SummaryChoice } from "@/lib/filing-summary/types";
import type { ChoiceOption, FullView } from "@/lib/filing-summary/view";
import { useToast } from "../components/Toast";
import { choiceValue, optionText } from "./filing-summary-text";

interface ChoiceState {
  current: SummaryChoice;
  locked: boolean;
  options: ChoiceOption[];
}

export default function FilingSummaryChoice({ eventId }: { eventId: number }) {
  const { toast } = useToast();
  const [state, setState] = useState<ChoiceState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/filing-summary/${eventId}`);
        const r = await readMutationResult<{ data?: FullView }>(res);
        if (cancelled) return;
        if (!r.ok || !r.data.data) {
          setLoadError(r.ok ? "the server sent no choice." : r.message);
          return;
        }
        const c = r.data.data.choice;
        setState({ current: c.current, locked: c.locked, options: c.options });
        setLoadError(null);
      } catch {
        if (!cancelled) setLoadError(networkFailureMessage("read the summary model"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

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
        className="text-[10px] font-mono text-ink-faint [overflow-wrap:anywhere]"
        title={loadError ? `Couldn't read the summary model: ${loadError}` : undefined}
      >
        {loadError ? "Filing summary: model not read" : "Filing summary: …"}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 flex-wrap min-w-0 max-w-full">
      <label className="text-[10px] font-mono text-ink-dim whitespace-nowrap" htmlFor={`filing-summary-choice-${eventId}`}>
        Filing summary
      </label>
      <select
        id={`filing-summary-choice-${eventId}`}
        value={choiceValue(state.current)}
        onChange={(e) => void change(e.target.value)}
        disabled={state.locked || saving}
        title={state.locked ? "Locked: the summary has started. Re-run from the full summary to change the model." : "The model that writes this print's filing summary"}
        className="text-[10px] font-mono text-ink bg-raised border border-edge rounded px-1 py-0.5 max-w-full min-w-0 disabled:opacity-70 pointer-coarse:min-h-6"
      >
        {state.options.map((o) => (
          <option key={choiceValue(o.choice)} value={choiceValue(o.choice)}>
            {optionText(o)}
          </option>
        ))}
      </select>
      {state.locked && <span className="text-[10px] font-mono text-ink-dim whitespace-nowrap">locked — re-run to change</span>}
    </span>
  );
}
