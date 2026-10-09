"use client";

/**
 * Plaid Link connect page — handles BOTH legs of the flow:
 *   1. First connect (or reauth): request a fresh link token from
 *      /api/plaid/link-token, then open Plaid Link.
 *   2. Vanguard's OAuth redirect back into this same page (Link's
 *      `oauth_state_id` query param is present): resume the SAME Link
 *      session using the token stashed before the redirect +
 *      `receivedRedirectUri` — Plaid does NOT let you mint a new token
 *      for the resume leg.
 *
 * Deliberately reads `window.location.search` inside useEffect instead
 * of `useSearchParams()` — the latter forces the page into a <Suspense>
 * boundary (Next.js static-generation constraint); this page has no DB
 * load and no SSR content, so the client-only read is simpler and avoids
 * the Suspense wrapper entirely.
 *
 * The OAuth resume leg's URL is Vanguard's registered redirect_uri —
 * Plaid does NOT echo `?mode=reauth` back onto it, so whether the resumed
 * session is a reauth (skip token exchange) or a fresh connect (exchange
 * the public token) can't be re-derived from the resume URL's query
 * string. It's captured at mint time instead: the link token AND the
 * reauth flag are stashed together as one JSON payload, and the resume
 * leg reads BOTH back from that payload. The stash is one entry PER TAB
 * (`lib/plaid/link-storage.ts`), so two tabs on this page cannot resume
 * with each other's token.
 *
 * Opened via `target="_blank"` from Settings → Vanguard Live (Plaid), so
 * it renders inside the normal dashboard shell (header/nav) in its own
 * tab — same as any other /dashboard/* route.
 */

import { useEffect, useState } from "react";
import apiFetch from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
import { createPlaidLinkStore, type StoredLinkPayload } from "@/lib/plaid/link-storage";

declare global {
  interface Window {
    Plaid?: {
      create: (opts: Record<string, unknown>) => { open: () => void };
    };
  }
}

const LINK_SCRIPT_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

type ConnectState =
  | { kind: "loading" }
  | { kind: "opening" }
  | { kind: "syncing" }
  | { kind: "success"; message: string }
  | { kind: "cancelled"; message: string }
  | { kind: "error"; message: string };

// Persisted across the Vanguard OAuth redirect (the Link token to resume
// with, plus whether the session is a reauth): `StoredLinkPayload`, kept per
// tab by `createPlaidLinkStore`.

function loadPlaidScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();

  // React Strict Mode double-mounts effects in dev, which can call this
  // twice in quick succession. If a script tag is already present (from
  // this mount's first pass, or a prior in-flight load), don't append a
  // second one — just poll for window.Plaid to appear.
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${LINK_SCRIPT_SRC}"]`);
  if (existing) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (window.Plaid) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start > 10000) {
          clearInterval(timer);
          reject(new Error("Failed to load the Plaid Link script."));
        }
      }, 50);
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = LINK_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load the Plaid Link script."));
    document.head.appendChild(script);
  });
}

