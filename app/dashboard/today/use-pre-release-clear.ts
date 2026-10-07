"use client";

import { useEffect, useState } from "react";

/**
 * True while a server-decided pre-release state still holds. `clearsAtMs` is
 * the epoch ms the server computed (preReleaseClearsAtMs); one timer flips the
 * result at that instant so the chip clears without a reload. Null = no timer.
 * The cleared marker is keyed to the deadline it fired for, so a new deadline
 * (a re-rendered row) starts live again.
 */
export function usePreReleaseActive(initiallyPreRelease: boolean, clearsAtMs: number | null): boolean {
  const [clearedFor, setClearedFor] = useState<number | null>(null);
  useEffect(() => {
    if (clearsAtMs == null) return;
    const wait = clearsAtMs - Date.now();
    if (wait <= 0) {
      setClearedFor(clearsAtMs);
      return;
    }
    const id = setTimeout(() => setClearedFor(clearsAtMs), wait);
    return () => clearTimeout(id);
  }, [clearsAtMs]);
  return initiallyPreRelease && !(clearsAtMs != null && clearedFor === clearsAtMs);
}
