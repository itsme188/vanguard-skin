"use client";

import { useEffect, useState } from "react";
import {
  isAnalysisPath,
  readRememberedScope,
  rememberScope,
} from "@/lib/ui/analysis-scope-memory";

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// Writes the Analysis scope to sessionStorage while the user is on Analysis
// with a ?scope=, and returns the remembered scope for links elsewhere.
// Storage is touched ONLY inside the effect: the first render returns null
// (same as the server), so there is no hydration mismatch.
export function useRememberedAnalysisScope(
  pathname: string,
  currentScope: string | null,
): string | null {
  const [remembered, setRemembered] = useState<string | null>(null);

  useEffect(() => {
    const store = sessionStore();
    if (isAnalysisPath(pathname) && currentScope) {
      rememberScope(store, currentScope);
    }
    setRemembered(readRememberedScope(store));
  }, [pathname, currentScope]);

  return remembered;
}
