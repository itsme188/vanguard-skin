"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  symbol: string;
  eventDate: string; // the canonical (Nasdaq, on conflict) date
  releaseTime: string | null;
  dateStatus: "confirmed" | "conflict" | "single" | "user_confirmed" | null | undefined;
  dateConflictWith: string | null | undefined; // "finnhub:YYYY-MM-DD"
}

function fmtShort(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Earnings date trust chip + conflict-confirm popover.
 *
 * - confirmed       → "✓ 2 src" (Finnhub + Nasdaq agree)
 * - single          → "1 src"
 * - user_confirmed  → "🔒" (you locked the IBKR-definitive date)
 * - conflict        → "⚠ confirm" → popover: pick Nasdaq / Finnhub / your own
 *                     date → POST /api/earnings/confirm-date → locked forever.
 * - null            → nothing (row not reconciled yet)
 */
export function EarningsDateChip({
  symbol,
  eventDate,
  releaseTime,
  dateStatus,
  dateConflictWith,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState<"bmo" | "amc">(
    releaseTime && releaseTime < "12:00" ? "bmo" : "amc",
  );

  if (!dateStatus) return null;

  if (dateStatus === "confirmed") {
    return (
      <span className="text-[10px] font-mono text-up/80" title="Date confirmed by Finnhub + Nasdaq">
        ✓ 2 src
      </span>
    );
  }
  if (dateStatus === "single") {
    return (
      <span className="text-[10px] font-mono text-ink-faint" title="Only one calendar source has this date">
        1 src
      </span>
    );
  }
  if (dateStatus === "user_confirmed") {
    return (
      <span className="text-[10px] font-mono text-ink-dim" title="You confirmed this date (locked)">
        🔒
      </span>
    );
  }

  // conflict
  const finnDate = dateConflictWith?.split(":")[1] ?? null;
  const defaultTime = customTime;

  async function confirm(date: string, time: "bmo" | "amc") {
    if (submitting) return;
    setSubmitting(true);
    setConfirmError(null);
    try {
      const res = await fetch("/api/earnings/confirm-date", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, confirmedDate: date, confirmedTime: time }),
      });
      if (!res.ok) {
        // Keep the popover open — closing on a rejected confirm makes the
        // chip look resolved when the conflict is still live.
        const body = await res.json().catch(() => null);
        setConfirmError(`Confirm failed: ${body?.error ?? `server returned ${res.status}`}.`);
        return;
      }
      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      setConfirmError("Confirm failed: could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={pending}
        className="text-[10px] font-mono px-1.5 py-0.5 rounded text-gold-ink bg-gold/15 hover:bg-gold/25 disabled:opacity-50 cursor-pointer"
        title="Sources disagree on the date — confirm against IBKR"
      >
        ⚠ confirm
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-60 rounded-lg border border-edge bg-panel p-2 shadow-lg text-left">
          <p className="text-[11px] text-ink-dim mb-1.5">
            Sources disagree — pick the IBKR date:
          </p>
          <div className="space-y-1">
            <button
              type="button"
              disabled={submitting}
              onClick={() => confirm(eventDate, defaultTime)}
              className="w-full text-left text-[11px] font-mono px-2 py-1 rounded bg-raised hover:bg-muted disabled:opacity-50"
            >
              Nasdaq · {fmtShort(eventDate)}
            </button>
            {finnDate && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => confirm(finnDate, defaultTime)}
                className="w-full text-left text-[11px] font-mono px-2 py-1 rounded bg-raised hover:bg-muted disabled:opacity-50"
              >
                Finnhub · {fmtShort(finnDate)}
              </button>
            )}
            <div className="flex items-center gap-1 pt-1.5 mt-1 border-t border-edge">
              <input
                type="date"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                className="text-[10px] bg-raised rounded px-1 py-0.5 flex-1 min-w-0 text-ink"
                aria-label="Custom earnings date"
              />
              <select
                value={customTime}
                onChange={(e) => setCustomTime(e.target.value as "bmo" | "amc")}
                className="text-[10px] bg-raised rounded px-0.5 py-0.5 text-ink"
                aria-label="Release time"
              >
                <option value="bmo">BMO</option>
                <option value="amc">AMC</option>
              </select>
              <button
                type="button"
                disabled={submitting || !customDate}
                onClick={() => customDate && confirm(customDate, customTime)}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded text-up bg-up/15 hover:bg-up/25 disabled:opacity-40"
              >
                ok
              </button>
            </div>
            {confirmError && (
              <p className="text-[10px] text-down pt-1">{confirmError}</p>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
