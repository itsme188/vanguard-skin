"use client";

/**
 * Login page — packaged-app trust boundary (#35, task 7). The only public
 * page: reachable with no session cookie at all (`classifyRoute("GET",
 * "/login")` returns "public", task 3's manifest — nothing to change here,
 * just consumed). This is also the target of the proxy's `redirectLogin`
 * (a later task, task 18) once every OTHER route starts requiring a valid
 * session cookie.
 *
 * Deliberately reads `?next=` from `window.location.search` at submit time
 * instead of `useSearchParams()` — same reasoning as
 * app/dashboard/plaid-link/page.tsx: `useSearchParams()` forces a
 * <Suspense> boundary for static generation, and this page has no DB load
 * and no SSR content that needs it.
 *
 * Calls `POST /api/auth/login` with a plain `fetch` — `apiFetch` (task 8)
 * doesn't exist yet, and even once it does, login is the bootstrap call
 * that happens BEFORE any session/CSRF token exists, so it will always be
 * exempt from that wrapper.
 */

import { useState, type FormEvent } from "react";
import { safeNextPath } from "@/lib/auth/safe-next";

type LoginResponse = { success: true; data: { csrfToken: string } } | { success: false; error: string };

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      // eslint-disable-next-line local/no-raw-api-fetch -- bootstrap call: no session/CSRF token exists yet, so apiFetch can't apply here (see file header comment)
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.status === 200) {
        const params = new URLSearchParams(window.location.search);
        const next = safeNextPath(params.get("next"));
        // Full navigation (not router.push): the browser just received the
        // session cookie via Set-Cookie on this fetch response — a hard
        // reload guarantees the very next request (and any server
        // component data fetch on the destination page) sends it, with no
        // dependency on how the router's client cache treats a page it may
        // have prefetched pre-login.
        window.location.href = next;
        return;
      }

      const body = (await res.json().catch(() => null)) as LoginResponse | null;

      if (res.status === 401) {
        setError(body && !body.success ? body.error : "Incorrect password.");
        setPassword("");
      } else if (res.status === 429) {
        setError("Too many attempts, wait a few minutes.");
      } else {
        setError("Login unavailable. Try again later.");
      }
      setSubmitting(false);
    } catch {
      setError("Login unavailable. Try again later.");
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-xl bg-panel p-8">
        <h1 className="text-lg font-semibold text-ink mb-1 whitespace-nowrap!">Portfolio Desk</h1>
        <p className="text-sm text-ink-faint mb-6">Enter the password to continue.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="block text-[11px] text-ink-dim mb-1">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              className="focus-ring w-full px-3 py-2 text-sm bg-raised border border-edge rounded text-ink disabled:opacity-50"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-down">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || password.length === 0}
            className="w-full py-2 text-sm font-medium rounded bg-gold text-canvas hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