export default function PlaidLinkPage() {
  const [state, setState] = useState<ConnectState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const linkStore = createPlaidLinkStore({ local: window.localStorage, session: window.sessionStorage });

    async function exchangeAndReport(publicToken: string) {
      try {
        const res = await apiFetch("/api/plaid/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ publicToken }),
        });
        const result = await readMutationResult<{
          plaidAccounts?: { id: string; name: string; mask: string | null; subtype: string | null }[];
        }>(res);
        if (cancelled) return;
        linkStore.clear();
        if (!result.ok) {
          setState({ kind: "error", message: `Vanguard was not connected: ${result.message}` });
          return;
        }
        const n = result.data.plaidAccounts?.length ?? 0;
        setState({
          kind: "success",
          message: `Connected — ${n} Vanguard account${n === 1 ? "" : "s"} found and mapped. Review the mapping in Settings → Vanguard Live (Plaid).`,
        });
      } catch {
        if (cancelled) return;
        linkStore.clear();
        setState({
          kind: "error",
          message: `${networkFailureMessage("finish connecting Vanguard")} Nothing was connected.`,
        });
      }
    }

    // Reauth (Link update-mode) success path — shared by the direct leg
    // and the OAuth-resume leg. Update mode never mints a new access
    // token/public token exchange, so nothing in this flow otherwise
    // clears plaid_connection_status='reauth_required' — Settings would
    // keep showing "Reconnect" forever until the next 07:30 ET cron sync
    // happens to succeed. Firing a sync here closes that gap immediately
    // and reports honestly: the orchestrator itself sets status="ok" on a
    // successful sync (no change needed there), so a failed sync here
    // correctly leaves the reauth-required banner up.
    async function reauthSuccessAndSync() {
      linkStore.clear();
      if (cancelled) return;
      setState({ kind: "syncing" });
      try {
        const res = await apiFetch("/api/plaid/sync", { method: "POST" });
        const result = await readMutationResult<{ holdingsWritten?: number }>(res);
        if (cancelled) return;
        if (result.ok) {
          const n = result.data.holdingsWritten ?? 0;
          setState({
            kind: "success",
            message: `Re-authenticated and synced — ${n} holding${n === 1 ? "" : "s"} updated.`,
          });
        } else {
          setState({
            kind: "error",
            message: `Re-authenticated. Sync failed: ${result.message} You can retry from Settings.`,
          });
        }
      } catch {
        if (cancelled) return;
        setState({
          kind: "error",
          message: `Re-authenticated. Sync failed: could not reach the server. You can retry from Settings.`,
        });
      }
    }

    function handleExit(err: { error_message?: string; display_message?: string } | null | undefined) {
      if (cancelled) return;
      linkStore.clear();
      if (!err) {
        // The owner closed Link themselves: a cancellation, not a failure.
        setState({ kind: "cancelled", message: "Link closed before connecting — nothing was changed." });
        return;
      }
      setState({
        kind: "error",
        message: err.display_message || err.error_message || "Plaid Link exited with an error.",
      });
    }

    async function run() {
      try {
        await loadPlaidScript();
        if (cancelled) return;
        if (!window.Plaid) {
          throw new Error("Plaid Link script did not initialize.");
        }

        const search = window.location.search;
        const params = new URLSearchParams(search);
        const isOauthResume = params.has("oauth_state_id");
        const isReauth = params.get("mode") === "reauth";

        if (isOauthResume) {
          // Return leg of Vanguard's OAuth redirect — resume the SAME Link
          // session with the token + reauth flag we stashed before leaving
          // the page. Do NOT re-derive reauth from this URL's query string
          // — Plaid's redirect_uri never carries `?mode=reauth`.
          const stored = linkStore.load();
          if (!stored) {
            throw new Error(
              "Missing Link session — the token stored before the redirect wasn't found. Close this tab and reconnect from Settings.",
            );
          }
          setState({ kind: "opening" });
          window.Plaid.create({
            token: stored.token,
            receivedRedirectUri: window.location.href,
            onSuccess: (publicToken: string) => {
              if (stored.reauth) {
                void reauthSuccessAndSync();
                return;
              }
              void exchangeAndReport(publicToken);
            },
            onExit: handleExit,
          }).open();
          return;
        }

        // Fresh leg: mint a new link token (reauth uses update mode — no
        // new access token, just re-establishes the Vanguard login).
        let res: Response;
        try {
          res = await apiFetch("/api/plaid/link-token", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(isReauth ? { mode: "reauth" } : {}),
          });
        } catch {
          if (!cancelled) {
            setState({ kind: "error", message: networkFailureMessage("start Plaid Link") });
          }
          return;
        }
        const result = await readMutationResult<{ linkToken?: string }>(res);
        if (!result.ok || !result.data.linkToken) {
          if (!cancelled) {
            setState({
              kind: "error",
              message: `Couldn't start Plaid Link: ${
                result.ok ? "the server sent no link token." : result.message
              }`,
            });
          }
          return;
        }
        const data = { linkToken: result.data.linkToken };
        linkStore.save({ token: data.linkToken, reauth: isReauth } satisfies StoredLinkPayload);
        if (cancelled) return;
        setState({ kind: "opening" });
        window.Plaid.create({
          token: data.linkToken,
          onSuccess: (publicToken: string) => {
            if (isReauth) {
              void reauthSuccessAndSync();
              return;
            }
            void exchangeAndReport(publicToken);
          },
          onExit: handleExit,
        }).open();
      } catch (err) {
        // What reaches here is a sentence this page threw itself (the script
        // did not initialise, the stored Link session is missing) or the
        // Plaid widget's own error. The request above has its own catch.
        if (!cancelled) {
          setState({
            kind: "error",
            message: err instanceof Error ? err.message : "Failed to start Plaid Link.",
          });
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
    // Runs exactly once on mount — reads window.location.search itself
    // rather than depending on it.
  }, []);

  return (
    <div className="max-w-md mx-auto py-12">
      <div className="rounded-xl border border-edge bg-panel p-8 text-center space-y-4">
        <h1 className="text-lg font-medium text-ink">Vanguard Live (Plaid)</h1>

        {state.kind === "loading" && (
          <p className="text-sm text-ink-faint italic">Loading Plaid Link…</p>
        )}
        {state.kind === "opening" && (
          <p className="text-sm text-ink-faint italic">Opening Plaid Link…</p>
        )}
        {state.kind === "syncing" && (
          <p className="text-sm text-ink-faint italic">Re-authenticated — syncing holdings…</p>
        )}
        {state.kind === "success" && (
          <>
            <p className="text-sm text-up">{state.message}</p>
            <a
              href="/dashboard/today"
              className="inline-block text-sm text-gold-ink hover:decoration-2 underline"
            >
              Back to Portfolio Desk
            </a>
          </>
        )}
        {state.kind === "cancelled" && (
          <>
            <p className="text-sm text-ink-dim">{state.message}</p>
            <a
              href="/dashboard/today"
              className="inline-block text-sm text-gold-ink hover:decoration-2 underline"
            >
              Back to Portfolio Desk
            </a>
          </>
        )}
        {state.kind === "error" && (
          <>
            <p className="text-sm text-down">{state.message}</p>
            <a
              href="/dashboard/today"
              className="inline-block text-sm text-gold-ink hover:decoration-2 underline"
            >
              Back to Portfolio Desk
            </a>
          </>
        )}
      </div>
    </div>
  );
}
