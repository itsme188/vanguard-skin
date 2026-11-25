"use client";

import { createContext, useCallback, useContext, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from "react";
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
  dispatch: Dispatch<CandidatesAction>;
  /** A request id never handed out before on this page (chain requests and quote pulls, D8). */
  nextId: () => number;
}

const NONE: CandidatesValue = {
  available: false,
  state: initialCandidatesState(),
  dispatch: () => {},
  nextId: () => 0,
};

const CandidatesContext = createContext<CandidatesValue>(NONE);

export function CandidatesProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(candidatesReducer, undefined, initialCandidatesState);
  const counter = useRef(0);
  const nextId = useCallback(() => {
    counter.current += 1;
    return counter.current;
  }, []);
  const value = useMemo<CandidatesValue>(() => ({ available: true, state, dispatch, nextId }), [state, nextId]);
  return <CandidatesContext.Provider value={value}>{children}</CandidatesContext.Provider>;
}

export function useCandidates(): CandidatesValue {
  return useContext(CandidatesContext);
}
