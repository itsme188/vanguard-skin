"use client";

import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { GainsControls } from "@/lib/analysis/gains-at-risk-view";

/**
 * The page's driver choice (Gains at risk step 3): page state only, never
 * stored. Rendered by GainsAtRiskSection AROUND the scope-keyed view and NOT
 * keyed itself, like the trial list, so a scope pill keeps the driver while
 * the view remounts. The view reads it once when it mounts and writes it on
 * every change; nothing renders from it, so it is a ref, not state.
 */
export type DriverChoiceMemory = Pick<GainsControls, "driver" | "driverSymbol">;

export interface DriverChoiceValue {
  get: () => DriverChoiceMemory | null;
  set: (choice: DriverChoiceMemory) => void;
}

const NONE: DriverChoiceValue = { get: () => null, set: () => {} };

const DriverChoiceContext = createContext<DriverChoiceValue>(NONE);

export function DriverChoiceProvider({ children }: { children: ReactNode }) {
  const ref = useRef<DriverChoiceMemory | null>(null);
  const value = useMemo<DriverChoiceValue>(
    () => ({
      get: () => ref.current,
      set: (choice) => {
        ref.current = choice;
      },
    }),
    [],
  );
  return <DriverChoiceContext.Provider value={value}>{children}</DriverChoiceContext.Provider>;
}

export function useDriverChoice(): DriverChoiceValue {
  return useContext(DriverChoiceContext);
}
