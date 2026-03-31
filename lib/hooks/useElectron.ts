"use client";

import { useState, useEffect } from "react";

/**
 * SSR-safe hook to detect Electron environment and access IPC API.
 * Returns { isElectron: false, api: null } during SSR and in browser.
 */
export function useElectron() {
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    setIsElectron(!!window.electronAPI?.isElectron);
  }, []);

  return {
    isElectron,
    api: isElectron ? window.electronAPI! : null,
  };
}
