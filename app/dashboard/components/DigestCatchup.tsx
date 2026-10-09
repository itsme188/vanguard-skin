"use client";

import { GOLD_FILL_CLASSES } from "@/app/dashboard/components/chip-tone-text";
import { useState, useEffect } from "react";
import apiFetch from "@/lib/http/apiFetch";
import { todayET } from "@/lib/calendar/date-utils";
import { decideDigestBanner } from "@/lib/digest/catchup-banner";

// Per-tab, per-ET-day dismissal. Component state alone lost it on every
// client navigation (the banner remounts); sessionStorage keeps it for the
// tab and the date value expires it the next day.
const DISMISS_KEY = "vgs:digest-banner-dismissed";

function isDismissedToday(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === todayET();
  } catch {
    return false;
  }
}

function rememberDismissal(): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, todayET());
  } catch {
    // blocked store: dismissal lasts until the next navigation, nothing breaks
  }
}

// Mirrors com.vanguard-skin.daily-digest.plist — Mon-Fri 8:45 AM local.
const DIGEST_HOUR = 8;
const DIGEST_MINUTE = 45;
const DIGEST_TIME_LABEL = "8:45 AM";

/**
 * Shows a notification banner if today's digest email wasn't sent.
 * Checks /api/digest/status on mount. Only shows on weekdays AFTER the
 * scheduled send time has passed — pre-8:45 AM the digest is "expected,
 * not late."
 *
 * Cloud-aware (2026-07-15): the status route reports today's Worker marker.
 * A confirmed cloud-fallback delivery counts as sent (pre-fix, the banner
 * nagged all day on every cloud-sent day because it only read the Mac-local
 * last_digest_sent_at). An in-flight cloud attempt shows an informational
 * line WITHOUT the Send button — a manual send would race the fallback.
 *
 * Skip-aware: when the scheduled run looked today and found nothing new, the
 * status route reports that skip. The banner then says so and offers no Send
 * button, because a send over the same window would skip for the same reason.
 */
export function DigestCatchup() {
  const [show, setShow] = useState(false);
  const [cloudSending, setCloudSending] = useState(false);
  const [skippedEmpty, setSkippedEmpty] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    // Only check on weekdays
    const day = new Date().getDay();
    if (day === 0 || day === 6) return;
    if (isDismissedToday()) return;

    // Check once on mount, then poll every 5 min, and also re-check when
    // the window regains focus. Needed because the 8:45 launchd cron sends
    // the digest via curl — without polling, a dashboard that was already
    // open at 8:44 AM would keep nagging forever.
    const checkStatus = () => {
      if (isDismissedToday()) {
        setShow(false);
        return;
      }
      const now = new Date();
      const scheduled = new Date();
      scheduled.setHours(DIGEST_HOUR, DIGEST_MINUTE, 0, 0);
      // Pre-scheduled-time on a weekday: digest hasn't been sent yet, and
      // that's expected. Don't nag.
      if (now < scheduled) {
        setShow(false);
        setCloudSending(false);
        setSkippedEmpty(false);
        return;
      }

      // POST (not GET): the on-wake reconcile — which advances the shared
      // last_digest_sent_at pointer from confirmed cloud sends — is a WRITE,
      // moved off the GET read for the SameSite=Lax CSRF fix (#35 task 5). This
      // poller is the "open dashboard heals the pointer within one poll" path,
      // so it calls POST. Routed through apiFetch (#35 task 9-12) since it's a mutating call.
      apiFetch("/api/digest/status", { method: "POST" })
        .then((r) => r.json())
        .then((data) => {
          // One rule for every state (lib/digest/catchup-banner.ts): a cloud
          // attempt in flight is informational; a confirmed cloud send or a
          // local send at or after the trigger hides the banner; a recorded
          // empty-window skip today is explained without a Send button.
          const state = decideDigestBanner({
            now,
            scheduled,
            today: todayET(now),
            lastDigestSentAt: data.lastDigestSentAt ?? null,
            cloudPresent: Boolean(data.cloudDigestToday),
            cloudVia: data.cloudDigestToday?.via ?? null,
            lastDigestSkip: data.lastDigestSkip ?? null,
          });
          setCloudSending(state === "cloud-sending");
          setSkippedEmpty(state === "skipped-empty");
          setShow(state !== "hidden");
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
      const res = await apiFetch("/api/digest/email", {
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
        // Show the server's own reason (e.g. an empty window) rather than
        // guessing "already sent". Nothing can be sent for this window, so
        // dismiss for the day instead of re-nagging on every poll.
        setSendError(
          typeof data.reason === "string" && data.reason
            ? `Nothing was sent — ${data.reason.charAt(0).toLowerCase()}${data.reason.slice(1)}.`
            : "Nothing was sent — the server skipped this window.",
        );
        rememberDismissal();
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
        ) : cloudSending ? (
          "Cloud fallback is sending today's digest — it should arrive within a few minutes."
        ) : skippedEmpty ? (
          "No digest went out this morning: there was nothing new to send since the last one. To send a different range, use the digest panel on the Research tab."
        ) : (
          `Today's digest wasn't sent at ${DIGEST_TIME_LABEL}`
        )}
      </span>
      <div className="flex items-center gap-2">
        {!sent && !cloudSending && !skippedEmpty && (
          <button
            onClick={handleSend}
            disabled={sending}
            className={`px-3 py-1 rounded-md text-xs font-medium ${GOLD_FILL_CLASSES} hover:brightness-110 transition-[filter,scale] active:scale-[0.96] disabled:opacity-50`}
          >
            {sending ? "Sending..." : "Send now"}
          </button>
        )}
        <button
          onClick={() => {
            rememberDismissal();
            setShow(false);
          }}
          aria-label="Dismiss digest reminder"
          title="Dismiss"
          className="relative text-ink-faint hover:text-ink pointer-coarse:p-2 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
