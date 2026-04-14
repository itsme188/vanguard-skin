"use client";

import { useState, useEffect } from "react";

const MOBILE_QUERY = "(max-width: 767px)";

/**
 * SSR-safe hook to detect mobile viewport (below md: breakpoint).
 * Returns false during SSR, updates on resize.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    setIsMobile(mql.matches);

    function onChange(e: MediaQueryListEvent) {
      setIsMobile(e.matches);
    }
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
