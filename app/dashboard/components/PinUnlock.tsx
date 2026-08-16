"use client";

/**
 * Convenience-PIN re-unlock overlay (#35, task 16, spec §B2).
 *
 * A "lock" is a CLIENT-side UX state: the browser still holds the (non-expired)
 * session cookie, so re-unlocking is just a PIN check against that live
 * session — it never signs back in from cold. Other code puts the app into the
 * locked state by dispatching a `window` `"lock-app"` event (mirroring the
 * `"open-settings"` pattern SettingsModal already uses); this component owns
 * the overlay + the verify call.
 *
 * Outcomes (POST /api/auth/pin/verify):
 *   - success            -> unlock, app usable again (same cookie, now touched)
 *   - wrong PIN          -> stay locked, show attempts remaining
 *   - locked (423)       -> PIN disabled; force full password at /login
 *   - session gone (401) -> PIN can't help; force full password at /login
 */

import { useCallback, useEffect, useRef, useState } from "react";
import apiFetch from "@/lib/http/apiFetch";

type VerifyBody = {
  success: boolean;
  error?: string;
  data?: { fallback?: string; locked?: boolean; attemptsRemaining?: number };
};

export function PinUnlock() {
  const [locked, setLocked] = useState(false);
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Enter the locked state on demand: `window.dispatchEvent(new Event("lock-app"))`.
  useEffect(() => {
    function onLock() {
      setPin("");
      setError(null);
      setLocked(true);
    }
    window.addEventListener("lock-app", onLock);
    return () => window.removeEventListener("lock-app", onLock);
  }, []);

  useEffect(() => {
    if (locked) inputRef.current?.focus();
  }, [locked]);

  const toPassword = useCallback(() => {
    // Full navigation so the destination is served fresh (and the proxy can
    // redirect to /login if the session is truly gone).
    window.location.href = "/login";
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || pin.length < 4) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/auth/pin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const body = (await res.json().catch(() => null)) as VerifyBody | null;

      if (res.ok && body?.success) {
        setLocked(false);
        setPin("");
        return;
      }

      // Locked out or session gone: the PIN can no longer help — full password.
      if (res.status === 423 || body?.data?.fallback === "password") {
        setError("Too many attempts — enter your password.");
        setPin("");
        setTimeout(toPassword, 900);
        return;
      }

      const remaining = body?.data?.attemptsRemaining;
      setError(
        typeof remaining === "number"
          ? `Incorrect PIN — ${remaining} attempt${remaining === 1 ? "" : "s"} left.`
          : body?.error ?? "Incorrect PIN.",
      );
      setPin("");
    } catch {
      setError("Unlock unavailable. Try your password.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!locked) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-canvas/95 backdrop-blur-md px-4">
      <div className="w-full max-w-xs rounded-xl border border-edge bg-panel p-8 shadow-2xl">
        <h1 className="text-lg font-semibold text-ink mb-1 whitespace-nowrap!">Locked</h1>
        <p className="text-sm text-ink-faint mb-6">Enter your PIN to unlock.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="pin" className="block text-[11px] text-ink-dim mb-1">
              PIN
            </label>
            <input
              id="pin"
              ref={inputRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              pattern="\d*"
              maxLength={8}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              disabled={submitting}
              className="focus-ring w-full px-3 py-2 text-sm font-mono tracking-[0.4em] text-center bg-raised border border-edge rounded text-ink disabled:opacity-50"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-down">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || pin.length < 4}
            className="w-full py-2 text-sm font-medium rounded bg-gold text-canvas hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {submitting ? "Unlocking…" : "Unlock"}
          </button>

          <button
            type="button"
            onClick={toPassword}
            className="w-full text-[11px] text-ink-faint hover:text-ink-dim transition-colors underline"
          >
            Use password instead
          </button>
        </form>
      </div>
    </div>
  );
}
