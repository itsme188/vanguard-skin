import { CSRF_COOKIE } from "@/lib/auth/cookies";

// Packaged-app trust boundary (#35, task 8) — the ONE client-side wrapper
// allowed to make a mutating `/api/*` call. For unsafe methods (POST/PUT/
// PATCH/DELETE) it attaches the `X-CSRF-Token` header so the double-submit
// check in lib/auth/csrf.ts (csrfMatches) has something to compare against
// the cookie + session secret. The eslint-rules/no-raw-api-fetch.js guard
// (wired in eslint.config.mjs) forbids a raw mutating `fetch(...)` from
// app/** client code, so this wrapper is the only sanctioned path — no
// mutating call site can silently skip the header.
//
// `makeApiFetch` is injectable (cookie reader + fetch impl) so it is
// Node-test safe: Vitest runs in Node with no `document` global, and the
// test never has to touch it. The default `apiFetch` export below binds to
// a real `document.cookie` reader and the global `fetch`, but the binding
// is LAZY — building the wrapper closure doesn't read `document`, only
// actually CALLING the wrapper (and only for an unsafe method) does — so
// importing this module in Node never throws.

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CSRF_HEADER = "X-CSRF-Token";

export type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Builds an apiFetch wrapper from an injectable CSRF-token reader and fetch
 * implementation. `readCsrf` is only invoked for unsafe methods — a GET
 * never touches it (see the "does not set X-CSRF-Token on GET" test, which
 * also asserts the reader is never called).
 */
export function makeApiFetch(readCsrf: () => string, fetchImpl: typeof fetch): ApiFetch {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toString().toUpperCase();
    const headers = new Headers(init?.headers);

    if (UNSAFE_METHODS.has(method)) {
      const token = readCsrf();
      if (token) headers.set(CSRF_HEADER, token);
    }

    return fetchImpl(input, {
      credentials: "same-origin",
      ...init,
      headers,
    });
  };
}

/** Reads a single cookie by name from `document.cookie`. Guarded so a call
 * outside a browser (no `document`) degrades to "" instead of throwing —
 * the module-scope binding below never triggers this path itself; only an
 * actual call to the default `apiFetch` does. */
function readDocumentCookie(name: string): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

/** Default export: real `document.cookie` reader (the `vgs_csrf` cookie,
 * single-sourced from lib/auth/cookies.ts) + the global `fetch`. */
const apiFetch: ApiFetch = makeApiFetch(
  () => readDocumentCookie(CSRF_COOKIE),
  (input, init) => fetch(input, init)
);

export default apiFetch;
