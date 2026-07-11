"use client";

/**
 * Plaid Link connect page — handles BOTH legs of the flow:
 *   1. First connect (or reauth): request a fresh link token from
 *      /api/plaid/link-token, then open Plaid Link.
 *   2. Vanguard's OAuth redirect back into this same page (Link's
 *      `oauth_state_id` query param is present): resume the SAME Link
 *      session using the token stashed in localStorage before the
 *      redirect + `receivedRedirectUri` — Plaid does NOT let you mint a
 *      new token for the resume leg.
 *
 * Deliberately reads `window.location.search` inside useEffect instead
 * of `useSearchParams()` — the latter forces the page into a <Suspense>
 * boundary (Next.js static-generation constraint); this page has no DB
 * load and no SSR content, so the client-only read is simpler and avoids
 * the Suspense wrapper entirely.
 *
 * Opened via `target="_blank"` from Settings → Vanguard Live (Plaid), so
 * it renders inside the normal dashboard shell (header/nav) in its own
 * tab — same as any other /dashboard/* route.
 */

import { useEffect, useState } from "react";

declare global {
  interface Window {
    Plaid?: {
      create: (opts: Record<string, unknown>) => { open: () => void };
    };
  }
}

const LINK_SCRIPT_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const TOKEN_STORAGE_KEY = "vgs:plaidLinkToken";

type ConnectState =
  | { kind: "loading" }
  | { kind: "opening" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function loadPlaidScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
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

    async function exchangeAndReport(publicToken: string) {
      try {
        const res = await fetch("/api/plaid/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ publicToken }),
        });
        const data = (await res.json()) as {
          success: boolean;
          plaidAccounts?: { id: string; name: string; mask: string | null; subtype: string | null }[];
          error?: string;
        };
        if (cancelled) return;
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        if (!data.success) {
          setState({ kind: "error", message: data.error || "Exchange failed." });
          return;
        }
        const n = data.plaidAccounts?.length ?? 0;
        setState({
          kind: "success",
          message: `Connected — ${n} Vanguard account${n === 1 ? "" : "s"} found and mapped. Review the mapping in Settings → Vanguard Live (Plaid).`,
        });
      } catch (err) {
        if (cancelled) return;
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        setState({
          kind: "error",
          message: err instanceof Error ? `Exchange failed: ${err.message}` : "Exchange failed.",
        });
      }
    }

    function handleExit(err: { error_message?: string; display_message?: string } | null | undefined) {
      if (cancelled) return;
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      if (!err) {
        setState({ kind: "error", message: "Link closed before connecting — nothing was changed." });
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
          // session with the token we stashed before leaving the page.
          const token = localStorage.getItem(TOKEN_STORAGE_KEY);
          if (!token) {
            throw new Error(
              "Missing Link session — the token stored before the redirect wasn't found. Close this tab and reconnect from Settings.",
            );
          }
          setState({ kind: "opening" });
          window.Plaid.create({
            token,
            receivedRedirectUri: window.location.href,
            onSuccess: (publicToken: string) => {
              if (isReauth) {
                localStorage.removeItem(TOKEN_STORAGE_KEY);
                setState({ kind: "success", message: "Re-authenticated." });
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
        const res = await fetch("/api/plaid/link-token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(isReauth ? { mode: "reauth" } : {}),
        });
        const data = (await res.json()) as { success: boolean; linkToken?: string; error?: string };
        if (!data.success || !data.linkToken) {
          throw new Error(data.error || `Failed to create a link token (HTTP ${res.status}).`);
        }
        localStorage.setItem(TOKEN_STORAGE_KEY, data.linkToken);
        if (cancelled) return;
        setState({ kind: "opening" });
        window.Plaid.create({
          token: data.linkToken,
          onSuccess: (publicToken: string) => {
            if (isReauth) {
              localStorage.removeItem(TOKEN_STORAGE_KEY);
              setState({ kind: "success", message: "Re-authenticated." });
              return;
            }
            void exchangeAndReport(publicToken);
          },
          onExit: handleExit,
        }).open();
      } catch (err) {
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
        {state.kind === "success" && (
          <>
            <p className="text-sm text-up">{state.message}</p>
            <a
              href="/dashboard/today"
              className="inline-block text-sm text-gold hover:text-gold/80 underline"
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
              className="inline-block text-sm text-gold hover:text-gold/80 underline"
            >
              Back to Portfolio Desk
            </a>
          </>
        )}
      </div>
    </div>
  );
}
