/**
 * Pure scheme + origin allow-list for handing a URL off to `shell.openExternal`.
 *
 * Two call sites need the identical rule (main.ts's `setWindowOpenHandler`
 * and ipc-handlers.ts's `open-external` handler) and previously diverged —
 * the IPC handler had no check at all. Extracted here so both share one
 * decision and the logic is testable without booting Electron.
 *
 * Rules:
 * - The URL must parse (`new URL(url)`); an unparseable string is denied.
 * - Scheme must be http:, https:, or mailto: — covers every real link plus
 *   newsletter unsubscribe footers. Anything else (file:, javascript:, a
 *   registered custom scheme) is denied: handing it to the OS via
 *   shell.openExternal would open a local file or launch another app.
 * - The app's OWN loopback origins are denied even on an allowed scheme —
 *   `localhost` / `127.0.0.1` on any port. Forwarding one of these to the
 *   system browser ships the app's own route outside the Electron session,
 *   where the desktop session cookie does not exist, so it just 404s/bounces
 *   to a login the browser can't satisfy. (PlaidSection.tsx currently opens
 *   a relative in-app route with target=_blank and hits this today — that
 *   component is out of scope here; this only makes the handler deny+log it
 *   instead of silently shipping it to the browser.)
 *
 * @param ownOrigins Extra hostnames (lowercase, no port) to treat as the
 *   app's own origin in addition to the built-in `localhost` / `127.0.0.1`
 *   check — e.g. a named tunnel hostname, if one is ever fronting this app.
 *   Optional; the loopback check always applies regardless of this list.
 */
export function isExternalUrlAllowed(url: string, ownOrigins?: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const scheme = parsed.protocol;
  if (scheme !== "http:" && scheme !== "https:" && scheme !== "mailto:") {
    return false;
  }

  // mailto: has no meaningful hostname to loopback-check.
  if (scheme === "mailto:") {
    return true;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return false;
  }
  if (ownOrigins?.some((origin) => origin.toLowerCase() === hostname)) {
    return false;
  }

  return true;
}
