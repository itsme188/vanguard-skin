"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import apiFetch from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";

interface Props {
  ticker: string;
}

/**
 * Derives the "already up to date" notice text from the cached transcript
 * row the API returned (`body.data` on a fromCache:true response). `data`
 * is typed `unknown` and checked defensively rather than trusted against
 * `EarningsTranscript` — it crossed a network + JSON.parse boundary, so a
 * malformed/older-shaped payload should degrade to the generic message
 * instead of throwing.
 *
 * Extracted as a pure function (rather than inlined in the click handler)
 * so it's unit-testable without a rendering harness — this repo has no
 * @testing-library/react/jsdom; see
 * tests/dashboard/narrative-block-refresh.test.ts for the precedent of
 * testing an extracted pure helper directly and leaving the fetch/click
 * wiring itself to browser verification.
 */
export function formatCacheNotice(data: unknown): string {
  if (
    data &&
    typeof data === "object" &&
    typeof (data as { quarter?: unknown }).quarter === "number" &&
    typeof (data as { year?: unknown }).year === "number"
  ) {
    const { quarter, year } = data as { quarter: number; year: number };
    return `Already up to date — Q${quarter} ${year} is the latest cached quarter`;
  }
  return "Already up to date — no new transcript found";
}

/**
 * The line to show when the route could NOT confirm the document as the
 * issuer's latest (`latestConfirmed: false`): the server's own note, or a
 * plain fallback when the flag came without one. Null in every other case
 * (confirmed, no claim made, an older reply shape), so the caller keeps its
 * usual notice. Pure for the same reason as `formatCacheNotice`.
 */
export function latestNoteLine(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { latestConfirmed, latestNote } = body as {
    latestConfirmed?: unknown;
    latestNote?: unknown;
  };
  if (latestConfirmed !== false) return null;
  return typeof latestNote === "string" && latestNote.trim().length > 0
    ? latestNote.trim()
    : "This could not be confirmed as the most recent document; a newer one may exist.";
}

/**
 * Client island that POSTs /api/transcripts {ticker} to trigger the
 * fallback fetch chain (API Ninjas → Motley Fool → EDGAR with
 * quarter-match guard) and then refreshes the page on success.
 *
 * No quarter is passed — the fetcher defaults to the most recent
 * quarter of the latest print (its fiscal quarter when known), which is what the user wants when
 * they click "refresh" on a security they don't follow per-quarter.
 *
 * fromCache:true means the newest quarter was already cached — nothing
 * changed, so router.refresh() alone would silently no-op with no visible
 * feedback. We surface a neutral notice in that case (never an error: the
 * refresh succeeded, there was just nothing new to fetch). An
 * edgar_8k→alpha_vantage upgrade of an already-listed quarter returns
 * fromCache:false with a new row, which DOES change content — that case
 * intentionally stays silent-refresh, same as brand-new quarters.
 */
export function TranscriptsRefreshButton({ ticker }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch("/api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      const result = await readMutationResult<{ fromCache?: unknown; data?: unknown }>(res);
      if (!result.ok) {
        setError(result.message);
        setBusy(false);
        return;
      }
      const body = result.data;
      // A document that is not confirmed as the latest says so, cached or
      // not; "is the latest cached quarter" would contradict it.
      const notLatest = latestNoteLine(body);
      if (notLatest) {
        setNotice(notLatest);
      } else if (body.fromCache === true) {
        setNotice(formatCacheNotice(body.data));
      }
      router.refresh();
      // Brief grace period so the disabled state is visible after refresh
      // commits — otherwise the button flashes idle while the new HTML
      // streams in.
      setTimeout(() => setBusy(false), 300);
    } catch {
      setError(networkFailureMessage("fetch the latest transcript"));
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 text-[11px]">
      {error && (
        <span className="text-down" style={{ maxWidth: "360px" }}>
          ⚠ {error}
        </span>
      )}
      {!error && notice && (
        <span className="text-ink-faint" style={{ maxWidth: "360px" }}>
          {notice}
        </span>
      )}
      <button
        type="button"
        onClick={refresh}
        disabled={busy}
        className="text-ink-dim hover:text-gold disabled:opacity-50 font-mono"
      >
        {busy ? "…fetching" : "↻ refresh"}
      </button>
    </div>
  );
}
