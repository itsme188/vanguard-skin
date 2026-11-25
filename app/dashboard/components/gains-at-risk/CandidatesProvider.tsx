"use client";

import { createContext, useCallback, useContext, useMemo, useReducer, useRef, type ReactNode } from "react";
import {
  candidatesReducer,
  initialCandidatesState,
  type CandidatesAction,
  type CandidatesState,
} from "@/lib/analysis/gains-at-risk-candidates-view";

/**
 * The candidate table's state (F1): page state only, never stored.
 *
 * Rendered by GainsAtRiskSection beside TrialPositionsProvider, AROUND the
 * keyed view and NOT keyed itself: a scope pill remounts the view, and the
 * rows, quotes and solved entries survive it; the section then clears their
 * book figures and recomputes for the new scope. A reload or leaving the page
 * loses everything.
 */
export interface CandidatesValue {
  /** False only outside a provider: the page then offers no candidate section. */
  available: boolean;
  state: CandidatesState;
  /**
   * Applies the action and reports whether the reducer accepted it (the state
   * changed). A caller sends a broker request only after an accepted request
   * action, so a refused dispatch (a closed section, a refresh naming a removed
   * row) sends nothing (S6 fix 1, item 7).
   */
  act: (action: CandidatesAction) => boolean;
  /** The state with every action applied so far, ahead of the next render. */
  current: () => CandidatesState;
  /** A request id never handed out before on this page (chain requests and quote pulls, D8). */
  nextId: () => number;
}

const NONE: CandidatesValue = {
  available: false,
  state: initialCandidatesState(),
  act: () => false,
  current: initialCandidatesState,
  nextId: () => 0,
};

const CandidatesContext = createContext<CandidatesValue>(NONE);

export function CandidatesProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(candidatesReducer, undefined, initialCandidatesState);
  // The same pure reducer run eagerly, so every caller (an old section still
  // answering after a scope remount included) reads one current state.
  const latest = useRef<CandidatesState | null>(null);
  const act = useCallback((action: CandidatesAction) => {
    const before = latest.current ?? initialCandidatesState();
    const after = candidatesReducer(before, action);
    latest.current = after;
    dispatch(action);
    return after !== before;
  }, []);
  const current = useCallback(() => latest.current ?? initialCandidatesState(), []);
  const counter = useRef(0);
  const nextId = useCallback(() => {
    counter.current += 1;
    return counter.current;
  }, []);
  const value = useMemo<CandidatesValue>(() => ({ available: true, state, act, current, nextId }), [state, act, current, nextId]);
  return <CandidatesContext.Provider value={value}>{children}</CandidatesContext.Provider>;
}

export function useCandidates(): CandidatesValue {
  return useContext(CandidatesContext);
}
