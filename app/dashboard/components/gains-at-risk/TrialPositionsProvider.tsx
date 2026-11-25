"use client";

import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";
import {
  emptyTrialList,
  trialListReducer,
  type TrialPositionState,
} from "@/lib/analysis/gains-at-risk-trial-view";

/**
 * The page's trial positions (R5): page state only, never stored.
 *
 * Rendered by GainsAtRiskSection AROUND the keyed view and NOT keyed itself:
 * a scope pill is a soft navigation, so this provider keeps its list while
 * the view below it remounts with the new scope. A reload or leaving the
 * page loses the list. It holds nothing else.
 */
export interface TrialPositionsValue {
  /** False only outside a provider: the page then offers no trial positions. */
  available: boolean;
  list: TrialPositionState[];
  /** Bumped by every add, edit and remove: the view asks again on each. */
  version: number;
  add: (trial: TrialPositionState) => void;
  edit: (id: string, trial: TrialPositionState) => void;
  remove: (id: string) => void;
}

const NONE: TrialPositionsValue = {
  available: false,
  list: [],
  version: 0,
  add: () => {},
  edit: () => {},
  remove: () => {},
};

const TrialPositionsContext = createContext<TrialPositionsValue>(NONE);

export function TrialPositionsProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(trialListReducer, undefined, emptyTrialList);
  const value = useMemo<TrialPositionsValue>(
    () => ({
      available: true,
      list: state.list,
      version: state.version,
      add: (trial) => dispatch({ type: "add", trial }),
      edit: (id, trial) => dispatch({ type: "replace", id, trial }),
      remove: (id) => dispatch({ type: "remove", id }),
    }),
    [state],
  );
  return <TrialPositionsContext.Provider value={value}>{children}</TrialPositionsContext.Provider>;
}

export function useTrialPositions(): TrialPositionsValue {
  return useContext(TrialPositionsContext);
}
