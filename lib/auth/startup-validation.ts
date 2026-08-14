// Packaged-app trust boundary (#35, task 18) — boot-time fail-fast validation
// of the service credentials the proxy enforces. Pure logic (no HTTP, no db,
// no process.exit): instrumentation.ts calls this at server startup; the test
// drives it directly. This is defense-in-depth — request-time fail-closed in
// decideRequest already blocks any bypass, but a blank secret means the cron
// and electron service routes can never be called at all, so we surface the
// misconfiguration loudly the moment the server boots rather than at 2 AM when
// a cron silently 401s.

export interface ServiceSecretConfig {
  cronSecret: string | undefined;
  electronCred: string | undefined;
}

/**
 * Returns the names of any service secret that is blank/undefined (whitespace
 * counts as blank — a space is not a configured secret). Empty array = all set.
 */
export function findBlankServiceSecrets(cfg: ServiceSecretConfig): string[] {
  const missing: string[] = [];
  if (!cfg.cronSecret || cfg.cronSecret.trim().length === 0) {
    missing.push("CRON_SHARED_SECRET");
  }
  if (!cfg.electronCred || cfg.electronCred.trim().length === 0) {
    missing.push("ELECTRON_SERVICE_CRED");
  }
  return missing;
}

export interface AssertOptions {
  /** When true, throw (refuse to start) if any secret is blank; otherwise only
   * log. Production boot passes true; dev (npm run dev) passes false so a
   * developer's un-provisioned .env.local doesn't crash the dev server. */
  throwOnBlank: boolean;
  /** Injected for tests; defaults to console.error. */
  logError?: (msg: string) => void;
}

/**
 * Fail-fast check invoked at server boot. Logs a loud error listing any blank
 * service secret; when `throwOnBlank`, throws so the process refuses to start
 * misconfigured. Returns the list of blank secret names (empty = healthy) so a
 * caller/test can assert without relying on the throw. Never touches a
 * non-blank secret's value.
 */
export function assertServiceSecretsConfigured(
  cfg: ServiceSecretConfig,
  opts: AssertOptions
): string[] {
  const missing = findBlankServiceSecrets(cfg);
  if (missing.length > 0) {
    const log = opts.logError ?? ((m: string) => console.error(m));
    const msg =
      `[trust-boundary] FATAL: blank service secret(s): ${missing.join(", ")}. ` +
      `The proxy (#35) fails these routes CLOSED, so the affected cron/electron ` +
      `service routes cannot be called until every secret is set. Configure them ` +
      `before enabling remote access.`;
    log(msg);
    if (opts.throwOnBlank) {
      throw new Error(msg);
    }
  }
  return missing;
}
