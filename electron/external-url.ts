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
 *   to a login the browser can't satisfy. `setWindowOpenHandler` routes those
 *   to an in-session child window instead — see `classifyWindowOpenUrl`.
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

/**
 * Three-way classification for `setWindowOpenHandler`, which — unlike the
 * IPC `open-external` path — can also ALLOW a window instead of only
 * forwarding or denying:
 *
 * - "external": an allowed external URL → hand to the system browser.
 * - "own": an http(s) URL on the app's own loopback origin (an in-app route
 *   opened with target="_blank", e.g. the Plaid Link page from Settings).
 *   Forwarding it to the OS browser strands it outside the Electron session;
 *   denying it makes the link a dead click. The right outcome is an Electron
 *   child window, which shares this window's session partition (cookies).
 * - "deny": everything else (file:, javascript:, custom schemes, unparseable).
 */
export function classifyWindowOpenUrl(
  url: string,
  ownOrigins?: string[]
): "external" | "own" | "deny" {
  if (isExternalUrlAllowed(url, ownOrigins)) return "external";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "deny";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "deny";
  const hostname = parsed.hostname.toLowerCase();
  const own =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    (ownOrigins?.some((o) => o.toLowerCase() === hostname) ?? false);
  return own ? "own" : "deny";
}
