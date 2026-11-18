"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import apiFetch from "@/lib/http/apiFetch";
import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import { currentMondayET } from "@/lib/ui/current-monday";
import { describeUploadOutcome, type UploadResponse } from "@/app/dashboard/today/BogeysUploadButton";

/**
 * Hands one file to the earnings-bogeys reader and shows what it filed.
 */
export function ReadAsBogeysButton({ file }: { file: File }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<{ text: string; tone: "plain" | "warn" }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setLines(null);
    try {
      const weekOf = currentMondayET();
      const fd = new FormData();
      fd.append("file", file);
      fd.append("weekOf", weekOf);
      fd.append("sourceLabel", `${file.name.replace(/\.[^.]+$/, "")} ${weekOf}`);
      const res = await apiFetch("/api/earnings/bogeys/upload", { method: "POST", body: fd });
      const r = await readMutationResult<UploadResponse>(res);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setLines(describeUploadOutcome(r.data, file.name));
      router.refresh();
    } catch {
      setError(networkFailureMessage("read that file as earnings bogeys"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="text-gold-ink enabled:hover:underline font-medium disabled:opacity-50"
      >
        {busy ? "Reading…" : "Read it as earnings bogeys"}
      </button>
      {lines && (
        <span className="text-xs font-mono text-ink-faint">
          {lines.map((line, i) => (
            <span key={line.text} className={line.tone === "warn" ? "text-down" : undefined}>
              {i > 0 ? " · " : ""}
              {line.text}
            </span>
          ))}
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-down">
          {error}
        </span>
      )}
    </div>
  );
}
