"use client";

import { useState, useEffect } from "react";

/**
 * Shows a notification banner if today's digest email wasn't sent.
 * Checks /api/digest/status on mount. Only shows on weekdays.
 */
export function DigestCatchup() {
  const [show, setShow] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    // Only check on weekdays
    const day = new Date().getDay();
    if (day === 0 || day === 6) return;

    // Check once on mount, then poll every 5 min, and also re-check when
    // the window regains focus. Needed because the 9am launchd cron sends
    // the digest via curl — without polling, a dashboard that was already
    // open at 8:59am would keep nagging forever.
    const checkStatus = () => {
      fetch("/api/digest/status")
        .then((r) => r.json())
        .then((data) => {
          if (!data.lastDigestSentAt) {
            setShow(true);
            return;
          }
          const lastSent = new Date(data.lastDigestSentAt);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          setShow(lastSent < today);
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
      const res = await fetch("/api/digest/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.success && !data.skipped) {
        setSent(true);
        setTimeout(() => setShow(false), 3000);
      } else {
        setShow(false);
      }
    } catch {
      setShow(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-4 md:mx-6 mt-2 px-4 py-2.5 rounded-lg bg-gold/10 border border-gold/20 flex items-center justify-between gap-3 text-sm">
      <span className="text-ink-dim">
        {sent ? (
          <span className="text-up">Digest sent!</span>
        ) : (
          "Today's digest wasn't sent at 9 AM"
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
