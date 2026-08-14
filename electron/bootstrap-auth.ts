/**
 * Packaged-app trust boundary (#35, task 14) — pure helpers for the Electron
 * main process's silent window auth. Intentionally free of any `electron`
 * import (no `app`, no `safeStorage`) so it is unit-testable under vitest's
 * plain Node environment, and it lives under `electron/` so it compiles with
 * electron/tsconfig.json (rootDir ".") rather than being pulled out of reach
 * by that rootDir constraint.
 *
 * COOKIE-NAME DRIFT NOTE: the canonical cookie names live in
 * `lib/auth/cookies.ts` (SESSION_COOKIE / CSRF_COOKIE), but the Electron
 * tsconfig's `rootDir: "."` + `include: ["*.ts"]` cannot cleanly import from
 * `../lib`. So the two name strings are duplicated here ONCE, and
 * `tests/api/desktop-bootstrap.test.ts` asserts these equal the lib values —
 * any drift fails that test.
 */

/** Session cookie name — MUST equal SESSION_COOKIE in lib/auth/cookies.ts. */
export const SESSION_COOKIE_NAME = "vgs_session";
/** CSRF cookie name — MUST equal CSRF_COOKIE in lib/auth/cookies.ts. */
export const CSRF_COOKIE_NAME = "vgs_csrf";

/**
 * OS-keychain secret key under which the Electron-main service credential is
 * stored (via `loadOrCreateSecret` in settings-store.ts). Shared so the
 * generate/load call site can't typo-drift from any future reader.
 */
export const ELECTRON_SERVICE_CRED_KEY = "electronServiceCred";

/** Env var name the credential is injected into the child server as. */
export const ELECTRON_SERVICE_CRED_ENV = "ELECTRON_SERVICE_CRED";

/**
 * OS-keychain secret key under which the app PASSWORD HASH is stored (task 15,
 * via `setEncryptedSecret`/`getEncryptedSecret` in settings-store.ts). Kept
 * with the other secret constants so the provisioning, change, and injection
 * call sites can't typo-drift.
 */
export const APP_PASSWORD_HASH_KEY = "appPasswordHash";

/** Env var name the password hash is injected into the child server as — read
 * by app/api/auth/login/route.ts as `process.env.APP_PASSWORD_HASH`. */
export const APP_PASSWORD_HASH_ENV = "APP_PASSWORD_HASH";

/** Shape of the `/api/auth/desktop-bootstrap` JSON response we consume. */
export interface BootstrapResponse {
  success?: boolean;
  data?: { session?: string; csrf?: string };
  error?: string;
}

/** Argument object for `webContents.session.cookies.set(...)`. */
export interface CookieSetArg {
  url: string;
  name: string;
  value: string;
  httpOnly: boolean;
}

/**
 * Turns a desktop-bootstrap response into the exact pair of
 * `session.cookies.set(...)` arguments to install on the window partition:
 * the httpOnly session cookie and the JS-readable CSRF cookie, both scoped to
 * the loopback server URL. Throws if the response is missing either token —
 * installing a half-populated cookie pair would bounce the window to /login.
 */
export function buildBootstrapCookieArgs(port: number, boot: BootstrapResponse): CookieSetArg[] {
  const session = boot?.data?.session;
  const csrf = boot?.data?.csrf;
  if (!session || !csrf) {
    throw new Error(
      "desktop-bootstrap response missing session/csrf — cannot install window cookies",
    );
  }
  const url = `http://localhost:${port}`;
  return [
    { url, name: SESSION_COOKIE_NAME, value: session, httpOnly: true },
    { url, name: CSRF_COOKIE_NAME, value: csrf, httpOnly: false },
  ];
}
