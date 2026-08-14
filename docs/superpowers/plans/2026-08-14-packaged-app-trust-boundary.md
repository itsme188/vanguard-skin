# Packaged-App Trust Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the packaged app behind a real authentication boundary — the Next server binds loopback-only, all remote (phone) access comes through a named Cloudflare Tunnel + Access, and every request is authorized by the app's own DB-backed session or an explicit, credential-kind-specific service credential.

**Architecture:** One root `proxy.ts` is the single choke point (default-deny; passes a request only with a valid session cookie + CSRF, or the *correct kind* of service credential for an allowlisted route+method). Sessions are opaque, DB-backed, revocable. Electron authenticates its window via a server-owned loopback bootstrap (Electron can't open `better-sqlite3` itself) and its main-process fetches via a dedicated service credential. **The proxy is activated LAST in Phase A** — after the CSRF client wrapper, service-route consolidation, and Electron auth all exist and are green — so enforcement never precedes the things that satisfy it.

**Tech Stack:** Next.js 16.1.6 (`proxy.ts`, Node runtime — no route-segment `runtime` config allowed in proxy), better-sqlite3 (WAL, DI, singleton exported as `db` from `@/lib/db`), Electron (`safeStorage`), `node:crypto` (scrypt, randomBytes, timingSafeEqual), Vitest (**Node environment — no jsdom**), ESLint flat config (`eslint.config.mjs`), Cloudflare Tunnel + Access.

**Spec:** `docs/superpowers/specs/2026-08-14-packaged-app-trust-boundary-design.md` — read it alongside this plan.

## Global Constraints

- **Node pin:** prefix `PATH=/opt/homebrew/opt/node@24/bin:$PATH` on every `npx vitest` / `npx tsx` / `next build` / `eslint` command.
- **Full suite is 4,959+ tests.** Run `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run` before any commit touching shared code; report pass/fail; never commit red.
- **DB access:** the singleton is `import { db } from "@/lib/db"` (NOT `getDb()`). Lib functions take `db: Database.Database` (DI); tests use `:memory:` + `runMigrations(db)` (exists in `lib/db/migrate.ts`).
- **Route envelope:** `{success:true,data}` / `{success:false,error}`. Thin routes; logic in `lib/`.
- **Vitest is Node-env** — no `document`/`window`. Client-side helpers must take injectable dependencies (e.g. a cookie-reader fn) so they're testable without jsdom.
- **ESLint is flat config** (`eslint.config.mjs`); a custom rule is registered as an inline plugin object, not via `--rulesdir`.
- **Mac↔Worker mirrors are parity-pinned** — Phase D Worker changes land with their Mac counterparts.
- **Decisions (2026-08-14):** hostname `app.myportfoliodesk.com`; sessions 30-day absolute / 7-day idle / 5-min `last_seen` throttle; login = password + convenience PIN; password set/reset first-run Electron only, no remote reset; LAN window stays open during the build (loopback bind flips only at Phase D cutover).
- **Secrets never enter the repo** — password hash, Electron-main service credential, and session material live in `safeStorage` / child-server env / the DB, never in committed files or the masked/unmasked settings surface.
- **Commit style:** message to a temp file, `git commit -F <file>` (never inline `-m`). Branch `security/packaged-app-trust-boundary` off `main` before Task 1.

**Two credential kinds (do not conflate):**
- **CRON secret** (`X-Cron-Secret`, env `CRON_SHARED_SECRET`) — valid only on the 10 cron/enrich service routes.
- **Electron-main credential** (`X-Electron-Cred`, env `ELECTRON_SERVICE_CRED`) — valid only on `(GET,/api/tws/status)`, `(POST,/api/tws/connect)`, `(POST,/api/auth/desktop-bootstrap)`.
Each service route accepts exactly one kind. Neither is ever accepted on a human route.

---

## Phase A — Core auth boundary (proxy activated LAST)

### Task 1: Session store (migration 079 + queries + mutations)

**Files:** Create `lib/db/migrations/079_app_sessions.sql`, `lib/queries/sessions.ts`, `lib/mutations/sessions.ts`; Test `tests/queries/sessions.test.ts`.

**Interfaces — Produces:**
- `createSession(db, { label }, nowMs): { rawToken, csrfToken, id }` — 256-bit token; stores only its SHA-256; returns raw token + csrf once.
- `verifySession(db, rawToken, nowMs): { id, csrfSecret, label } | null` — side-effect-free; enforces absolute + idle expiry.
- `touchSession(db, id, nowMs, throttleMs)` — conditional `UPDATE … WHERE last_seen_at < now-throttle`.
- `revokeSession(db, id)`, `revokeAllSessions(db)`.
- `cleanupExpiredSessions(db, nowMs, limit=500): number` — bounded `DELETE … WHERE id IN (SELECT id … WHERE expires_at < ? LIMIT ?)`.
- Exported consts: `ABSOLUTE_MS`, `IDLE_WINDOW_MS`.

- [ ] **Step 1: Migration**

```sql
-- lib/db/migrations/079_app_sessions.sql
CREATE TABLE IF NOT EXISTS app_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash    TEXT NOT NULL,
  csrf_secret   TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT 'device',
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_sessions_token ON app_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_app_sessions_expires ON app_sessions(expires_at);
```

- [ ] **Step 2: Failing test** — cover: verify fresh / reject bad token; reject after absolute (>30d) and idle (>7d untouched); `touchSession` slides idle but the conditional UPDATE is a no-op inside the throttle window; revoke one / revoke all; `cleanupExpiredSessions` deletes only expired and respects the LIMIT; **migration upgrade test** — run migrations on a db seeded at 078, assert `idx_app_sessions_token` exists (`PRAGMA index_list`).

```typescript
// tests/queries/sessions.test.ts  (key cases; full file expands each)
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { createSession, touchSession, revokeAllSessions, cleanupExpiredSessions } from "@/lib/mutations/sessions";
import { verifySession } from "@/lib/queries/sessions";
const T0 = Date.parse("2026-08-14T12:00:00Z"); const DAY = 86_400_000;
const fresh = () => { const d = new Database(":memory:"); runMigrations(d); return d; };

it("verify + expiry", () => {
  const db = fresh(); const { rawToken } = createSession(db, { label: "phone" }, T0);
  expect(verifySession(db, rawToken, T0)!.label).toBe("phone");
  expect(verifySession(db, rawToken, T0 + 31*DAY)).toBeNull();          // absolute
  const { rawToken: t2 } = createSession(db, { label: "phone" }, T0);
  expect(verifySession(db, t2, T0 + 8*DAY)).toBeNull();                 // idle
});
it("touch throttle is a no-op inside the window", () => {
  const db = fresh(); const { rawToken, id } = createSession(db, { label: "x" }, T0);
  touchSession(db, id, T0 + 60_000, 5*60_000);                          // 1min < 5min throttle
  const row: any = db.prepare("SELECT last_seen_at FROM app_sessions WHERE id=?").get(id);
  expect(Date.parse(row.last_seen_at)).toBe(T0);                        // unchanged
});
it("cleanup respects LIMIT and only removes expired", () => {
  const db = fresh(); createSession(db, { label: "a" }, T0 - 40*DAY); createSession(db, { label: "b" }, T0);
  expect(cleanupExpiredSessions(db, T0, 500)).toBe(1);
});
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** mutations + queries (scrypt not needed here; use `randomBytes`/`createHash`; `cleanupExpiredSessions` uses a `LIMIT` subquery; `verifySession` checks `expires_at <= now` and `last_seen_at + IDLE_WINDOW_MS <= now`).
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit** `feat(auth): DB-backed opaque session store (migration 079)`.

---

### Task 2: Auth crypto — password/PIN hashing + CSRF match

**Files:** Create `lib/auth/credentials.ts`, `lib/auth/csrf.ts`; Test `tests/auth/credentials.test.ts`.

**Interfaces — Produces:** `hashPassword(plain): string` (`scrypt$salt$hash`), `verifyPassword(plain, stored): boolean` (constant-time), `hashPin`/`verifyPin`, `csrfMatches(header, cookie, sessionSecret): boolean` (all three equal, constant-time, empty never passes).

- [ ] **Step 1: Failing test** — password round-trip; wrong rejected; distinct salts; csrf triple-equality + empty-fails. (Node env — no DOM needed.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** with `node:crypto` `scryptSync` (N=16384,r=8,p=1) + `timingSafeEqual`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(auth): scrypt password/PIN + double-submit CSRF check`.

---

### Task 3: Route-policy manifest (credential-kind-specific) + seeded GET-write audit

**Files:** Create `lib/auth/route-policy.ts`; Test `tests/auth/route-policy.test.ts`.

**Interfaces — Produces:**
- `type RouteClass = "public" | "human" | "cron" | "electron"` (service split by credential kind).
- `classifyRoute(method, pathname): RouteClass` — default `"human"`; explicit `public`, `cron`, `electron` sets keyed on `(method, pathname)`.
- `isImmutableAsset(pathname): boolean` — `/_next/static/*`, `/favicon.ico`, `/robots.txt` only (NOT blanket `/_next/*`).
- `GET_WRITE_OFFENDERS: string[]` — **seeded** with the audit findings (`GET /api/security/[id]/regression`, `GET /api/earnings/cockpit`, + any others found); Task 5 empties it.
- `listRouteHandlers(): {method,pathname}[]` — enumerates `app/api/**/route.ts` via `fs` recursion (NOT `fast-glob`, which is undeclared), parsing exported HTTP verbs, mapping `[param]`→`[param]`.

- [ ] **Step 1: Failing test**

```typescript
// tests/auth/route-policy.test.ts
import { classifyRoute, isImmutableAsset, GET_WRITE_OFFENDERS, listRouteHandlers } from "@/lib/auth/route-policy";
it("classifies by kind", () => {
  expect(classifyRoute("POST", "/api/auth/login")).toBe("public");
  expect(classifyRoute("POST", "/api/cron/digest")).toBe("cron");
  expect(classifyRoute("POST", "/api/tws/connect")).toBe("electron");
  expect(classifyRoute("DELETE", "/api/import")).toBe("human");
});
it("only immutable assets are exempt", () => {
  expect(isImmutableAsset("/_next/static/x.js")).toBe(true);
  expect(isImmutableAsset("/_next/data/b/dashboard.json")).toBe(false);
});
it("every route handler is classifiable (no escapes)", () => {
  const handlers = listRouteHandlers();
  expect(handlers.length).toBeGreaterThan(100);
  for (const h of handlers) expect(["public","human","cron","electron"]).toContain(classifyRoute(h.method, h.pathname));
});
it("GET-write offenders are seeded (audit gate — emptied in Task 5)", () => {
  expect(GET_WRITE_OFFENDERS).toContain("GET /api/security/[id]/regression");
  expect(GET_WRITE_OFFENDERS).toContain("GET /api/earnings/cockpit");
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** with separate `PUBLIC`, `CRON`, `ELECTRON` sets; `listRouteHandlers` via `fs.readdirSync` recursion over `app/api`, reading each `route.ts` for `export (async )?function (GET|POST|...)`. **Do the GET-write audit** (grep each GET handler for write calls: `.run(`, `insert/update/delete/upsert`, `ensure*`) and seed every offender into `GET_WRITE_OFFENDERS`; record the full list in the commit body.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(auth): route-policy manifest (credential-kind) + seeded GET-write audit`.

---

### Task 4: Consolidate the 10 service routes onto `withCronAuth`; split dual-purpose `/api/calendar/enrich`

**Files:** Modify the 4 `!==`-dialect routes (`calendar/enrich`, `calendar/reconcile-cloud-enrich`, `levels/reconcile-cloud-fired`, `research/reconcile-cloud-fetched`) to use `withCronAuth` (`lib/cron/wrappers.ts`); split `/api/calendar/enrich` so the manual-UI action is a human route and the cron action stays service. Test `tests/api/service-auth-consolidation.test.ts`.

**Interfaces — Consumes:** `withCronAuth` (existing). **Produces:** all 10 service routes reject on missing/blank secret with a 500 config-error (not silent) and 401 on mismatch; `/api/calendar/enrich` has a human-callable path (session) + a service path (cron secret).

- [ ] **Step 1: Failing test** — each of the 4 routes: missing `CRON_SHARED_SECRET` → 500; wrong secret → 401; correct → handler runs. `/api/calendar/enrich` human path: valid session (mock) → runs without the cron secret.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — wrap the 4 routes in `withCronAuth`; extract the enrich logic into `lib/calendar/…` (already lib-resident) and expose a human entrypoint the UI route calls (the proxy will supply session auth in Task 18; here just stop *requiring* the cron secret on the human path).
- [ ] **Step 4: Run → PASS** + full suite green (touches shared routes).
- [ ] **Step 5: Commit** `refactor(auth): consolidate service routes onto withCronAuth; split calendar/enrich`.

---

### Task 5: State-changing GET → POST (close the SameSite=Lax GET-CSRF hole)

**Files:** Modify `app/api/security/[id]/regression/route.ts`, `app/api/earnings/cockpit/route.ts` (+ any others seeded in Task 3): move the write off the GET path (GET stays a pure read; the write becomes a POST, or the enrich runs on cron/interval). Modify their client callers to POST via `apiFetch` (added Task 8 — until then a plain POST is fine; re-point to `apiFetch` in the matching Task 9–12 batch). Modify `lib/auth/route-policy.ts` to remove each offender from `GET_WRITE_OFFENDERS`. Test `tests/api/no-state-changing-get.test.ts`.

**Interfaces — Produces:** `GET_WRITE_OFFENDERS` ends `[]`; a contract test asserting no GET handler contains a write call.

- [ ] **Step 1: Failing test** — assert `GET_WRITE_OFFENDERS` is `[]` AND a static scan of every GET handler body finds no write call. (Fails now — offenders seeded.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Migrate each** — split read/write; empty the denylist entry-by-entry.
- [ ] **Step 4: Run → PASS**; manual check regression card + cockpit still populate; full suite green.
- [ ] **Step 5: Commit** `fix(security): state-changing GET routes → POST (Lax GET-CSRF hole)`.

---

### Task 6: Login / logout routes + config-driven Secure cookie + global throttle

**Files:** Create `app/api/auth/login/route.ts`, `app/api/auth/logout/route.ts`, `lib/auth/cookies.ts`, `lib/auth/throttle.ts`; Test `tests/api/auth-login.test.ts`.

**Interfaces — Consumes:** `verifyPassword`, `createSession`, `revokeSession`. **Produces:** `handleLogin(db, {password}, {secure}, nowMs): LoginResult`; cookie names `vgs_session`(HttpOnly)/`vgs_csrf`(readable); global fixed-window throttle. **Cookie `Secure` comes from config** (`process.env.APP_COOKIE_SECURE !== "0"`, default true — NOT derived from `req.url`, because cloudflared's HTTP upstream would wrongly read http; Electron's Chromium honors Secure on `localhost`).

- [ ] **Step 1: Failing test** — correct password → 200 sets both cookies; wrong → 401 no cookies; missing `APP_PASSWORD_HASH` → 500; throttle: N failures → 429. Use the DI `handleLogin` (no HTTP).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — `handleLogin` reads `process.env.APP_PASSWORD_HASH`; `POST` route imports `{ db } from "@/lib/db"`, computes `secure` from config, appends `Set-Cookie`. `logout`: `verifySession`→`revokeSession`, clear both cookies (Max-Age=0). `lib/auth/cookies.ts` exports names + attr builders (host-only, `SameSite=Lax`, `Secure` from arg). `lib/auth/throttle.ts` global counter.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(auth): login/logout + CSRF cookies + global throttle + config Secure`.

---

### Task 7: Login page UI + post-login redirect

**Files:** Create `app/login/page.tsx` (client form: password field → `POST /api/auth/login` → on 200 redirect to `?next` or `/dashboard/today`; on 401 show error). Test: component test if jsdom is added, else a route-level redirect test + a manual smoke step.

**Interfaces — Consumes:** `POST /api/auth/login`. **Produces:** the only public page; the target of the proxy's `redirectLogin`.

- [ ] **Step 1: Failing test** — a small integration test hitting `handleLogin` already covers auth; add a test asserting `/login` is classified `public` (via `classifyRoute("GET","/login")`).
- [ ] **Step 2: Run → FAIL** (page missing / classification).
- [ ] **Step 3: Implement** the page (plain form, `apiFetch` not required for login — it's the bootstrap; use raw `fetch` with an eslint-disable + reason).
- [ ] **Step 4: Run → PASS**; manual: unauthenticated `/dashboard` (after Task 18) bounces here and login returns to the app.
- [ ] **Step 5: Commit** `feat(auth): login page + post-login redirect`.

---

### Task 8: `apiFetch` wrapper (injectable cookie reader) + ESLint flat-config rule

**Files:** Create `lib/http/apiFetch.ts`, `eslint-rules/no-raw-api-fetch.js` (an inline plugin object referenced from `eslint.config.mjs`); Modify `eslint.config.mjs`; Test `tests/http/apiFetch.test.ts`.

**Interfaces — Produces:** `apiFetch(input, init?)` — for unsafe methods sets `X-CSRF-Token` from an **injectable cookie reader** (default reads `document.cookie`, but the reader is a parameter/module-swappable export so the Node-env test needs no jsdom).

- [ ] **Step 1: Failing test** (Node-env safe — inject the cookie reader)

```typescript
// tests/http/apiFetch.test.ts
import { vi } from "vitest";
import { makeApiFetch } from "@/lib/http/apiFetch";
it("adds CSRF on POST, not GET", async () => {
  const fetchMock = vi.fn(async () => new Response("{}"));
  const apiFetch = makeApiFetch(() => "TOKEN123", fetchMock as any);
  await apiFetch("/api/import", { method: "POST" });
  expect(new Headers((fetchMock.mock.calls[0][1] as any).headers).get("X-CSRF-Token")).toBe("TOKEN123");
  await apiFetch("/api/summary");
  expect(new Headers((fetchMock.mock.calls[1][1] as any).headers).get("X-CSRF-Token")).toBeNull();
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `makeApiFetch(readCsrf, fetchImpl)` returning the wrapper; export a default `apiFetch` bound to a `document.cookie` reader + global `fetch`. Add the ESLint rule as an inline plugin in `eslint.config.mjs` (flat config: `{ plugins: { local: { rules: { "no-raw-api-fetch": rule } } }, rules: { "local/no-raw-api-fetch": "error" } }`), scoped to `app/**` client files; the rule flags a `fetch` CallExpression with an unsafe `method` or an `/api/` first-arg that isn't provably GET.
- [ ] **Step 4: Run test → PASS**; `eslint app/` reports the (currently many) violations — expected, cleared in Tasks 9–12.
- [ ] **Step 5: Commit** `feat(auth): apiFetch CSRF wrapper (injectable) + eslint flat-config guard`.

---

### Tasks 9–12: Migrate mutating fetch call sites to `apiFetch` (feature-area batches)

Split so each batch is independently reviewable and the ESLint rule goes green area-by-area. Each task: replace `fetch(` → `apiFetch(` (with import) at that area's mutating call sites, run `eslint app/<area>` clean, run a focused UI smoke of that area, commit.

- [ ] **Task 9 — Imports + Notes + Settings:** `ImportFlow.tsx`, `ImportHistory.tsx`, `EarningsEmailsSection.tsx`, settings writers, notes writers. Commit `refactor(auth): route imports/notes/settings writes through apiFetch`.
- [ ] **Task 10 — TWS + Data confidence:** `TwsStatus.tsx`, `DataConfidenceIndicator.tsx`, `TrustStripDrawer.tsx`. Commit `refactor(auth): route TWS/data-confidence writes through apiFetch`.
- [ ] **Task 11 — Calendar + Earnings + Digest email:** `SendDigestPanel.tsx`, cockpit/earnings writers, calendar writers. Commit `refactor(auth): route calendar/earnings/email writes through apiFetch`.
- [ ] **Task 12 — Research + Chat + Analysis + remainder:** `ChatInterface.tsx`, `NarrativeBlock.tsx`, `ClassificationCard.tsx`, `FactorModeCard.tsx`, `WhatIfCalculator.tsx`, `PlaidSyncButton.tsx`, `NotificationBell.tsx`, `CombinedPortfolioChart.tsx`, benchmark sync, etc. After this, `eslint app/` is fully clean. Commit `refactor(auth): route research/chat/analysis writes through apiFetch (eslint guard clean)`.

Each: **Step 1** run `eslint app/<paths>` → violations; **Step 2** migrate; **Step 3** `eslint` clean + full suite green; **Step 4** commit.

---

### Task 13: Electron encrypted-secret accessors + safeStorage fail-closed

**Files:** Modify `electron/settings-store.ts` (add `getEncryptedSecret(key)`/`setEncryptedSecret(key,val)` that use `safeStorage`, stored under keys OUTSIDE `AppSettings` and excluded from the masked + unmasked settings surfaces and IPC `get-settings`). Test `tests/electron/encrypted-secrets.test.ts` (mock `safeStorage`).

**Interfaces — Produces:** `getEncryptedSecret`, `setEncryptedSecret`, `loadOrCreateSecret(key)` (generate 256-bit if absent); all **throw/fail-closed when `safeStorage.isEncryptionAvailable()` is false** — never plaintext fallback.

- [ ] **Step 1: Failing test** — set→get round-trips through a mocked `safeStorage`; when `isEncryptionAvailable()` is false, `loadOrCreateSecret` throws; the secret keys never appear in `getSanitizedSettings()`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**; import `safeStorage` at module scope (not inside a function).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(auth): electron safeStorage secret accessors (fail-closed)`.

---

### Task 14: Desktop-bootstrap route + Electron window silent auth

**Files:** Create `app/api/auth/desktop-bootstrap/route.ts`; Modify `electron/main.ts` (generate/load `ELECTRON_SERVICE_CRED` via Task 13; inject into child env; **create the window without loading**, after health mint a desktop session via bootstrap, install cookies, THEN `loadURL`; add `X-Electron-Cred` to the existing `/api/tws/status` + `/api/tws/connect` fetches). Test `tests/api/desktop-bootstrap.test.ts`.

**Interfaces — Consumes:** `createSession`; the `electron` route class (Task 3). **Produces:** `handleDesktopBootstrap(db, providedCred, nowMs): { status, body }` where `body = { success:true, data:{ session, csrf } }`; mints a **fresh** `desktop` session each launch (we store only the hash, so raw-token reuse is impossible — do not claim reuse); optionally `cleanupExpiredSessions` + prune stale `desktop` rows.

- [ ] **Step 1: Failing test** — valid cred → 200, `data.session` verifies with label `desktop`; wrong cred → 401.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** route (constant-time cred check vs `process.env.ELECTRON_SERVICE_CRED`; loopback-host assert) + Electron wiring:

```typescript
// electron/main.ts (sequence)
const win = new BrowserWindow({ show: false, /* …existing webPreferences… */ });
// after child server health-check:
const boot = await fetch(`http://localhost:${PORT}/api/auth/desktop-bootstrap`, {
  method: "POST", headers: { "X-Electron-Cred": electronCred },
}).then(r => r.json());
await win.webContents.session.cookies.set({ url: `http://localhost:${PORT}`, name: "vgs_session", value: boot.data.session, httpOnly: true });
await win.webContents.session.cookies.set({ url: `http://localhost:${PORT}`, name: "vgs_csrf", value: boot.data.csrf });
await win.loadURL(`http://localhost:${PORT}/dashboard/today`);
win.show();
```

Add `headers: { "X-Electron-Cred": electronCred }` to the auto-connect fetches at `electron/main.ts:324,332`.

- [ ] **Step 4: Run test → PASS**; manual Electron check: window loads authenticated, no `/login` bounce, TWS auto-connect works.
- [ ] **Step 5: Commit** `feat(auth): desktop-bootstrap + Electron silent window auth`.

---

### Task 15: Password provisioning (first-run native) + password-change transaction

**Files:** Modify `electron/main.ts` + `electron/ipc-handlers.ts` + `electron/preload.ts` (first-run native password dialog when no `APP_PASSWORD_HASH`; a Settings "change password" IPC). Test `tests/electron/password-flow.test.ts` (unit the transaction pieces: hash write, revoke-all, restart signal).

**Interfaces — Produces:** first-run flow writes the scrypt hash to `safeStorage` **before** the child server is spawned; password change = write new hash → `revokeAllSessions(db)` → restart/reconfigure child (so the new hash is picked up from env) → re-run desktop-bootstrap. **No remote reset route exists.**

- [ ] **Step 1: Failing test** — the change transaction calls revoke-all and triggers a restart; verify order (revoke before restart) via a spy harness on the transaction fn.
- [ ] **Step 2: Run → FAIL.** → **Step 3: Implement.** → **Step 4: PASS** + manual first-run + change smoke. → **Step 5: Commit** `feat(auth): first-run password provisioning + change-password revoke/restart`.

---

### Task 16: Convenience PIN (set + re-unlock + lockout)

**Files:** Create `app/api/auth/pin/route.ts` (set/verify), extend `app_sessions` usage (PIN hash bound to the device session — add a `pin_hash` column via migration `080_session_pin.sql`, or a `session_pins` table). Client PIN entry UI in the login/lock surface. Test `tests/api/pin.test.ts`.

**Interfaces — Produces:** PIN set requires an active full-password session; PIN verify re-activates an existing non-expired same-device session only (never creates one cold); lockout after N failures → fall back to password; PIN dies on device revoke (it's bound to the session row).

- [ ] **Step 1: Failing test** — set PIN needs a live session; verify re-unlocks; wrong PIN N times → locked → requires password; revoke session → PIN no longer works.
- [ ] **Step 2: Run → FAIL.** → **Step 3: Implement** (migration `080` + hashPin/verifyPin + route). → **Step 4: PASS.** → **Step 5: Commit** `feat(auth): convenience PIN re-unlock bound to device session`.

---

### Task 17: Credential + secret rotation (restart-aware)

**Files:** Modify `electron` (Settings actions to rotate `ELECTRON_SERVICE_CRED`); `app/api/auth/…` as needed. Test `tests/electron/rotation.test.ts`.

**Interfaces — Produces:** rotation writes the new value to `safeStorage`, restarts the child server (env can't hot-swap), re-runs desktop-bootstrap; old credential 401s afterward.

- [ ] **Step 1: Failing test** — rotation fn writes new secret + signals restart; a request with the old cred fails, new cred passes (unit the decision with both values).
- [ ] **Step 2 → 5:** FAIL → implement → PASS → commit `feat(auth): electron credential rotation (restart-aware)`.

---

### Task 18: `decideRequest` (credential-kind-specific) + activate `proxy.ts`  ← ENFORCEMENT FLIP

**Files:** Create `lib/auth/verify-request.ts`, `proxy.ts` (root); Test `tests/auth/verify-request.test.ts` + a matcher test. **This is the enforcement flip — it lands only after Tasks 1–17 are green**, so the CSRF wrapper, service consolidation, and Electron auth already satisfy it.

**Interfaces — Produces:** `decideRequest(db, ctx, nowMs): { action: "allow"|"deny401"|"redirectLogin"; touchId? }`. `ctx` carries method, pathname, host, cookies, headers (origin, x-csrf-token, x-cron-secret, x-electron-cred), the Host/Origin allowlists, and **both** service secrets. Uses `classifyRoute` kind to pick which credential to check — cron routes accept ONLY the cron secret, electron routes ONLY the electron cred.

- [ ] **Step 1: Failing test** — valid-session GET allow / no-cookie deny; write needs Origin + matching CSRF; **cron secret on an electron route → deny**, **electron cred on a cron route → deny**, each on its own route → allow; cron secret on a human route → deny; bad Host → deny; unauth `/dashboard` → redirectLogin; **missing/blank configured secret → deny (fail-closed)** and a separate startup-validation test that the server refuses to treat a blank secret as valid.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `decideRequest` (kind-specific credential check via `classifyRoute`) and `proxy.ts`:

```typescript
// proxy.ts (root) — Next 16 proxy runs on Node; do NOT add `export const runtime`.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decideRequest, type RequestCtx } from "@/lib/auth/verify-request";
import { touchSession } from "@/lib/mutations/sessions";
export const config = { matcher: ["/((?!_next/static|favicon.ico|robots.txt).*)"] };
export default function proxy(req: NextRequest) {
  const url = new URL(req.url);
  const hostname = process.env.APP_PUBLIC_HOSTNAME || "app.myportfoliodesk.com";
  const ctx: RequestCtx = {
    method: req.method, pathname: url.pathname, host: req.headers.get("host") ?? "",
    cookies: Object.fromEntries(req.cookies.getAll().map(c => [c.name, c.value])),
    headers: {
      origin: req.headers.get("origin") ?? undefined,
      "x-csrf-token": req.headers.get("x-csrf-token") ?? undefined,
      "x-cron-secret": req.headers.get("x-cron-secret") ?? undefined,
      "x-electron-cred": req.headers.get("x-electron-cred") ?? undefined,
    },
    hosts: new Set([`localhost:3099`,`127.0.0.1:3099`,`localhost:3000`,`127.0.0.1:3000`,hostname]),
    origins: new Set(["http://localhost:3099","http://127.0.0.1:3099","http://localhost:3000","http://127.0.0.1:3000",`https://${hostname}`]),
    cronSecret: process.env.CRON_SHARED_SECRET || "",
    electronCred: process.env.ELECTRON_SERVICE_CRED || "",
  };
  const d = decideRequest(db, ctx, Date.now());
  if (d.action === "allow") { if (d.touchId) touchSession(db, d.touchId, Date.now(), 5*60_000); return NextResponse.next(); }
  if (d.action === "redirectLogin") return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.json({ success:false, error:"unauthorized" }, { status:401 });
}
```

`decideRequest` uses empty-secret guard: if a request presents a service credential but the configured secret is empty, deny (fail-closed) — and add a server startup validation (in an existing init path) that logs/refuses a blank `CRON_SHARED_SECRET`/`ELECTRON_SERVICE_CRED` when a service route is reachable.

- [ ] **Step 4: Run tests → PASS**; matcher test asserts `/`, `/dashboard/x`, `/api/y` matched and `/_next/static/z` not; full suite + `next build` green; manual: desktop still loads, phone (still on mesh pre-cutover) still works with a login.
- [ ] **Step 5: Commit** `feat(auth): activate proxy.ts choke point (default-deny, kind-specific service auth)`.

---

## Phase B — Route-level hardening (one task each)

### Task 19: `tws/connect` host/port allowlist
Modify `lib/tws/client.ts` (`assertAllowedTwsTarget(host,port)`) + the connect route. Test: loopback/configured host allowed, arbitrary rejected. RED→GREEN→commit.

### Task 20: Import-undo confirmation + recovery manifest + restore
Modify `app/api/import/route.ts` + `lib/mutations/import-batches.ts`. Confirmation token param; write a batch-bound manifest (all batch-owned rows across every table it wrote + `import_batches` metadata + raw input ref + checksum) atomically to `data/undo-recovery/<batchId>-<ts>.json` (gitignored); define + implement restore. Test: undo→manifest complete+checksum valid→restore reproduces pre-undo state preserving statement-authority→re-import idempotent. RED→GREEN→commit.

### Task 21: Email recipient allowlist + rate limit
Modify `digest/email`, `earnings/email`, `calendar/email`. Reject non-allowlisted `to` unless `override:true`; rate-limit sends. Test each. RED→GREEN→commit.

### Task 22: `/api/chat` per-session budget
Modify `app/api/chat/route.ts`. Per-session concurrent-stream + request-size + tool-step + daily token/cost ceiling + cooldown. Test the budget gate. RED→GREEN→commit.

---

## Phase C — Full gate

### Task 23: Negative-test matrix (map every spec §6 row) + full suite + build
Create `tests/auth/boundary-matrix.test.ts` mapping EACH §6 row to a named automated test OR a documented packaged/phone E2E gate (Access-header denial, reload-CSRF success, safeStorage-unavailable, rotation, bootstrap ordering, first-run provisioning, UI-mutation audit, matcher edge cases, both Worker primary removals, revoked-device, expiry, PIN rules, import-undo manifest+restore). Run full suite + `next build`. Commit `test(auth): boundary negative-test matrix mapped to spec §6`.

---

## Phase D — Transport, Worker parity, cutover (loopback flip lands here)

### Task 24: Cloudflare Tunnel + Access (ops; private runbook, no committed secrets)
Reserve `app.myportfoliodesk.com`; named Tunnel → `http://127.0.0.1:3099`; Access deny-by-default. Record ingress + forwarded-Host behavior in the private runbook; ensure the proxy Host allowlist matches the forwarded Host. Register `https://app.myportfoliodesk.com/dashboard/plaid-link` as the Plaid `redirect_uri`; set `plaidRedirectUri`.

### Task 25: Worker parity — retire BOTH primary calls + repoint Pushover base
Modify `workers/cron/src/primary.ts` AND `workers/cron/src/calendar-enrich.ts` (remove the `MESH_HOSTNAME` primary POST + default; keep marker re-check → fallback). Update Worker `PUSHOVER_LINK_BASE` secret → `https://app.myportfoliodesk.com` and Mac `pushoverLinkBase` in lockstep. Test asserts immediate fallback (no primary attempt). RED→GREEN→deploy Worker + update Mac setting→commit `refactor(worker): retire both dead Mac-primary calls; repoint pushover base`.

### Task 26: Cutover — flip HOSTNAME to loopback everywhere + docs + deploy + close #35
Modify `electron/main.ts:149` (`127.0.0.1`), `package.json` (`dev`/`start` add `-H 127.0.0.1`). Update docs (`ui-structure.md`, `cron-and-workers.md`, `CLAUDE.md`, `.env.local` runbook). Verify spec §6 packaged rows (LAN refused; desktop + crons work; phone via tunnel+Access→login→dashboard; Plaid resume; revoked-device). Full suite + `next build` + `npm run electron:deploy`. Commit `feat(security): bind loopback-only; remote access via Cloudflare Tunnel+Access (closes #35)`; update `docs/HANDOFF.md`; close #35 with packaged-app evidence.

---

## Self-Review (author)

- **Spec coverage:** §5.1 A→T1; B→T6/T15; B2→T16; C→T6/T7/T8; C2→T14; D→T6; E→T3/T5/T18; F→T3/T4/T13/T14/T18; G→T19–22; H→T24; H2→T25; §4 Phase-0→T26; §6→T23+T26; migrations 079→T1, 080→T16.
- **Sequencing fix (Codex High):** proxy enforcement is T18, after CSRF wrapper (T8–12), service consolidation (T4), and Electron auth (T13–14) — nothing enforced before it's satisfiable.
- **Factual fixes (Codex):** `db` singleton import (not `getDb`); no `runtime` config in proxy; ESLint flat-config inline plugin (not `--rulesdir`); `listRouteHandlers` via `fs` (not `fast-glob`); `apiFetch` injectable cookie reader (Node-env vitest); `settings-store` gains real encrypted-secret accessors; `Secure` from config not `req.url`; credential-kind-specific service auth; GET-write denylist seeded then emptied; oversized tasks split (fetch migration → T9–12; hardening → T19–22); added tasks for login UI (T7), service consolidation (T4), PIN (T16), password provisioning (T15), rotation (T17).
- **Placeholder scan:** repetitive tasks (T9–12, T19–22) carry exact files + test targets + commit messages; no "TBD".
- **Known follow-ups:** passkeys (post-cutover, HTTPS available); scrub mesh IP from `docs/reference/*` (out of scope).
