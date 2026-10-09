"use client";

import { GOLD_FILL_CLASSES } from "@/app/dashboard/components/chip-tone-text";
import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import { useState, useEffect, useCallback } from "react";
import { getCurrentMonday, addDays } from "@/lib/calendar/date-utils";
import apiFetch from "@/lib/http/apiFetch";
import {
  DIGEST_WINDOW_OPTIONS,
  digestSendBody,
  digestWindowNeedsDate,
  type DigestMode,
  type DigestWindowChoice,
} from "./digest-window-choice";

type EmailType = "digest" | "briefing";
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

// The API's refusal tells an API caller to pass an override flag. This panel
// has no such control, so the sentence is replaced with where the list lives.
const OVERRIDE_HINT = /\s*Pass override: true to send anyway\.?/;

export function sendRefusalCopy(message: string, emailType: EmailType): string {
  if (!OVERRIDE_HINT.test(message)) return message;
  const label = emailType === "digest" ? "Morning Digest" : "Sunday Briefing";
  return message.replace(
    OVERRIDE_HINT,
    ` This panel can only send to the configured recipients (Settings → Email Recipients → ${label}).`,
  );
}

interface SendDigestPanelProps {
  onClose: () => void;
  /** The digest window, held by the page so the Preview shows the same one. */
  digestWindow: DigestWindowChoice;
  onDigestWindowChange: (next: DigestWindowChoice) => void;
}

export function SendDigestPanel({ onClose, digestWindow, onDigestWindowChange }: SendDigestPanelProps) {
  const [status, setStatus] = useState<DigestStatus | null>(null);
  const [emailType, setEmailType] = useState<EmailType>("digest");
  const [recipient, setRecipient] = useState("");
  const digestMode = digestWindow.mode;
  const sinceDate = digestWindow.sinceDate;
  const setDigestMode = (mode: DigestMode) => onDigestWindowChange({ ...digestWindow, mode });
  const setSinceDate = (date: string) => onDigestWindowChange({ ...digestWindow, sinceDate: date });
  const [briefingMode, setBriefingMode] = useState<BriefingMode>("this_week");
  const [weekOfDate, setWeekOfDate] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  // The window can also change from the Preview while this panel is open. A
  // status line from the old window must not survive that either.
  const [seenWindow, setSeenWindow] = useState(digestWindow);
  if (seenWindow !== digestWindow) {
    setSeenWindow(digestWindow);
    setResult(null);
  }

  // Fetch status on mount
  useEffect(() => {
    fetch("/api/digest/status")
      .then((r) => r.json())
      .then((data: DigestStatus) => {
        setStatus(data);
        if (data.defaultRecipient) setRecipient(data.defaultRecipient);
      })
      .catch(() => {
        // The status only pre-fills the recipient and adds the "Last sent"
        // line. Without it the panel still sends: the box stays blank and no
        // last-sent date is claimed.
      });
  }, []);

  // A date-required range mode with a blank date must not send — the server
  // silently substitutes a different window (last-24h / current Monday).
  const missingDate =
    emailType === "digest"
      ? digestWindowNeedsDate(digestWindow)
      : briefingMode === "week_of" && !weekOfDate;

  const handleSend = useCallback(async () => {
    if (!recipient.trim()) return;
    if (
      (emailType === "digest" && digestWindowNeedsDate(digestWindow)) ||
      (emailType === "briefing" && briefingMode === "week_of" && !weekOfDate)
    ) {
      return;
    }
    setSending(true);
    setResult(null);

    try {
      if (emailType === "digest") {
        const body: { to: string; mode: DigestMode; sinceDate?: string } = {
          to: recipient.trim(),
          ...digestSendBody(digestWindow),
        };

        const res = await apiFetch("/api/digest/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const r = await readMutationResult<{ skipped?: boolean; sentTo?: string }>(res);

        if (r.ok && r.data.skipped) {
          setResult({ success: false, message: "No articles in the selected range" });
        } else if (r.ok) {
          setResult({ success: true, message: `Sent to ${r.data.sentTo}` });
          // Update status
          setStatus((s) => s ? { ...s, lastDigestSentAt: new Date().toISOString() } : s);
        } else {
          setResult({ success: false, message: `Couldn't send the digest: ${sendRefusalCopy(r.message, "digest")}` });
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
        const r = await readMutationResult<{ sentTo?: string }>(res);

        if (r.ok) {
          setResult({ success: true, message: `Sent to ${r.data.sentTo}` });
          setStatus((s) => s ? { ...s, lastBriefingSentAt: new Date().toISOString() } : s);
        } else {
          setResult({ success: false, message: `Couldn't send the briefing: ${sendRefusalCopy(r.message, "briefing")}` });
        }
      }
    } catch {
      setResult({ success: false, message: networkFailureMessage("send the email") });
    } finally {
      setSending(false);
    }
  }, [emailType, recipient, digestWindow, briefingMode, weekOfDate]);

  // A status line describes the send it came from. Changing the email type or
  // its window makes it stale, so every such control clears it.
  const clearResult = () => setResult(null);

  const lastSent = emailType === "digest" ? status?.lastDigestSentAt : status?.lastBriefingSentAt;

  return (
    <div className="rounded-lg border border-edge bg-panel/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink">Send Email</h3>
        <button
          onClick={onClose}
          aria-label="Close send email panel"
          className="text-ink-faint hover:text-ink text-sm p-3.5 -m-3.5"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Type toggle */}
      <div className="flex gap-1 rounded-md bg-raised p-0.5">
        <button
          onClick={() => { clearResult(); setEmailType("digest"); }}
          className={`flex-1 px-3 py-1 rounded text-xs font-medium transition-colors ${
            emailType === "digest" ? "bg-panel text-ink shadow-sm" : "text-ink-dim hover:text-ink"
          }`}
        >
          Daily Digest
        </button>
        <button
          onClick={() => { clearResult(); setEmailType("briefing"); }}
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
            onChange={(e) => { clearResult(); setDigestMode(e.target.value as DigestMode); }}
            className="px-3 py-1.5 rounded-md bg-raised border border-edge text-sm text-ink"
          >
            {DIGEST_WINDOW_OPTIONS.map((o) => (
              <option key={o.mode} value={o.mode}>
                {o.label}
                {o.mode === "since_last" && lastSent ? ` (${formatDate(lastSent)})` : ""}
              </option>
            ))}
          </select>
          {digestMode === "since_date" && (
            <input
              type="date"
              value={sinceDate}
              onChange={(e) => { clearResult(); setSinceDate(e.target.value); }}
              className="px-3 py-1.5 rounded-md bg-raised border border-edge text-sm text-ink"
            />
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <select
            value={briefingMode}
            onChange={(e) => { clearResult(); setBriefingMode(e.target.value as BriefingMode); }}
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
              onChange={(e) => { clearResult(); setWeekOfDate(e.target.value); }}
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
          className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-sm font-medium ${GOLD_FILL_CLASSES} hover:brightness-110 transition-[filter,scale] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed`}
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
