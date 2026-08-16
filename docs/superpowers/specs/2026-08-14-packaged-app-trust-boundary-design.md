# Packaged-App Trust Boundary — Design Spec

**Issue:** #35 (P0, Security). **Date:** 2026-08-14. **Status:** Draft for review.

**Authors:** Claude Code + Codex (converged design; three review rounds — full
critique, transport-agnostic reframe, final lock).

---

## 1. Problem

The packaged Electron app starts the standalone Next.js server (Next 16.1.6)
with a hardcoded `HOSTNAME=0.0.0.0` (`electron/main.ts:149`), port 3099. The
desktop window loads `http://localhost:3099`. There is **no** request-level
trust boundary of any kind:

- No `middleware.ts` / `proxy.ts` anywhere; no CORS; no origin/host/IP check;
  no session or cookie.
- Only **10 of ~112** route files check anything, all via an `X-Cron-Secret`
  header (in two divergent dialects — 6 use `timingSafeEqual`→401, 4 use a
  plain `!==`→403).
- The documented trust model is literally *"No authentication.
  Tailscale/Cloudflare Mesh is the access control layer"*
  (`docs/plans/2026-04-15-cloudflare-saas-rewrite.md:160`).

**Verified live (2026-08-14):** the packaged app listens on a wildcard
interface (not loopback), and an unauthenticated request from a non-loopback
same-network client succeeded. So today a device on the same network segment as
this laptop can reach the API with no credential. (Specific interface/probe
details and the current OS-firewall state are recorded in a private runbook, not
this committed spec — see finding #11 rationale in §8.)

### Capability exposure (unauthenticated, today)

- **Destroy data** — 66 DB-writing routes, 12 `DELETE` routes.
  `DELETE /api/import?batchId=N` in a loop unwinds every import ever committed
  (`app/api/import/route.ts:234`); notes ("sacred", no external backup) are
  freely mutable.
- **Broker control** — `POST /api/tws/connect` takes attacker-chosen
  `host`/`port`/`clientId` with no allowlist (an SSRF/port-scan primitive,
  `app/api/tws/connect/route.ts:6` → `lib/tws/client.ts:88`) and kicks off the
  write-heavy sync pipeline. **No order path exists** — nothing can place or
  cancel a trade (verified: zero `placeOrder`/`cancelOrder` in the tree).
- **Spend money** — `/api/chat` is unbounded Opus with 27 tools and no rate
  limit; ~19 paid-AI routes are open.
- **Send email as you** — `/api/digest/email`, `/api/earnings/email`,
  `/api/calendar/email` accept a caller-supplied `to` (and attacker-authored
  footer text) and send from the verified `myportfoliodesk.com` domain.
- **Read everything** — `/api/tax-report` returns the full Form 8949 with cost
  basis; `/api/summary` confirms the host is this app in one request.

### Two facts that shrink the fix

1. **Loopback-only breaks nothing except the phone.** The launchd cron fleet
   calls `localhost` exclusively (`scripts/send-*.sh`, `scripts/run-*.sh`); the
   Cloudflare Worker's "call the Mac first" step is documented dead in practice
   (mesh CGNAT is unreachable from CF's edge → CF-1016 every tick; the whole
   fallback/marker architecture is built around that failure —
   `docs/reference/cron-and-workers.md:108`). The **only** caller that needs a
   non-loopback bind is the iPhone/iPad over the mesh — which authenticates
   with nothing.
2. **The QA sandbox already binds loopback** (`qa/sandbox.sh` pins
   `HOSTNAME=127.0.0.1`), and `withCronAuth` (`lib/cron/wrappers.ts:25`,
   constant-time, fail-closed on missing secret) is a working helper to build
   on. This is not greenfield process design — it's applying an existing
   pattern the codebase already trusts.

---

## 2. Decision: trust model

Per issue #35's required choice between *loopback-only* and *deliberate remote
access behind an authenticated, origin-checked boundary*, we choose the
**authenticated remote-access boundary**, implemented as:

> **The Next server binds to loopback only, permanently. All remote (phone)
> access is delivered through a named Cloudflare Tunnel to a stable HTTPS
> hostname, gated at the edge by Cloudflare Access, and independently
> authenticated by the app's own session boundary.**

### Why not the user's initial instinct (auth on the current http mesh URL)

The user's first framing — keep the existing plaintext-http mesh URL, add a
session on top — is shippable but was **explicitly relaxed by the user** once the tradeoff was
clear. It is the wrong end state:

- The mesh is **plaintext http**, so the session cookie cannot be `Secure`, is
  replayable on-path, and **passkeys/WebAuthn are impossible** (they require a
  secure context). The user wants passkey/Face-ID eventually; only HTTPS
  unblocks it.
- "Add auth on http now, swap to HTTPS later" is **not** free work saved: the
  swap forces a re-login (host-only cookie on a new hostname), a Plaid
  `redirect_uri` re-registration, and new Origin/Host allowlist values
  regardless. Building the boundary twice buys nothing over building it once on
  the right transport.

The app-auth boundary is otherwise **transport-agnostic**; choosing HTTPS from
day one costs only the Cloudflare tunnel/Access setup (the "named tunnel" work
already deferred in the backlog) and a one-time phone URL change.

### Non-goals honored (from #35)

- **No opportunistic auth rewrite** — the boundary is one `proxy.ts` + a
  session lib + a route-classification allowlist, not a per-route rewrite.
- **No weakening of cron secrets or broker controls** — `X-Cron-Secret` stays
  exactly as strong and is *not* promoted to a universal human credential.
- **No treating obscurity / port / firewall as authentication** — the firewall
  is at most interim containment; the app enforces its own session.

---

## 3. Rollout shape (user decision, 2026-08-14)

The design is written as Phase 0 (containment) + Phase 1 (real fix). **The user
elected NOT to ship Phase 0 early**, to avoid the phone going dark during the
build. Therefore:

- **The loopback bind lands atomically at the Phase 1 cutover**, together with
  the tunnel + Access + session boundary, so the iPhone is never dark.
- **Accepted risk:** the verified LAN/mesh exposure (§1) persists for the
  duration of the Phase 1 build. This is a deliberate, user-signed-off
  acceptance for a single-user machine.
- **Optional interim mitigation** the user may enable at any time without code:
  turn on the macOS application firewall (see the private runbook for its
  current state) or physically avoid untrusted networks. This is containment,
  **not** part of the security claim.

If the user later reverses this call, Phase 0 (§4) is a minutes-scale change
that can ship independently and immediately.

---

## 4. Phase 0 — containment (specified, ships only if user opts in early)

Independent, reversible, minutes-scale. Closes the P0 without any tunnel work.

1. **Bind loopback on every start path.** Electron: change the injected
   `HOSTNAME` from `"0.0.0.0"` to `"127.0.0.1"` (`electron/main.ts:149`). Dev:
   `npm run dev` and `npm start` bind broadly today (no `-H`); change the
   scripts to `next dev -H 127.0.0.1` / `next start -H 127.0.0.1`. (The QA
   sandbox already does this.)
2. **Retire the Plaid quick-tunnel** while exposed (it publishes the whole dev
   server to a public `*.trycloudflare.com` URL with no auth).
3. **Verify:** from another LAN client, `http://<mac-lan-ip>:3099` is
   connection-refused; the Electron dashboard, Electron TWS auto-connect, and
   each launchd cron still succeed on `localhost`.
4. **Accept:** iPhone mesh access and mesh Pushover deep links are unavailable
   until Phase 1.

Because the user chose to defer this, Phase 0's loopback bind is folded into the
Phase 1 cutover (step P1-8) rather than shipped alone.

---

## 5. Phase 1 — the authenticated remote-access boundary

### 5.1 Components

**A. Session store (new).** DB-backed opaque sessions — *not* a stateless
signed cookie (rejected in review: a signed cookie over any transport is a
bearer token with no per-device revocation; on phone loss the only recourse is
"rotate the key, log everyone out").

- New migration `079_app_sessions.sql`: table `app_sessions` — `token_hash`
  (SHA-256 of a random 256-bit token; the raw token lives only in the cookie,
  never in the DB), `created_at`, `last_seen_at`, `expires_at` (absolute),
  `label`/device metadata, `csrf_secret`. **`UNIQUE` index on `token_hash`**;
  index on `expires_at` for cleanup sweeps.
- Reads/writes follow the DI convention: `lib/queries/sessions.ts` +
  `lib/mutations/sessions.ts`, every fn takes `db: Database.Database`.
- Idle expiry (sliding `last_seen_at`) **and** absolute `expires_at`.
- **`last_seen_at` write throttling (required):** the dashboard polls
  `/api/tws/sync-status` and other GETs on short intervals; writing
  `last_seen_at` on every request would contend with imports/crons on the
  single WAL writer. Update `last_seen_at` at most once per N minutes
  (proposed 5) via a **conditional `UPDATE … WHERE last_seen_at < now - window`**
  (not a read-then-write) so concurrent requests can't each fire a write and
  defeat the throttle.
- **Cleanup:** a bounded delete of `expires_at < now` runs opportunistically
  (e.g. on login and on the existing 30-min refresh tick), not per-request.
- **Revocation:** delete-by-id ("this device"), delete-all ("log out
  everywhere", also invoked atomically on password change), surfaced in
  Settings. Revocation takes effect on the next request (the proxy verifies the
  session row exists and is unexpired every time — no stateless grace window).

**B. Password credential (new).** Single-user password, **slow-hashed**
(scrypt via `node:crypto`, per-user random salt) — stored as a hash via
Electron `safeStorage` (OS keychain-backed), *not* plain `settings.json`
(the settings store is unencrypted JSON — a known weakness we must not extend to
the password hash). Threaded to the server env like the other secrets in
`main.ts`.

- **Provisioning / reset:** set only through a local/Electron first-run flow
  (native dialog before the server trusts remote clients) — **never** an
  unauthenticated remote `set-password` endpoint. The change transaction is:
  Electron main writes the new hash to `safeStorage` → **revokes all sessions**
  (server-owned: Electron calls a loopback bootstrap endpoint, or the change
  triggers a child-server restart which runs the delete-all) → the restarted/
  reconfigured server picks up the new hash from its env → Electron re-runs
  `desktop-bootstrap` to re-mint the desktop session. Because the hash lives in
  the child server's env, a running server cannot hot-swap it without a
  restart/reconfigure — the transaction MUST restart the child (or reconfigure
  via the bootstrap channel) so a stale hash can never keep validating logins.
- **Login throttling:** behind the Cloudflare Tunnel every request's transport
  source is the local `cloudflared` process, so per-source-IP throttling is
  meaningless. Use a **global** fixed-window throttle on `/api/auth/login`
  (single-user app — one legitimate human), with an exponential lockout after
  repeated failures. Do **not** key the throttle on any client-supplied or
  CF-forwarded header.
- Passkeys are the Phase 2 fast-follow once the HTTPS origin is live.

**B2. Convenience PIN (P1 — user decision 2026-08-14).** After a full-password
login establishes a session on a device, the user may set a shorter numeric PIN
for quick re-unlock on that same device. The PIN is **not** a second password:
it only re-activates an *existing, non-expired* session on the *same device*
(e.g. after a foreground/short-idle lock) — it never creates a session from cold
and never works without a prior full-password login on that device. Store a
slow-hashed PIN bound to the session/device row; rate-limit + lock out after a
few failures (fall back to full password). It is a UX veneer over the session,
so it inherits the session's revocation (revoke device → PIN dead). Do not
weaken the CSRF/session model for it.

**C. Login surface + CSRF lifecycle (new).** `app/login/page.tsx` +
`POST /api/auth/login` (verify password → create session → set session cookie →
set CSRF cookie) and `POST /api/auth/logout`. `/login` and its POST are the
**only** public app surfaces.

- **CSRF mechanism: double-submit token** (chosen over a pure synchronizer
  token specifically because of client integration — see below). On login the
  server sets a **second, non-`HttpOnly` cookie** `vgs_csrf` bound to the
  session's `csrf_secret`. Every unsafe human-session request
  (`POST/PUT/PATCH/DELETE`) must echo it in an `X-CSRF-Token` header; the proxy
  verifies header == cookie == the session's bound secret. Service-credential
  requests are exempt (no cookie, not CSRF-reachable). The token survives page
  reload (it's a cookie the client re-reads), closing the "issued once, lost on
  reload" gap.
- **Client integration (mandatory, single wrapper).** The dashboard has ~171
  direct `fetch` call sites; they cannot each be hand-edited safely. Introduce
  one `lib/http/apiFetch.ts` wrapper that reads `vgs_csrf` and attaches the
  header on unsafe methods, and **migrate every mutating `fetch` call site to
  it**. The guard is an **ESLint (AST) rule**, not a grep — a grep for
  `fetch("/api/…")` misses the many template-literal (`` fetch(`/api/…`) ``) and
  variable-endpoint (`fetch(action.apiEndpoint)`) call sites that already exist.
  The rule forbids a raw `fetch`/unsafe-method call in client code (`app/**`
  client components) outside `apiFetch`, with an explicit small allowlist.
  Read-only GET fetches may stay as raw `fetch` but are encouraged to adopt the
  wrapper for uniformity.

**C2. Electron desktop silent auth (new — two distinct needs, do not conflate).**

**Constraint (why a bootstrap protocol is required):** Electron main **cannot**
open the SQLite session store itself — this repo deliberately runs
`better-sqlite3` only in the system-Node child server (Electron/Node ABI
mismatch; see `findSystemNode` in `electron/main.ts` and the `npmRebuild:false`
note in CLAUDE.md). Electron main also runs *before* migration 079 has created
`app_sessions`. So the **server** owns all session minting, after migrations.

1. **The renderer window** loading `/dashboard/*` needs a *human session
   cookie*. Flow: Electron main waits for the child server to be healthy (it
   already polls `/api/tws/status` at startup), then calls a **one-shot loopback
   bootstrap endpoint** `POST /api/auth/desktop-bootstrap`, authenticated by the
   Electron-main service credential (§F.3) and reachable **only** on loopback.
   The server (post-migration, owning the DB) mints a `desktop`-labeled session
   + CSRF secret and returns the raw session token + `vgs_csrf` value. Electron
   installs both on the window partition with
   `mainWindow.webContents.session.cookies.set()` before/at `loadURL`. So the
   desktop never shows `/login`. The endpoint is idempotent-safe (reuses a live
   desktop session if present) and is on the service allowlist for that
   credential only.
2. **The main process's own Node `fetch`** calls to `/api/tws/status` and
   `/api/tws/connect` (`electron/main.ts:324,332`) do **not** carry that cookie
   jar. They authenticate with the **Electron-main service credential** (§F.3)
   via header, and those two `(method,pathname)` pairs are on the service
   allowlist for that credential only.

**Startup ordering (explicit):** Electron main (a) ensures the app password is
provisioned via the native first-run flow (§B) — writing the hash to
`safeStorage`; (b) generates/loads the Electron-main service credential from
`safeStorage`; (c) spawns the child server with the credential + password hash
in its env; (d) waits for health + migrations; (e) calls `desktop-bootstrap`;
(f) loads the window. The server refuses all non-loopback traffic until the
password hash is present (fails closed).

**D. Session cookie.** `HttpOnly`, `Secure`, **host-only** (no `Domain`
attribute), **`SameSite=Lax`** (not Strict — Plaid's interactive OAuth return is
a cross-site top-level navigation back to `/dashboard/plaid-link`, which Strict
would strip the cookie from; the double-submit CSRF token covers the subsequent
writes). Note `Secure` is honored on the HTTPS phone origin and on `localhost`
(treated as secure by browsers), so the desktop window's `http://localhost`
cookie install still works.

**E. `proxy.ts` — the single choke point (new, root).** Next 16.1.6 uses the
`proxy` file convention (verified: `PROXY_FILENAME='proxy'`; `middleware.ts` is
deprecated and errors if both exist). Runs before filesystem routes incl. App
Router route handlers.

- **Matcher covers everything except a narrow immutable-asset set** — the
  matcher must not leave a gap. Exempt **only** verified immutable static assets
  (`/_next/static/*`, `/favicon.ico`, and other build-hashed files) — **not** a
  blanket `/_next/*`, which would also exempt framework *dynamic* endpoints
  (RSC/data payloads for protected pages) and let them bypass the choke point.
  Everything else is matched and classified inside. A path-only positive matcher
  for just `/api/*` + `/dashboard/*` would leave `/` and any *future* top-level
  route unprotected — that gap is the risk. The route-classification contract
  test (§5.2) is the safety net: it enumerates every route and **fails CI for
  any unclassified non-exempt route**, so a new route cannot silently land
  outside the boundary.
- **Default-deny, `(method, pathname)`-specific.** A request passes iff it
  presents **either** a valid human session cookie + matching CSRF (on unsafe
  methods) **or** a valid service credential for a route+method on the service
  allowlist (see F). Service authorization is keyed on the *(method, pathname)*
  pair, not path alone — so adding a new method to an existing service route
  does not silently inherit service access. Else: `/api/*` → 401 (JSON
  envelope), everything else → 302 redirect to `/login`.
- **Public exceptions:** `/login`, `POST /api/auth/login`, and static assets
  only.
- **`/dashboard/plaid-link` stays authenticated** — it mints/exchanges Plaid
  tokens; it is *not* a carve-out.
- **Ignore Cloudflare Access headers as app auth.** `proxy.ts` must NOT treat
  `Cf-Access-Jwt-Assertion` / `Cf-Access-Authenticated-User-Email` as identity
  (local Electron/launchd requests legitimately lack them). Access is the outer
  reachability/device gate only; the app enforces its own session. No
  Access-JWT verification in-app for P1 (avoids a second identity dependency).
- **State-changing GETs are a CSRF hole — audit and eliminate.** Because the
  cookie is `SameSite=Lax`, the browser *sends it on cross-site top-level GET
  navigations*, and the design only applies CSRF/Origin checks to unsafe
  methods. Any GET route that WRITES is therefore CSRF-reachable. Known
  offenders: `GET /api/security/[id]/regression` (writes via
  `upsertRegression`) and `GET /api/earnings/cockpit` (writes via
  `ensureIntelForEvents`). Remediation: **audit every GET handler for writes**;
  convert each state-changing GET to POST behind `apiFetch` (or gate its write
  behind an idempotent, side-effect-free read path). Add a contract test that
  **forbids a GET route from performing a mutation**. This audit is a required
  part of the route-classification pass (§5.2 step 1).
- **Host + Origin enforcement — two distinct sets.** Maintain a canonical
  **Host** allowlist (host[:port] form: `localhost:3099`, `127.0.0.1:3099`, the
  dev/start ports `localhost:3000`/`127.0.0.1:3000`, and the named HTTPS
  hostname) and a separate **Origin** allowlist (full `scheme://host[:port]`
  form: `http://localhost:3099`, `http://127.0.0.1:3099`, the dev-port
  equivalents, and `https://app.myportfoliodesk.com`). Reject a request whose `Host`
  is not allowlisted. On mutating cookie-session methods, require an exact
  `Origin` match to the Origin allowlist — never derived from `Host` or
  forwarded headers. The dev/start ports are included so `npm run dev` (port
  3000) and `next start` don't break the boundary during development.

**F. Credential separation — service-route allowlist.** Three distinct
credential types, never conflated:

1. **Human session cookie** — desktop window + phone. Required on all
   `/dashboard/*` and all non-service `/api/*`.
2. **Cron/service secret (`X-Cron-Secret`)** — valid **only** on an explicit
   allowlist of service routes (the existing `/api/cron/*` + the four
   enrich/reconcile routes). Consolidate all 10 onto `withCronAuth` (kills the
   `!==`/403 dialect drift). **Never** accepted as a human credential on any
   other route.
3. **Electron-main service credential (new)** — a distinct secret for the
   Electron main process's *own* Node-`fetch` calls to `/api/tws/status` and
   `/api/tws/connect` (`electron/main.ts:324,332`). **Critical:** the main
   process's `fetch` does not carry the renderer window's cookie jar, so a
   window-only cookie would 401 these calls and silently break TWS
   auto-connect. This credential authorizes exactly those two `(method,
   pathname)` service entries and nothing else.
   - **Generation:** high-entropy (256-bit `randomBytes`) minted by Electron
     main on first run.
   - **Storage:** Electron `safeStorage` (OS keychain-backed), never plain
     `settings.json`. **Guard `safeStorage.isEncryptionAvailable()`** before
     read/write; if the keychain is unavailable (locked/unsupported), **fail
     closed** — do not silently fall back to plaintext or to an unauthenticated
     server. Surface a clear error to the user. The same guard applies to the
     password hash (§B).
   - **Isolation:** injected only into the child-server process env; **never**
     exposed through `preload`/`get-settings`/the renderer. It must not appear
     in the masked or unmasked settings surface.
   - **Rotation:** the credential lives in the *already-spawned* child's env, so
     rotation **cannot hot-swap it** — regeneration writes the new value to
     `safeStorage` and **restarts (or reconfigures) the child server** so it
     picks up the new env, then Electron re-runs `desktop-bootstrap`. No
     external consumer depends on the value. Startup fails closed if the
     credential is missing/blank (mirrors `withCronAuth`'s missing-secret →
     500).

Dual-purpose routes (e.g. `/api/calendar/enrich`, which claims a manual-UI
action but currently always requires the cron header) are **split** into a
human route (session) and a service route (secret), or the handler explicitly
authorizes either role.

**G. Route-level hardening (defense-in-depth, independent of auth).** Auth
limits *who* can call these; it does not reduce blast radius after session
theft or a mistaken trusted-device enrollment:

- **`tws/connect`** — hard-allowlist `host`/`port` (configured TWS /
  loopback only); reject anything else before `connectTws`.
- **Import-undo** — require a short-lived explicit confirmation challenge +
  rate-limit. Before the destructive delete, write a **batch-bound recovery
  manifest** — not just "the rows". The manifest is a single atomically-written
  JSON file under `data/undo-recovery/<batchId>-<timestamp>.json` (`data/` is
  gitignored — it must **never** enter the repo and carries the same local-only
  sensitivity as the DB), containing: all batch-owned source rows across every
  table the batch wrote; the `import_batches` metadata row; the raw imported
  input (or a path/hash reference to it); and a checksum over the payload.
  Atomic write = temp file + `rename`. Retain last N manifests, prune older.
  **Restoration semantics must be specified and tested:** a restore re-inserts
  exactly the manifested rows and preserves the statement-authoritative invariant
  (statement-sourced rows win over live rows — restoration must not resurrect a
  superseded live row over a statement row). The E2E must prove: undo → manifest
  is complete + checksum valid → **restore reproduces the pre-undo state** →
  re-import of the same source is idempotent (deterministic `source_key`, no
  duplicate rows).
- **Email routes** — recipients from a stored allowlist; caller-supplied `to`
  needs a deliberate override flow; rate-limit sends.
- **`/api/chat`** — per-session concurrent-stream, request-size, tool-step,
  and daily token/cost budget with cooldown.

**H. Transport / edge (ops, not code).**

- Reserve `app.myportfoliodesk.com` (user decision 2026-08-14); named Cloudflare
  Tunnel → `http://127.0.0.1:3099`; Cloudflare Access deny-by-default in front. Record
  the exact tunnel config (ingress rule, upstream, and whether cloudflared
  rewrites/preserves the `Host` header) in the private runbook. **The proxy's
  Host allowlist must match whatever Host cloudflared forwards** — pin and test
  this, don't assume.
- Register the exact HTTPS Plaid `redirect_uri` in the Plaid dashboard; set
  `plaidRedirectUri` (threaded via `PLAID_REDIRECT_URI`,
  `electron/main.ts:192`).
- Repoint `pushoverLinkBase` (→ `PUSHOVER_LINK_BASE`, `electron/main.ts:171`)
  from the mesh IP to `app.myportfoliodesk.com`.
- **Daily Plaid sync is unaffected** — it is outbound server→Plaid
  (`app/api/plaid/sync/route.ts`); only Link-token creation and the browser
  OAuth resume use the redirect URI/hostname.

**H2. Worker parity (explicit — the earlier "Worker unchanged" claim was too
loose).** Two Worker-side items DO need attention even though no Worker→Mac call
*succeeds* today:

- **`MESH_HOSTNAME` (primary call targets — there are TWO):** the Worker POSTs
  to the Mac from **both** `workers/cron/src/primary.ts:26` (briefing/digest/
  evening) **and** `workers/cron/src/calendar-enrich.ts:63` (calendar enrich).
  Both already fail to the retired CGNAT and fall back. Decision: **retire the
  primary call in both files** (remove the `MESH_HOSTNAME` primary POST + its
  default), so the Worker never attempts an ingress path that is now permanently
  loopback-only and Access-gated. **Retain the marker re-check before fallback**
  in each (that's what prevents duplicate sends). Do **not** point the Worker at
  the new Access-protected hostname — the Worker has no Access identity and would
  be denied at the edge; keep it fallback-only. Test asserts **immediate
  fallback** (not "expect a network failure then fall back").
- **Worker `PUSHOVER_LINK_BASE` (its own secret):** the Worker composes its own
  Pushover deep links. Update this Worker secret to `app.myportfoliodesk.com` in lockstep
  with the Mac's `pushoverLinkBase` — this is a Mac↔Worker parity surface;
  change both or the phone gets a dead link from cloud-sent pushes.

### 5.2 Build order (TDD, strict dependency order)

The proxy affects every route, so build and verify inside-out, loopback-only,
before any edge exposure:

1. **Route-classification contract test** — enumerate every route as
   `public` / `human` / `service` / `dual`, keyed on `(method, pathname)`; the
   test **fails for any unclassified non-static route** so new routes can't
   silently land unprotected.
2. Session store (migration 079 + queries/mutations, throttled `last_seen`,
   cleanup, revocation) — RED→GREEN.
3. Login/logout + double-submit CSRF cookie issuance + verification.
4. **Client CSRF wrapper (`lib/http/apiFetch.ts`) + migrate all mutating
   fetch call sites** + the grep/lint guard test. Do this *before* the proxy
   starts rejecting CSRF-less writes, so the UI never ships broken.
5. Service-credential tests (`withCronAuth` consolidation onto all 10 routes;
   split dual-purpose routes; Electron-main credential — generation/storage/
   isolation).
6. `proxy.ts` matcher + default-deny + `(method,pathname)` service authz +
   Host/Origin tests (use Next's proxy-match test utility to prove coverage
   incl. `/api` variants, prefetch, and that no non-static route escapes).
7. **Electron desktop session bootstrap + main-process credential
   propagation** — the highest-risk step; prove (a) the window loads
   `/dashboard` authenticated via the installed cookie, and (b) the main-process
   TWS fetches authenticate via the service credential without the renderer
   cookie. First-run password provisioning ordering verified here.
8. Route-level hardening (G) with their own tests (incl. import-undo recovery
   artifact + re-import idempotence).
9. Transport/edge config (H) + Worker parity (H2).
10. **Atomic cutover:** flip `HOSTNAME` to `127.0.0.1` on all start paths,
    enable the Access policy + tunnel hostname, repoint Plaid/Pushover (Mac +
    Worker in lockstep). The Next server is loopback-only from here
    **permanently**.
11. Packaged-app E2E + the negative-test matrix (§6).

### 5.3 The invariant (never relaxed)

**The Next server never listens on a non-loopback interface again.** Mobile
access is restored only via the Access-protected HTTPS tunnel to
`127.0.0.1:3099`. There is no condition under which loopback-only is "lifted."

---

## 6. Mandatory pre-merge negative-test matrix

| Test case | Expected result |
|---|---|
| LAN client → `http://<mac-ip>:3099` | Connection refused |
| Separately started dev server, hit from LAN | Connection refused |
| Electron window → localhost dashboard | Loads; silent desktop auth works |
| Electron main auto-connect (Node fetch) | Service-cred call succeeds; no renderer-cookie dependency |
| Launchd cron with valid cron secret | Its allowlisted cron route succeeds |
| Cron secret on a non-service (human) route | 401 — secret grants nothing there |
| Missing/blank service secret configured | Fails closed; config error, handler never runs |
| Worker primary during/after cutover | Network failure → fallback; no direct Mac ingress |
| External client without Access | Denied at the Access edge; cannot reach the app |
| Access-approved client, no app session | `/dashboard/*` → login redirect; `/api/*` → 401 |
| Access headers present but no app session | Still denied; headers alone grant nothing |
| Valid session + missing/untrusted Origin on a write | Rejected; DB unchanged |
| Valid session, unsafe method, **missing or wrong `X-CSRF-Token`** | Rejected; DB unchanged |
| CSRF token retrieval **after a page reload** | Client re-reads `vgs_csrf` cookie; next write succeeds |
| Every mutating client `fetch` routes through `apiFetch` | Grep/lint guard passes; no raw unsafe `fetch("/api/…")` remains |
| Revoked / lost-device session | Dashboard + API access immediately denied |
| **Password change** | All existing sessions revoked; old cookie now 401s |
| **PIN re-unlock** on a device with a live session | Succeeds; PIN never creates a session from cold; PIN dead after device revoke; lockout after N failures falls back to password |
| Electron **bootstrap ordering** — server up + migrated → `desktop-bootstrap` → cookie install | Window loads `/dashboard` authenticated with no `/login` bounce; bootstrap only reachable on loopback with the service credential |
| First-run **password provisioning** (native flow) | Server does not serve remote clients until set; no remote set-password route exists |
| **Password change** transaction | Hash updated in safeStorage; child restarts/reconfigures; all sessions revoked; desktop re-bootstrapped; old cookie 401s |
| **safeStorage unavailable** (keychain locked/unsupported) | Fails closed — no plaintext fallback, no unauthenticated server; clear error surfaced |
| Service-credential **rotation** | New value written; child restarts; new cred works, old cred 401s; desktop re-bootstrapped |
| Migration 079 **fresh install + upgrade from 078** | Both reach the same schema; unique `token_hash` + `expires_at` indexes present |
| Session **expiry** (idle + absolute) | Expired session denied; `last_seen` conditional-update throttle honored (no per-request write) |
| **State-changing GET audit** | No GET route performs a mutation; regression + cockpit writes are POST behind `apiFetch`; contract test forbids mutating GETs |
| **Dynamic `apiFetch` call sites** (template-literal + variable endpoints) | ESLint AST rule catches raw unsafe `fetch` in client code; every mutating call carries CSRF |
| **Both** Worker primary calls removed (primary.ts + calendar-enrich.ts) | Worker takes immediate fallback with marker re-check; no `MESH_HOSTNAME` POST attempted |
| **UI mutation audit** — import preview/commit/undo, notes, levels, settings writes | All carry CSRF and succeed authenticated; all 401 unauthenticated |
| Import-undo **manifest + restoration** | Manifest complete + checksum valid; restore reproduces pre-undo state preserving statement authority; re-import idempotent |
| Plaid OAuth return to the named hostname | Lax session reaches authenticated `/dashboard/plaid-link`; resume succeeds |

---

## 7. Impacted-path inventory

- **New:** `proxy.ts`; `app/login/page.tsx`;
  `app/api/auth/{login,logout,desktop-bootstrap}/route.ts` (desktop-bootstrap is
  loopback + service-credential only); `lib/auth/*` (session issue/verify,
  password hash via safeStorage, double-submit CSRF); `lib/http/apiFetch.ts`
  (client wrapper) + an ESLint AST rule forbidding raw unsafe client `fetch`;
  `lib/queries/sessions.ts`; `lib/mutations/sessions.ts`; migration
  `079_app_sessions.sql`.
- **Changed:** `electron/main.ts` (HOSTNAME→loopback; Electron-main service-cred
  gen/inject; desktop session mint + cookie install before `loadURL`);
  `electron/settings-store.ts` (password hash + service cred via `safeStorage`,
  kept OUT of the masked/unmasked settings surface); `electron/ipc-handlers.ts`
  + `electron/preload.ts` (first-run password set; no exposure of the new
  secrets); `package.json` dev/start scripts (`-H 127.0.0.1`); **all mutating
  client fetch call sites** → `apiFetch`; the 4 enrich/reconcile routes
  (consolidate onto `withCronAuth`, split dual-purpose); `app/api/tws/connect`,
  `app/api/import`, the 3 email routes, `app/api/chat` (route hardening);
  `app/api/security/[id]/regression` + `app/api/earnings/cockpit` +
  any others found by the GET-write audit (state-changing GET → POST behind
  `apiFetch`).
- **Worker parity (change required — see H2):** retire the Worker→Mac primary
  call in **both** `workers/cron/src/primary.ts` **and**
  `workers/cron/src/calendar-enrich.ts` (keep fallback-only + marker re-check),
  and update the Worker's `PUSHOVER_LINK_BASE` secret to `app.myportfoliodesk.com` in
  lockstep with the Mac. The Worker's own `/internal/*` secret check is
  untouched. Confirm no other mirror drift before merge.
- **Docs:** update `docs/reference/cron-and-workers.md`,
  `docs/reference/ui-structure.md` (retire the "binds 0.0.0.0 / mesh IP"
  statements), `CLAUDE.md` API-pattern section, and the `.env.local` Plaid
  runbook (quick-tunnel → named hostname).

---

## 8. Resolved decisions (user, 2026-08-14)

1. **Login mechanism:** password **plus a convenience PIN** (§B2) — not
   password-only. PIN re-unlocks an existing same-device session only; passkeys
   remain the Phase 2 fast-follow.
2. **Password provisioning/reset:** first-run Electron flow **only**; no remote
   reset in P1 (§B).
3. **Session lifetimes:** 30-day absolute, 7-day idle, 5-min `last_seen`
   conditional-update throttle (§A).
4. **Interim containment:** **accept the open LAN window as-is** during the
   build — no firewall stopgap, no early Phase 0 (§3). Loopback bind lands at
   cutover.
5. **Named hostname:** **`app.myportfoliodesk.com`** — feeds the Plaid
   `redirect_uri`, the Host/Origin allowlists, and both Pushover link bases
   (§E, §H).

### Codex review resolutions (2026-08-14)

**Two independent Codex read-only review passes.** Pass 1 (REVISE, 11 findings)
and Pass 2 (verification, REVISE — judged whether each pass-1 fix was *sound*,
not merely present; caught deeper feasibility issues + a new vuln). All accepted
and folded in. Pass-2 additions: server-owned **loopback bootstrap protocol**
because Electron main can't open `better-sqlite3` (ABI) and runs before
migration 079 (§C2); **ESLint AST rule** instead of grep for the `apiFetch`
guard (§C); narrow immutable-asset matcher exemption, not blanket `/_next/*`
(§E); **state-changing GET → POST** audit incl. `regression` + `cockpit`, new
CSRF vuln (§E, §6); `safeStorage.isEncryptionAvailable()` fail-closed + rotation
requires child restart (§B, §F.3); **both** Worker primary call sites retired,
not just `primary.ts` (§H2); conditional-update `last_seen` throttle (§A);
password-change restart/revoke transaction (§B); import-undo **manifest +
restoration** semantics preserving statement authority (§G).

Pass-1 findings, all folded in: Electron desktop session vs
main-process credential separated (§C2, F.3); double-submit CSRF token with a
mandatory `apiFetch` wrapper over all ~171 mutating call sites (§C, §5.2 step 4);
separate Host/Origin allowlists incl. dev port 3000 (§E); `(method,pathname)`
service authz + no-route-escapes-the-matcher contract test (§E, §5.2 step 1);
Electron-main credential generation/storage(`safeStorage`)/rotation/isolation
(§F.3); tunnel Host-forwarding pinned + Worker primary retire + Worker
`PUSHOVER_LINK_BASE` parity (§H, §H2); migration 079 indexes/cleanup/`last_seen`
throttle (§A); password-change-revokes-all + global login throttle behind the
tunnel (§B); import-undo recovery artifact + re-import idempotence (§G, §6);
expanded negative-test matrix (§6).

- **Finding #11 rationale (privacy of this committed doc):** the live probe
  specifics, exact interface, mesh IP, and firewall state were generalized in
  §1 and moved to a private runbook, since this repo is MIT-licensed with
  scrubbed history and may be public — a committed spec should not double as an
  attack roadmap. The security substance is unchanged. (The mesh IP already
  appears in `docs/reference/*`; a follow-up may scrub those too, out of scope
  here.)
