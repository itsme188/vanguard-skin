"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  weekOf: string;
}

interface UploadResponse {
  symbolsExtracted?: number;
  eventsMatched?: number;
  eventsUnmatched?: string[];
  r2Key?: string | null;
  results?: Array<{ symbol: string; eventId: number | null }>;
  error?: string;
}

/**
 * Drop-zone / file-picker for multi-symbol earnings bogeys PDFs (e.g.,
 * TMT Breakout's weekly preview page). Posts to
 * /api/earnings/bogeys/upload, which:
 *   1. Archives to R2.
 *   2. Sends to Claude for per-symbol extraction.
 *   3. Fans out to matching calendar_events for the visible week.
 *
 * Renders inline summary on success: "Matched 4 of 5 symbols (TER unmatched)".
 */
export function BogeysUploadButton({ weekOf }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("weekOf", weekOf);
      fd.append("sourceLabel", `${file.name.replace(/\.pdf$/i, "")} ${weekOf}`);
      const res = await fetch("/api/earnings/bogeys/upload", {
        method: "POST",
        body: fd,
      });
      const data = (await res.json()) as UploadResponse;
      if (!res.ok) {
        setError(data.error ?? `Server returned ${res.status}`);
        return;
      }
      setResult(data);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-[14px]">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="text-gold-ink hover:text-gold/80 font-medium disabled:opacity-50"
      >
        {uploading ? "Uploading…" : "+ Upload bogeys PDF"}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          // Reset so re-selecting the same file still triggers onChange.
          e.target.value = "";
        }}
      />
      {result && (
        <span className="text-[11px] font-mono text-ink-faint">
          {result.eventsMatched}/{result.symbolsExtracted} matched
          {result.eventsUnmatched && result.eventsUnmatched.length > 0 && (
            <span className="text-down">
              {" "}
              · {result.eventsUnmatched.join(", ")} unmatched
            </span>
          )}
        </span>
      )}
      {error && <span className="text-[11px] text-down">{error}</span>}
    </div>
  );
}
