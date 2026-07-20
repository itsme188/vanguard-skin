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
 * The OAuth resume leg's URL is Vanguard's registered redirect_uri —
 * Plaid does NOT echo `?mode=reauth` back onto it, so whether the resumed
 * session is a reauth (skip token exchange) or a fresh connect (exchange
 * the public token) can't be re-derived from the resume URL's query
 * string. It's captured at mint time instead: the link token AND the
 * reauth flag are stashed together as one JSON payload in localStorage,
 * and the resume leg reads BOTH back from that payload.
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
const LINK_STORAGE_KEY = "vgs:plaidLink";

type ConnectState =
  | { kind: "loading" }
  | { kind: "opening" }
  | { kind: "syncing" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

// Persisted across the Vanguard OAuth redirect: the Link token to resume
// with, plus whether this session is a reauth (update mode — skip the
// exchange call) or a fresh connect (exchange the public token).
type StoredLinkPayload = { token: string; reauth: boolean };

function parseStoredLink(raw: string | null): StoredLinkPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredLinkPayload> | null;
    if (parsed && typeof parsed.token === "string" && parsed.token.length > 0 && typeof parsed.reauth === "boolean") {
      return { token: parsed.token, reauth: parsed.reauth };
    }
    return null;
  } catch {
    return null;
  }
}

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
        localStorage.removeItem(LINK_STORAGE_KEY);
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
        localStorage.removeItem(LINK_STORAGE_KEY);
        setState({
          kind: "error",
          message: err instanceof Error ? `Exchange failed: ${err.message}` : "Exchange failed.",
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
      localStorage.removeItem(LINK_STORAGE_KEY);
      if (cancelled) return;
      setState({ kind: "syncing" });
      try {
        const res = await fetch("/api/plaid/sync", { method: "POST" });
        const data = (await res.json()) as {
          success: boolean;
          holdingsWritten?: number;
          error?: string;
        };
        if (cancelled) return;
        if (data.success) {
          const n = data.holdingsWritten ?? 0;
          setState({
            kind: "success",
            message: `Re-authenticated and synced — ${n} holding${n === 1 ? "" : "s"} updated.`,
          });
        } else {
          setState({
            kind: "error",
            message: `Re-authenticated. Sync failed: ${data.error || "unknown error"} — you can retry from Settings.`,
          });
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: `Re-authenticated. Sync failed: ${
            err instanceof Error ? err.message : "unknown error"
          } — you can retry from Settings.`,
        });
      }
    }

    function handleExit(err: { error_message?: string; display_message?: string } | null | undefined) {
      if (cancelled) return;
      localStorage.removeItem(LINK_STORAGE_KEY);
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
          // session with the token + reauth flag we stashed before leaving
          // the page. Do NOT re-derive reauth from this URL's query string
          // — Plaid's redirect_uri never carries `?mode=reauth`.
          const stored = parseStoredLink(localStorage.getItem(LINK_STORAGE_KEY));
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
        const res = await fetch("/api/plaid/link-token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(isReauth ? { mode: "reauth" } : {}),
        });
        const data = (await res.json()) as { success: boolean; linkToken?: string; error?: string };
        if (!data.success || !data.linkToken) {
          throw new Error(data.error || `Failed to create a link token (HTTP ${res.status}).`);
        }
        localStorage.setItem(
          LINK_STORAGE_KEY,
          JSON.stringify({ token: data.linkToken, reauth: isReauth } satisfies StoredLinkPayload),
        );
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
              className="inline-block text-sm text-gold-ink hover:text-gold/80 underline"
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
              className="inline-block text-sm text-gold-ink hover:text-gold/80 underline"
            >
              Back to Portfolio Desk
            </a>
          </>
        )}
      </div>
    </div>
  );
}
