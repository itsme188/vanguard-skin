"use client";

import { useState, useEffect } from "react";
import { useElectron } from "@/lib/hooks/useElectron";

/** Shows app version — uses Electron IPC if available, otherwise falls back to v2.0. */
export function AppVersion() {
  const { isElectron, api } = useElectron();
  const [version, setVersion] = useState("2.0");

  useEffect(() => {
    if (api) {
      api.getAppVersion().then((v) => setVersion(v));
    }
  }, [api]);

  return (
    <span className="text-[11px] text-ink-faint font-mono" title={isElectron ? "Electron app" : "Browser"}>
      v{version}
    </span>
  );
}
