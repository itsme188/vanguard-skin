"use client";

import { useState, useEffect } from "react";

// Mirrors com.vanguard-skin.daily-digest.plist — Mon-Fri 8:45 AM local.
const DIGEST_HOUR = 8;
const DIGEST_MINUTE = 45;
const DIGEST_TIME_LABEL = "8:45 AM";

/**
 * Shows a notification banner if today's digest email wasn't sent.
 * Checks /api/digest/status on mount. Only shows on weekdays AFTER the
 * scheduled send time has passed — pre-8:45 AM the digest is "expected,
 * not late."
 */
export function DigestCatchup() {
  const [show, setShow] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    // Only check on weekdays
    const day = new Date().getDay();
    if (day === 0 || day === 6) return;

    // Check once on mount, then poll every 5 min, and also re-check when
    // the window regains focus. Needed because the 8:45 launchd cron sends
    // the digest via curl — without polling, a dashboard that was already
    // open at 8:44 AM would keep nagging forever.
    const checkStatus = () => {
      const now = new Date();
      const scheduled = new Date();
      scheduled.setHours(DIGEST_HOUR, DIGEST_MINUTE, 0, 0);
      // Pre-scheduled-time on a weekday: digest hasn't been sent yet, and
      // that's expected. Don't nag.
      if (now < scheduled) {
        setShow(false);
        return;
      }

      fetch("/api/digest/status")
        .then((r) => r.json())
        .then((data) => {
          if (!data.lastDigestSentAt) {
            setShow(true);
            return;
          }
          const lastSent = new Date(data.lastDigestSentAt);
          // "Sent today" = sent at or after the scheduled trigger today.
          // Tolerates a stale midnight rollover where lastSent is from
          // yesterday's late-night manual catch-up but pre-trigger today.
          setShow(lastSent < scheduled);
        })
        .catch(() => {});
    };

    checkStatus();
    const pollId = setInterval(checkStatus, 5 * 60 * 1000);
    window.addEventListener("focus", checkStatus);

    return () => {
      clearInterval(pollId);
      window.removeEventListener("focus", checkStatus);
    };
  }, []);

  if (!show || sent) return null;

  const handleSend = async () => {
    setSending(true);
    try {
      // Send the same window the missed cron WOULD have sent (since_last),
      // and skip the last_digest_sent_at update so a still-in-flight cron
      // isn't poisoned by our "now" timestamp. Catches the 8:45 → 8:57
      // duplicate-with-thin-content race observed 2026-04-27.
      const res = await fetch("/api/digest/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "since_last", skipMarkerUpdate: true }),
      });
      const data = await res.json();
      if (data.success && !data.skipped) {
        setSent(true);
        setTimeout(() => setShow(false), 3000);
      } else if (data.skipped) {
        // Already handled elsewhere (cloud fallback / concurrent cron) —
        // explain rather than vanish, then dismiss.
        setSendError("Skipped — a digest for this window was already sent (cloud fallback or concurrent cron).");
        setTimeout(() => setShow(false), 6000);
      } else {
        // Keep the banner up — silently hiding it makes a failed send look successful.
        setSendError(`Send failed: ${data.error ?? "unknown error"}. The banner stays until a digest goes out.`);
      }
    } catch {
      setSendError("Send failed: could not reach the server.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-4 md:mx-6 mt-2 px-4 py-2.5 rounded-lg bg-gold/10 border border-gold/20 flex items-center justify-between gap-3 text-sm">
      <span className="text-ink-dim">
        {sent ? (
          <span className="text-up">Digest sent!</span>
        ) : sendError ? (
          <span className="text-down">{sendError}</span>
        ) : (
          `Today's digest wasn't sent at ${DIGEST_TIME_LABEL}`
        )}
      </span>
      <div className="flex items-center gap-2">
        {!sent && (
          <button
            onClick={handleSend}
            disabled={sending}
            className="px-3 py-1 rounded-md text-xs font-medium bg-gold text-canvas hover:brightness-110 disabled:opacity-50"
          >
            {sending ? "Sending..." : "Send now"}
          </button>
        )}
        <button
          onClick={() => setShow(false)}
          className="text-ink-faint hover:text-ink"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
