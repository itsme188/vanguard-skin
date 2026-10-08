"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import apiFetch from "@/lib/http/apiFetch";

/** One earnings row the hub has on screen. */
export interface ShownEvent {
  id: number;
  symbol: string | null;
  eventDate: string;
}

interface Props {
  weekOf: string;
  /** The rows the hub shows, so a match that landed elsewhere can say so. */
  shownEvents?: ShownEvent[];
}

export interface UploadResponse {
  symbolsExtracted?: number;
  eventsMatched?: number;
  eventsUnmatched?: string[];
  r2Key?: string | null;
  /** `bogeyId` 0 = matched, but the sheet had no figure for it and nothing was
   *  stored. `eventDate` is shown when the route supplies it. `offWeek` is set
   *  here, by `locateInShownWeek`, never by the route. */
  results?: Array<{
    symbol: string;
    eventId: number | null;
    bogeyId?: number;
    eventDate?: string | null;
    offWeek?: boolean;
  }>;
  error?: string;
}

export interface UploadOutcomeLine {
  text: string;
  tone: "plain" | "warn";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-07" -> "Sep 7". Read off the string, so no timezone can move it. */
function shortDate(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : null;
}

/**
 * What the upload did, in words (qa: upload match-success-unnamed and
 * bare-zero-matched). A bare "1/1 matched" names nothing the user can check,
 * and "0/0 matched" does not say whether anything was read at all. Pure, so
 * it is tested directly (the repo has no DOM harness).
 */
export function describeUploadOutcome(result: UploadResponse, fileName: string): UploadOutcomeLine[] {
  const extracted = result.symbolsExtracted ?? 0;
  if (extracted === 0) {
    return [{ text: `No tickers found in ${fileName} — nothing was stored.`, tone: "warn" }];
  }
  const lines: UploadOutcomeLine[] = [
    { text: `${result.eventsMatched ?? 0}/${extracted} matched`, tone: "plain" },
  ];
  const matched = (result.results ?? []).filter((r) => r.eventId != null);
  const name = (r: { symbol: string; eventDate?: string | null; offWeek?: boolean }) => {
    const detail = [shortDate(r.eventDate), r.offWeek ? "not in the week shown under that symbol" : null]
      .filter(Boolean)
      .join(", ");
    return detail ? `${r.symbol} (${detail})` : r.symbol;
  };
  const stored = matched.filter((r) => r.bogeyId !== 0);
  const empty = matched.filter((r) => r.bogeyId === 0);
  if (stored.length > 0) {
    lines.push({ text: `bogeys saved for ${stored.map(name).join(", ")}`, tone: "plain" });
  }
  if (empty.length > 0) {
    lines.push({
      text: `no figures found for ${empty.map(name).join(", ")} — nothing stored`,
      tone: "warn",
    });
  }
  if (result.eventsUnmatched && result.eventsUnmatched.length > 0) {
    lines.push({ text: `${result.eventsUnmatched.join(", ")} unmatched`, tone: "warn" });
  }
  return lines;
}

/**
 * Marks where each match landed relative to the rows the hub shows (qa:
 * match-success-unnamed-off-week-invisible). The route matches a wider window
 * than the hub renders, so a match can land on a row that is not on screen and
 * the page looks unchanged. A row is found by id, then by symbol (the hub
 * folds twin rows, so the id on screen can differ); a found row lends its
 * date when the route sent none. With no rows handed in, nothing is claimed.
 */
export function locateInShownWeek(result: UploadResponse, shownEvents?: ShownEvent[]): UploadResponse {
  if (!shownEvents || !result.results) return result;
  return {
    ...result,
    results: result.results.map((r) => {
      if (r.eventId == null) return r;
      const shown = shownEvents.find(
        (e) => e.id === r.eventId || (!!e.symbol && e.symbol.toUpperCase() === r.symbol.toUpperCase()),
      );
      return { ...r, eventDate: r.eventDate ?? shown?.eventDate ?? null, offWeek: !shown };
    }),
  };
}

/**
 * Drop-zone / file-picker for multi-symbol earnings bogeys PDFs or
 * screenshots (e.g., TMT Breakout's weekly preview page, or a phone
 * screenshot of a bogeys table). Posts to
 * /api/earnings/bogeys/upload, which:
 *   1. Archives to R2.
 *   2. Sends to Claude for per-symbol extraction.
 *   3. Fans out to matching calendar_events for the visible week.
 *
 * Renders inline summary on success: "Matched 4 of 5 symbols (TER unmatched)".
 */
export function BogeysUploadButton({ weekOf, shownEvents }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ data: UploadResponse; fileName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("weekOf", weekOf);
      fd.append("sourceLabel", `${file.name.replace(/\.(pdf|png|jpe?g|webp|gif)$/i, "")} ${weekOf}`);
      const res = await apiFetch("/api/earnings/bogeys/upload", {
        method: "POST",
        body: fd,
      });
      const data = (await res.json()) as UploadResponse;
      if (!res.ok) {
        setError(data.error ?? `Server returned ${res.status}`);
        return;
      }
      setResult({ data: locateInShownWeek(data, shownEvents), fileName: file.name });
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
        onClick={() => {
          // Re-opening the chooser is a fresh attempt: a rejection from the
          // last file no longer describes anything (qa: error never clears).
          setError(null);
          fileInputRef.current?.click();
        }}
        disabled={uploading}
        className="text-gold-ink hover:text-gold/80 font-medium disabled:opacity-50 relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3 pointer-coarse:after:-inset-x-2"
      >
        {uploading ? "Uploading…" : "+ Upload bogeys PDF/screenshot"}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf,image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          else setError(null);
          // Reset so re-selecting the same file still triggers onChange.
          e.target.value = "";
        }}
      />
      {result && (
        <span className="text-[11px] font-mono text-ink-faint">
          {describeUploadOutcome(result.data, result.fileName).map((line, i) => (
            <span key={line.text} className={line.tone === "warn" ? "text-down" : undefined}>
              {i > 0 ? " · " : ""}
              {line.text}
            </span>
          ))}
        </span>
      )}
      {error && (
        <span role="alert" className="text-[11px] text-down">
          {error}{" "}
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss this message"
            className="relative text-ink-faint hover:text-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']"
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
