"use client";

import { useState, useEffect, useCallback } from "react";
import { getCurrentMonday, addDays } from "@/lib/calendar/date-utils";
import apiFetch from "@/lib/http/apiFetch";

type EmailType = "digest" | "briefing";
type DigestMode = "today" | "since_last" | "since_date";
type BriefingMode = "this_week" | "last_week" | "week_of";

interface DigestStatus {
  lastDigestSentAt: string | null;
  lastBriefingSentAt: string | null;
  defaultRecipient: string | null;
  /** Today's Worker cloud marker (null when the Mac sent or nothing sent). */
  cloudDigestToday?: {
    sentBy: "mac" | "cloud" | null;
    sentAt?: string | null;
    via?: "sent" | "attempting";
  } | null;
}

export function SendDigestPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<DigestStatus | null>(null);
  const [emailType, setEmailType] = useState<EmailType>("digest");
  const [recipient, setRecipient] = useState("");
  const [digestMode, setDigestMode] = useState<DigestMode>("today");
  const [briefingMode, setBriefingMode] = useState<BriefingMode>("this_week");
  const [sinceDate, setSinceDate] = useState("");
  const [weekOfDate, setWeekOfDate] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  // Fetch status on mount
  useEffect(() => {
    fetch("/api/digest/status")
      .then((r) => r.json())
      .then((data: DigestStatus) => {
        setStatus(data);
        if (data.defaultRecipient) setRecipient(data.defaultRecipient);
      })
      .catch(() => {});
  }, []);

  // A date-required range mode with a blank date must not send — the server
  // silently substitutes a different window (last-24h / current Monday).
  const missingDate =
    emailType === "digest"
      ? digestMode === "since_date" && !sinceDate
      : briefingMode === "week_of" && !weekOfDate;

  const handleSend = useCallback(async () => {
    if (!recipient.trim()) return;
    if (
      (emailType === "digest" && digestMode === "since_date" && !sinceDate) ||
      (emailType === "briefing" && briefingMode === "week_of" && !weekOfDate)
    ) {
      return;
    }
    setSending(true);
    setResult(null);

    try {
      if (emailType === "digest") {
        const body: Record<string, string> = { to: recipient.trim(), mode: digestMode };
        if (digestMode === "since_date" && sinceDate) body.sinceDate = sinceDate;

        const res = await apiFetch("/api/digest/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();

        if (data.success && data.skipped) {
          setResult({ success: false, message: "No articles in the selected range" });
        } else if (data.success) {
          setResult({ success: true, message: `Sent to ${data.sentTo}` });
          // Update status
          setStatus((s) => s ? { ...s, lastDigestSentAt: new Date().toISOString() } : s);
        } else {
          setResult({ success: false, message: data.error || "Failed to send" });
        }
      } else {
        // Weekly briefing
        let weekOf: string;
        if (briefingMode === "this_week") {
          weekOf = getCurrentMonday();
        } else if (briefingMode === "last_week") {
          weekOf = addDays(getCurrentMonday(), -7);
        } else {
          weekOf = weekOfDate || getCurrentMonday();
        }

        const res = await apiFetch("/api/calendar/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ weekOf, to: recipient.trim() }),
        });
        const data = await res.json();

        if (data.success) {
          setResult({ success: true, message: `Sent to ${data.sentTo}` });
          setStatus((s) => s ? { ...s, lastBriefingSentAt: new Date().toISOString() } : s);
        } else {
          setResult({ success: false, message: data.error || "Failed to send" });
        }
      }
    } catch (err) {
      setResult({ success: false, message: err instanceof Error ? err.message : "Network error" });
    } finally {
      setSending(false);
    }
  }, [emailType, recipient, digestMode, sinceDate, briefingMode, weekOfDate]);

  const lastSent = emailType === "digest" ? status?.lastDigestSentAt : status?.lastBriefingSentAt;

  return (
    <div className="rounded-lg border border-edge bg-panel/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink">Send Email</h3>
        <button onClick={onClose} className="text-ink-faint hover:text-ink text-sm">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Type toggle */}
      <div className="flex gap-1 rounded-md bg-raised p-0.5">
        <button
          onClick={() => setEmailType("digest")}
          className={`flex-1 px-3 py-1 rounded text-xs font-medium transition-colors ${
            emailType === "digest" ? "bg-panel text-ink shadow-sm" : "text-ink-dim hover:text-ink"
          }`}
        >
          Daily Digest
        </button>
        <button
          onClick={() => setEmailType("briefing")}
          className={`flex-1 px-3 py-1 rounded text-xs font-medium transition-colors ${
            emailType === "briefing" ? "bg-panel text-ink shadow-sm" : "text-ink-dim hover:text-ink"
          }`}
        >
          Weekly Briefing
        </button>
      </div>

      {/* Recipient */}
      <input
        type="text"
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
        placeholder="recipient@email.com"
        className="w-full px-3 py-1.5 rounded-md bg-raised border border-edge text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-gold"
      />

      {/* Mode selector */}
      {emailType === "digest" ? (
        <div className="flex flex-col gap-2">
          <select
            value={digestMode}
            onChange={(e) => setDigestMode(e.target.value as DigestMode)}
            className="px-3 py-1.5 rounded-md bg-raised border border-edge text-sm text-ink"
          >
            <option value="today">Today&apos;s articles</option>
            <option value="since_last">
              Since last email{lastSent ? ` (${formatDate(lastSent)})` : ""}
            </option>
            <option value="since_date">Since date...</option>
          </select>
          {digestMode === "since_date" && (
            <input
              type="date"
              value={sinceDate}
              onChange={(e) => setSinceDate(e.target.value)}
              className="px-3 py-1.5 rounded-md bg-raised border border-edge text-sm text-ink"
            />
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <select
            value={briefingMode}
            onChange={(e) => setBriefingMode(e.target.value as BriefingMode)}
            className="px-3 py-1.5 rounded-md bg-raised border border-edge text-sm text-ink"
          >
            <option value="this_week">This week</option>
            <option value="last_week">Last week</option>
            <option value="week_of">Week of...</option>
          </select>
          {briefingMode === "week_of" && (
            <input
              type="date"
              value={weekOfDate}
              onChange={(e) => setWeekOfDate(e.target.value)}
              className="px-3 py-1.5 rounded-md bg-raised border border-edge text-sm text-ink"
            />
          )}
        </div>
      )}

      {/* Send button + status */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSend}
          disabled={sending || !recipient.trim() || missingDate}
          className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-sm font-medium bg-gold text-canvas hover:brightness-110 transition-[filter,scale] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {sending ? (
            <div className="w-3.5 h-3.5 border-2 border-canvas border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          )}
          Send
        </button>

        {result && (
          <span className={`text-xs ${result.success ? "text-up" : "text-down"}`}>
            {result.message}
          </span>
        )}

        {!result && missingDate && (
          <span className="text-xs text-warn">Choose a date first</span>
        )}

        {!result && !missingDate && lastSent && (
          <span className="text-xs text-ink-faint">
            Last sent: {formatDate(lastSent)}
            {emailType === "digest" && status?.cloudDigestToday?.via === "sent" && (
              // Refers to TODAY'S DIGEST specifically — lastDigestSentAt is the
              // shared window pointer and may show a later Mac-sent evening send.
              <> · today&apos;s digest via cloud fallback</>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 10);
  }
}
