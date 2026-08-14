// Packaged-app trust boundary (#35, task 7) — open-redirect guard for the
// login page's `?next=` query param. After a successful login, the browser
// just received a freshly-minted session cookie; blindly honoring `?next=`
// would let a crafted login link (`/login?next=https://evil.com`) hand that
// authenticated context to an attacker-controlled page. Only a same-origin
// relative path is safe to redirect to — everything else falls back to the
// default landing route.

/** Where an unqualified (or unsafe) `?next=` falls back to. */
export const DEFAULT_LOGIN_REDIRECT = "/dashboard/today";

/**
 * Returns `next` unchanged if it is a safe same-origin relative path, else
 * `DEFAULT_LOGIN_REDIRECT`. "Safe" means:
 *   - starts with exactly one `/` (rules out `evil.com`, `javascript:…`,
 *     and any absolute URL — `http://…`/`https://…`/anything else all lack
 *     a leading `/`)
 *   - is not `//…` (protocol-relative — the browser resolves this against
 *     the CURRENT protocol but an attacker-controlled host)
 *   - is not `/\…` (a backslash right after the leading slash — several
 *     browsers normalize a leading `\` the same as `/`, making this an
 *     equivalent protocol-relative bypass of the `//` check above)
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next) return DEFAULT_LOGIN_REDIRECT;
  if (!next.startsWith("/")) return DEFAULT_LOGIN_REDIRECT;
  if (next.startsWith("//") || next.startsWith("/\\")) return DEFAULT_LOGIN_REDIRECT;
  return next;
}
