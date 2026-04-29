"use client";

import { useState, useEffect } from "react";

const LARGE_DESKTOP_QUERY = "(min-width: 1280px)";

/**
 * SSR-safe hook for the xl: breakpoint (≥1280px). Used by the chat right-rail
 * to decide between always-visible (xl) and toggle-drawer (below xl).
 */
export function useIsLargeDesktop(): boolean {
  const [isLargeDesktop, setIsLargeDesktop] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(LARGE_DESKTOP_QUERY);
    setIsLargeDesktop(mql.matches);

    function onChange(e: MediaQueryListEvent) {
      setIsLargeDesktop(e.matches);
    }
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isLargeDesktop;
}
