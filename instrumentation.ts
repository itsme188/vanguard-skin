import { assertServiceSecretsConfigured } from "@/lib/auth/startup-validation";

// Packaged-app trust boundary (#35, task 18) — Next `register()` runs once at
// server boot (Node runtime). Fail-fast defense-in-depth: the request-time
// proxy already fails service routes CLOSED on a blank secret, but a blank
// CRON_SHARED_SECRET / ELECTRON_SERVICE_CRED means those routes can never be
// called at all — so we surface it at boot, not at the next silent 401.
//
// Production boot REFUSES to start when a secret is blank; `npm run dev` only
// logs, so an un-provisioned local .env.local doesn't crash the dev server.

export function register(): void {
  // Only the Node.js server runtime carries these env vars; skip the edge
  // runtime pass (no service secrets, nothing to validate) defensively.
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;

  assertServiceSecretsConfigured(
    {
      cronSecret: process.env.CRON_SHARED_SECRET,
      electronCred: process.env.ELECTRON_SERVICE_CRED,
    },
    { throwOnBlank: process.env.NODE_ENV === "production" }
  );
}
