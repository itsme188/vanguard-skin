import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Linter } from "eslint";
import { runMigrations } from "@/lib/db/migrate";
import { createSession, revokeSession } from "@/lib/mutations/sessions";
import { ABSOLUTE_MS, IDLE_WINDOW_MS } from "@/lib/queries/sessions";
import { decideRequest, type RequestCtx } from "@/lib/auth/verify-request";
import { classifyRoute, listRouteHandlers } from "@/lib/auth/route-policy";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/lib/auth/cookies";
import { makeApiFetch } from "@/lib/http/apiFetch";
// eslint-disable-next-line @typescript-eslint/no-var-requires -- CJS rule module, same import shape eslint.config.mjs uses
import noRawApiFetchRule from "../../eslint-rules/no-raw-api-fetch.js";

/**
 * Packaged-app trust boundary (#35) — Task 23 / Phase C gate.
 *
 * This file maps EVERY row of spec §6's mandatory pre-merge negative-test
 * matrix (docs/superpowers/specs/2026-08-14-packaged-app-trust-boundary-design.md,
 * section 6) to either:
 *
 *   (a) an existing test elsewhere in the suite — cited by path, plus a new
 *       light assertion here ONLY where it closes a genuine gap in what that
 *       existing test proves (never a pointless duplicate of a thorough
 *       existing test), or
 *   (b) a brand-new test here, for a row nothing else exercises, or
 *   (c) an `it.todo(...)` under a row's describe block, for anything that
 *       genuinely requires a live packaged Electron app, a real phone, or a
 *       real Cloudflare Access edge — these are NOT faked. Each one explains
 *       exactly what live verification closes it. Some of these are also
 *       blocked on Phase D work (the loopback bind flip + Worker-primary
 *       retirement) that has not landed yet on this branch — those are
 *       labeled PHASE-D-BLOCKED and cannot be tested until that code exists.
 *
 * The 31 describe blocks below are in the exact order of the spec §6 table.
 * A reader can go row-by-row through the spec and find its entry here.
 */

const T0 = Date.parse("2026-08-14T12:00:00Z");

const HOSTS = new Set([
  "localhost:3099",
  "127.0.0.1:3099",
  "localhost:3000",
  "127.0.0.1:3000",
  "app.myportfoliodesk.com",
]);
const ORIGINS = new Set([
  "http://localhost:3099",
  "http://127.0.0.1:3099",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://app.myportfoliodesk.com",
]);
const CRON_SECRET = "cron-secret-value";
const ELECTRON_CRED = "electron-cred-value";
const GOOD_ORIGIN = "http://localhost:3099";
const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * For a row whose entry here is a pure citation (already thoroughly covered
 * elsewhere, no new assertion needed), assert the cited file still exists —
 * a cheap guard against the citation silently rotting if that file is ever
 * renamed or deleted. Vitest also requires every `describe` to contain at
 * least one `it`, so this doubles as that.
 */
function expectCitedTestsExist(paths: string[]): void {
  for (const p of paths) {
    expect(existsSync(path.join(REPO_ROOT, p)), `expected cited coverage file to exist: ${p}`).toBe(true);
  }
}

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function ctx(partial: Partial<RequestCtx> & Pick<RequestCtx, "method" | "pathname">): RequestCtx {
  return {
    host: "localhost:3099",
    cookies: {},
    headers: {},
    hosts: HOSTS,
    origins: ORIGINS,
    cronSecret: CRON_SECRET,
    electronCred: ELECTRON_CRED,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Row 1
// ---------------------------------------------------------------------------
describe("§6 row 1 — LAN client → http://<mac-ip>:3099 → Connection refused", () => {
  it.todo(
    "MANUAL/E2E: the loopback bind flip landed in code 2026-08-14 (Task 26 — " +
      "electron/main.ts's injected HOSTNAME is now \"127.0.0.1\", was \"0.0.0.0\"). Cannot be " +
      "unit-tested: this is a real OS-level TCP bind/refuse behavior, not app logic " +
      "decideRequest can express. Cutover checklist: after the packaged app is rebuilt/" +
      "installed with this change, from a second LAN machine run " +
      "`curl -m 3 http://<mac-lan-ip>:3099/login` and confirm connection refused (not a " +
      "401/redirect — the port must not even accept the TCP connection)."
  );
});

// ---------------------------------------------------------------------------
// Row 2
// ---------------------------------------------------------------------------
describe("§6 row 2 — Separately started dev server, hit from LAN → Connection refused", () => {
  it.todo(
    "MANUAL/E2E: package.json's \"dev\"/\"start\" scripts now pass `-H 127.0.0.1` " +
      "(landed 2026-08-14, Task 26 — were plain `next dev`/`next start`). Same reasoning as " +
      "row 1: a bind behavior, not decideRequest logic. Cutover checklist: run `npm run dev`, " +
      "then from a second LAN machine confirm connection refused on the dev port."
  );
});

// ---------------------------------------------------------------------------
// Row 3
// ---------------------------------------------------------------------------
describe("§6 row 3 — Electron window → localhost dashboard: loads; silent desktop auth works", () => {
  // The credential-gating half (loopback + service-cred required to mint the
  // bootstrap session) IS covered:
  //   tests/api/desktop-bootstrap-route.test.ts — loopback gate + cred check
  //   tests/api/desktop-bootstrap.test.ts — handleDesktopBootstrap + cookie-arg builder
  //   tests/electron/rotation.test.ts — old-cred-401/new-cred-200 through the bootstrap path
  it.todo(
    "MANUAL/E2E: the createWindow()->server-ready->bootstrap POST(retry)->cookie install-> " +
      "loadURL->show sequence lives in electron/main.ts and drives a real BrowserWindow/loadURL " +
      "— no Electron runtime is spun up in this suite (task 14's own report already flagged " +
      "this as needing live manual verify). Cutover checklist: launch the packaged app from a " +
      "cold quit, confirm the window shows /dashboard/today already authenticated with NO " +
      "flash of /login, on both a clean profile and a profile with a stale/invalid cookie."
  );
});

// ---------------------------------------------------------------------------
// Row 4
// ---------------------------------------------------------------------------
describe("§6 row 4 — Electron main auto-connect (Node fetch): service-cred succeeds, no renderer-cookie dependency", () => {
  // COVERED BY: tests/auth/verify-request.test.ts
  //   describe("decideRequest — dual routes") ->
  //   it("allows a dual route with the electron cred alone (no cookie)") — builds ctx with
  //   headers: { "x-electron-cred": ELECTRON_CRED } and cookies: {} (empty), proving the
  //   electron-main auto-connect call (POST /api/tws/connect) succeeds with zero renderer
  //   cookie jar involvement — exactly the auto-connect scenario this row describes.
  it("anchor: POST /api/tws/connect classifies as 'dual' (reachable by electron cred with no session)", () => {
    expect(classifyRoute("POST", "/api/tws/connect")).toBe("dual");
  });
});

// ---------------------------------------------------------------------------
// Row 5
// ---------------------------------------------------------------------------
describe("§6 row 5 — Launchd cron with valid cron secret → its allowlisted cron route succeeds", () => {
  // COVERED BY:
  //   tests/auth/verify-request.test.ts — describe("decideRequest — cron routes") ->
  //     it("allows a cron route with the correct cron secret")
  //   tests/api/service-auth-consolidation.test.ts ->
  //     it("runs the handler when X-Cron-Secret matches")
  it("anchor: all 10 CRON_ROUTES classify as 'cron'", () => {
    const cronRoutes = [
      "POST /api/cron/briefing",
      "POST /api/cron/digest",
      "POST /api/cron/earnings-sweep",
      "POST /api/cron/evening",
      "POST /api/cron/plaid-sync",
      "POST /api/cron/research-sync",
      "POST /api/calendar/enrich",
      "POST /api/calendar/reconcile-cloud-enrich",
      "POST /api/levels/reconcile-cloud-fired",
      "POST /api/research/reconcile-cloud-fetched",
    ];
    for (const key of cronRoutes) {
      const [method, pathname] = key.split(" ");
      expect(classifyRoute(method, pathname)).toBe("cron");
    }
  });
});

// ---------------------------------------------------------------------------
// Row 6
// ---------------------------------------------------------------------------
describe("§6 row 6 — Cron secret on a non-service (human) route → 401", () => {
  // COVERED BY: tests/auth/verify-request.test.ts ->
  //   it("deny401 the cron secret presented on a human route")
  //   it("deny401 the cron secret presented on an electron route")
  //   it("never accepts the cron secret on a dual route")
  // No new assertion — thoroughly covered across every non-cron route kind.
  it("cited coverage file exists", () => {
    expectCitedTestsExist(["tests/auth/verify-request.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Row 7
// ---------------------------------------------------------------------------
describe("§6 row 7 — Missing/blank service secret configured → fails closed; config error, handler never runs", () => {
  // COVERED BY:
  //   tests/auth/verify-request.test.ts — describe("decideRequest — fail-closed on blank
  //     configured secrets") — 3 tests: blank cron secret, blank electron cred (electron-only
  //     route), blank electron cred (dual route) — all deny401 even when the presented value
  //     is also blank (an empty-string == empty-string bypass is explicitly refused).
  //   tests/auth/startup-validation.test.ts — findBlankServiceSecrets / assertServiceSecretsConfigured
  //     — boot-time fail-fast: throws (refuses to start) on a blank secret when a service route
  //     is reachable. This is the "handler never runs" half of the guarantee (defense-in-depth
  //     ahead of the per-request fail-closed check).
  //   tests/api/service-auth-consolidation.test.ts ->
  //     it("returns 500 when CRON_SHARED_SECRET is missing")
  it("cited coverage files exist", () => {
    expectCitedTestsExist([
      "tests/auth/verify-request.test.ts",
      "tests/auth/startup-validation.test.ts",
      "tests/api/service-auth-consolidation.test.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Row 8
// ---------------------------------------------------------------------------
describe("§6 row 8 — Worker primary during/after cutover → network failure → fallback; no direct Mac ingress", () => {
  it.todo(
    "PARTIAL, MANUAL/E2E: the code-level half of this row is DONE — both the Worker-primary " +
      "retirement (2026-08-14, Task 25: workers/cron/src/primary.ts's callPrimary AND " +
      "workers/cron/src/calendar-enrich.ts's own local callEnrichPrimary, which never shared " +
      "callPrimary with primary.ts, are both retired; primary.ts is deleted) AND the loopback " +
      "bind flip (2026-08-14, Task 26: electron/main.ts HOSTNAME=127.0.0.1, package.json dev/" +
      "start -H 127.0.0.1) have landed in code. runJob/runCalendarEnrich now go straight from " +
      "the marker dedup check to fallback, proven by " +
      "workers/cron/test/primary-retirement.test.ts (asserts global.fetch is never called and " +
      "every marker-skip path — mac-sent/cloud-sent/cloud-attempting/mac-running for the email " +
      "path, already-sent-this-slot for calendar-enrich — still short-circuits before fallback " +
      "runs). What remains untested here is the LIVE 'no direct Mac ingress' guarantee, which " +
      "requires the packaged app to actually be rebuilt/installed with the loopback bind (the " +
      "user's cutover step) — the code can no longer ATTEMPT an ingress call, but proving " +
      "nothing CAN REACH the Mac requires the running binary to reflect it. Cutover checklist: " +
      "after the packaged app is rebuilt/installed, kill the Mac's dev server mid-window and " +
      "confirm the Worker takes immediate fallback (already guaranteed by code) with no " +
      "MESH_HOSTNAME POST attempted (check Worker logs for the absence of any fetch to the Mac " +
      "origin)."
  );
});

// ---------------------------------------------------------------------------
// Row 9
// ---------------------------------------------------------------------------
describe("§6 row 9 — External client without Access → denied at the Access edge; cannot reach the app", () => {
  it.todo(
    "MANUAL/E2E: Cloudflare Access is edge infrastructure outside this repo entirely — nothing " +
      "in the app can express or unit-test 'the edge denied this before it ever reached us'. " +
      "Cutover checklist: from a machine NOT enrolled in the Access policy (no valid identity), " +
      "hit the named public hostname and confirm the Cloudflare Access login/deny page renders " +
      "— never any app response (not even a 401 JSON body or /login page)."
  );
});

// ---------------------------------------------------------------------------
// Row 10
// ---------------------------------------------------------------------------
describe("§6 row 10 — Access-approved client, no app session → /dashboard/* login redirect; /api/* 401", () => {
  // COVERED BY: tests/auth/verify-request.test.ts — describe("decideRequest — human routes") ->
  //   it("deny401 a no-cookie GET to /api/*")
  //   it("redirectLogin a no-cookie GET to a dashboard page")
  // Access-approval itself is edge-only and invisible to the app (see row 11's structural
  // note): a request that reached the app WITH Access approval and WITHOUT an app session is
  // byte-for-byte the same ctx as any other no-session request, so this is the exact scenario
  // the existing tests already exercise.
  it("cited coverage file exists", () => {
    expectCitedTestsExist(["tests/auth/verify-request.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Row 11
// ---------------------------------------------------------------------------
describe("§6 row 11 — Access headers present but no app session → still denied; headers alone grant nothing", () => {
  it("decideRequest ignores unknown/spoofed headers entirely — a Cf-Access-* style header cannot substitute for a session", () => {
    const db = fresh();
    // RequestCtx.headers only ever declares 4 named keys (origin, x-csrf-token,
    // x-cron-secret, x-electron-cred) — proxy.ts's ctx builder extracts exactly
    // those 4 from the real NextRequest and nothing else, so a real Cf-Access-*
    // header on the incoming request is structurally never read into ctx at all.
    // This test proves the deny path holds even when an extra, unrecognized
    // header IS present on the ctx object (the worst case: as if some future
    // refactor started forwarding it) — decideRequest has no branch that can
    // consume it.
    const headersWithSpoofedAccessClaim = {
      "cf-access-jwt-assertion": "spoofed-value",
      "cf-access-authenticated-user-email": "attacker@example.com",
    } as unknown as RequestCtx["headers"];

    const d = decideRequest(
      db,
      ctx({ method: "GET", pathname: "/api/summary", headers: headersWithSpoofedAccessClaim }),
      T0
    );
    expect(d.action).toBe("deny401");

    const dPage = decideRequest(
      db,
      ctx({ method: "GET", pathname: "/dashboard/today", headers: headersWithSpoofedAccessClaim }),
      T0
    );
    expect(dPage.action).toBe("redirectLogin");
  });
});

// ---------------------------------------------------------------------------
// Row 12
// ---------------------------------------------------------------------------
describe("§6 row 12 — Valid session + missing/untrusted Origin on a write → rejected; DB unchanged", () => {
  // "Untrusted Origin" IS covered: tests/auth/verify-request.test.ts ->
  //   it("deny401 an unsafe method from an untrusted Origin (even with valid CSRF)")
  // "Missing Origin" (the header absent entirely, not just wrong) is NOT separately asserted
  // anywhere — decideHumanSession's `if (!origin || ...)` check covers both branches in the
  // same line, but only the "wrong value" branch had a dedicated test. Closing that gap here.
  it("deny401 an unsafe method with NO Origin header at all (not just a wrong one), even with a matching CSRF token", () => {
    const db = fresh();
    const { rawToken, csrfToken } = createSession(db, { label: "phone" }, T0);
    const d = decideRequest(
      db,
      ctx({
        method: "POST",
        pathname: "/api/settings",
        cookies: { [SESSION_COOKIE]: rawToken, [CSRF_COOKIE]: csrfToken },
        headers: { "x-csrf-token": csrfToken }, // origin entirely absent
      }),
      T0
    );
    expect(d.action).toBe("deny401");
  });
  // The "DB unchanged" half of the guarantee follows structurally from proxy.ts: on any
  // non-"allow" Decision it returns NextResponse.redirect/json directly and never calls
  // NextResponse.next(), so the route handler (and any mutation inside it) never executes.
  // That short-circuit is inherent Next.js proxy semantics, not independently unit-testable
  // without booting a live Next server — the decideRequest-level deny401/redirectLogin
  // assertions above are the closest unit-level proxy for it.
});

// ---------------------------------------------------------------------------
// Row 13
// ---------------------------------------------------------------------------
describe("§6 row 13 — Valid session, unsafe method, missing or wrong X-CSRF-Token → rejected; DB unchanged", () => {
  // COVERED BY: tests/auth/verify-request.test.ts ->
  //   it("deny401 an unsafe method missing the CSRF header")
  //   it("deny401 an unsafe method with a CSRF header that doesn't match the cookie/secret")
  // Plus the dual-route equivalent: it("deny401 a dual unsafe POST with a session but missing CSRF")
  it("cited coverage file exists", () => {
    expectCitedTestsExist(["tests/auth/verify-request.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Row 14
// ---------------------------------------------------------------------------
describe("§6 row 14 — CSRF token retrieval after a page reload → client re-reads vgs_csrf cookie; next write succeeds", () => {
  // tests/http/apiFetch.test.ts proves the reader fn is invoked (and only for unsafe methods),
  // but every one of its tests uses a fixed `() => "TOKEN123"` reader across a single call —
  // none of them prove the reader is re-invoked FRESH on a *second* call after the underlying
  // cookie value changed (the reload scenario: a new session/new csrf secret rotates the
  // vgs_csrf cookie, and the very next write must pick up the NEW value, not a cached one).
  it("re-reads the CSRF token on every call — a value change between calls (simulating a reload rotating the cookie) takes effect on the next write immediately, no caching", async () => {
    const calls: (RequestInit | undefined)[] = [];
    const trackingFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init);
      return new Response("{}");
    };
    let currentToken = "PRE_RELOAD_TOKEN";
    const apiFetch = makeApiFetch(() => currentToken, trackingFetch as unknown as typeof fetch);

    await apiFetch("/api/notes", { method: "POST" });
    const firstHeader = new Headers(calls[0]?.headers).get("X-CSRF-Token");
    expect(firstHeader).toBe("PRE_RELOAD_TOKEN");

    // Simulate a page reload: the server minted a new csrf secret, the browser now has a
    // fresh vgs_csrf cookie value — no explicit re-init of apiFetch happens on reload (it's a
    // plain module-level function), so this must "just work" via the injected reader being
    // called again, not memoized from the first call.
    currentToken = "POST_RELOAD_TOKEN";
    await apiFetch("/api/notes", { method: "POST" });
    const secondHeader = new Headers(calls[1]?.headers).get("X-CSRF-Token");
    expect(secondHeader).toBe("POST_RELOAD_TOKEN");
    expect(secondHeader).not.toBe(firstHeader);
  });
});

// ---------------------------------------------------------------------------
// Row 15
// ---------------------------------------------------------------------------
describe("§6 row 15 — Every mutating client fetch routes through apiFetch → grep/lint guard passes; no raw unsafe fetch(\"/api/…\") remains", () => {
  // The guard (eslint-rules/no-raw-api-fetch.js, wired in eslint.config.mjs scoped to app/**
  // minus app/api/**) exists and Task 8/9-12's reports claim 96 -> 0 violations, but nothing in
  // the vitest suite actually RUNS eslint and asserts 0 — `npm run lint` is a separate command
  // this task's "full suite" gate does not invoke. Closing that gap: run the real rule, over
  // the real app/** tree, inside the automated suite.
  it(
    "app/** has zero local/no-raw-api-fetch violations (runs the actual configured lint rule via `npx eslint app --format json`)",
    () => {
      let stdout: string;
      try {
        stdout = execFileSync("npx", ["eslint", "app", "--format", "json"], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          maxBuffer: 20 * 1024 * 1024,
        });
      } catch (err) {
        // eslint exits 1 whenever ANY lint error exists anywhere in app/** (this repo has
        // lint findings unrelated to our rule) — the JSON report is written to stdout
        // regardless of exit code, so pull it off the thrown error.
        stdout = (err as { stdout?: string }).stdout ?? "";
      }
      expect(stdout.length).toBeGreaterThan(0);
      const report = JSON.parse(stdout) as {
        filePath: string;
        messages: { ruleId: string | null; message: string; line: number }[];
      }[];
      const violations = report.flatMap((f) =>
        f.messages
          .filter((m) => m.ruleId === "local/no-raw-api-fetch")
          .map((m) => `${path.relative(REPO_ROOT, f.filePath)}:${m.line} ${m.message}`)
      );
      expect(violations).toEqual([]);
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// Row 16
// ---------------------------------------------------------------------------
describe("§6 row 16 — Revoked / lost-device session → dashboard + API access immediately denied", () => {
  // The mutation-layer half is covered: tests/api/revoke-all.test.ts ->
  //   it("revokes every session — previously valid tokens no longer verify")
  // Not yet asserted at the actual authorization boundary (decideRequest) — this is the layer
  // that matters for "immediately denied", since that's the function every request flows
  // through. Closing that gap directly.
  it("decideRequest denies BOTH a dashboard GET and an /api/* GET the instant a session is revoked, using the same raw token that worked a moment earlier", () => {
    const db = fresh();
    const { rawToken, id } = createSession(db, { label: "phone" }, T0);

    const beforeRevoke = decideRequest(
      db,
      ctx({ method: "GET", pathname: "/api/summary", cookies: { [SESSION_COOKIE]: rawToken } }),
      T0
    );
    expect(beforeRevoke.action).toBe("allow");

    revokeSession(db, id);

    const afterRevokeApi = decideRequest(
      db,
      ctx({ method: "GET", pathname: "/api/summary", cookies: { [SESSION_COOKIE]: rawToken } }),
      T0
    );
    expect(afterRevokeApi.action).toBe("deny401");

    const afterRevokePage = decideRequest(
      db,
      ctx({ method: "GET", pathname: "/dashboard/today", cookies: { [SESSION_COOKIE]: rawToken } }),
      T0
    );
    expect(afterRevokePage.action).toBe("redirectLogin");
  });
});

// ---------------------------------------------------------------------------
// Row 17
// ---------------------------------------------------------------------------
describe("§6 row 17 — Password change → all existing sessions revoked; old cookie now 401s", () => {
  // COVERED BY (see also row 21, the detailed version of this same row):
  //   tests/electron/password-change.test.ts — runPasswordChange step ordering
  //   tests/api/revoke-all.test.ts — the revoke-all mechanism it calls
  //   tests/queries/sessions.test.ts — revokeAllSessions deletes every session
  //   Row 16's new decideRequest-level test above proves an old token 401s post-revoke.
  it("cited coverage files exist", () => {
    expectCitedTestsExist([
      "tests/electron/password-change.test.ts",
      "tests/api/revoke-all.test.ts",
      "tests/queries/sessions.test.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Row 18
// ---------------------------------------------------------------------------
describe("§6 row 18 — PIN re-unlock on a device with a live session", () => {
  // Backend contract COVERED BY: tests/api/pin.test.ts (handleSetPin, handleVerifyPin) —
  //   - "succeeds": it("correct PIN on a live session -> success + session touched/extended")
  //   - "PIN never creates a session from cold": it("no PIN set on the session -> 'no-pin'"),
  //     it("PIN on an EXPIRED session -> rejected, and NO new session is created"),
  //     it("PIN on an IDLE-expired session -> rejected, no cold session")
  //   - "PIN dead after device revoke": it("REVOKING the session invalidates the PIN (and its
  //     row is gone)")
  //   - "lockout after N failures": it("locks out after N wrong attempts; a later CORRECT PIN
  //     is still rejected") — asserts reason: "locked", which lib/auth/pin.ts's own doc comment
  //     states means "fall back to password".
  it.todo(
    "MANUAL/E2E: the CLIENT-side 'falls back to password' behavior (app/dashboard/components/" +
      "PinUnlock.tsx reading a 423/`reason: \"locked\"` response and swapping to the full " +
      "password form) has no automated test — this project has no React component-testing " +
      "infrastructure (Node-env-only vitest.config.ts, no jsdom, no @testing-library " +
      "dependency, zero .test.tsx files anywhere in the repo). Cutover checklist: on a device " +
      "with a live session + a set PIN, enter the wrong PIN enough times to trip the lockout " +
      "and confirm the UI swaps to the password prompt (not stuck showing a dead PIN pad)."
  );
});

// ---------------------------------------------------------------------------
// Row 19
// ---------------------------------------------------------------------------
describe("§6 row 19 — Electron bootstrap ordering", () => {
  // "bootstrap only reachable on loopback with the service credential" IS covered:
  //   tests/api/desktop-bootstrap-route.test.ts ->
  //     it("non-loopback Host: 403, and the credential is NEVER read/verified (no session minted)")
  //     it("loopback Host + valid cred: 200 with a real session + csrf")
  //     it("loopback Host + wrong cred: 401")
  it.todo(
    "MANUAL/E2E: 'window loads /dashboard authenticated with no /login bounce' is the same " +
      "live-Electron-runtime gap as row 3 — the retry loop, cookie install, and loadURL " +
      "ordering inside electron/main.ts's createWindow() isn't driven by any test in this " +
      "suite. Cutover checklist: same as row 3 — cold launch, confirm no /login flash."
  );
});

// ---------------------------------------------------------------------------
// Row 20
// ---------------------------------------------------------------------------
describe("§6 row 20 — First-run password provisioning (native flow)", () => {
  // "Server does not serve remote clients until set" is covered by composition: every
  // dashboard/API route defaults to "human" (route-policy.test.ts: "defaults to human for
  // anything not explicitly listed"), and tests/api/auth-login.test.ts ->
  //   it("missing APP_PASSWORD_HASH: 500, no cookies") proves login itself can't mint a
  //   session without a hash set — so with no password provisioned, no route (session-gated
  //   by default) is reachable remotely regardless of Host.
  // "No remote set-password route exists" was NOT directly asserted anywhere — closing that
  // gap by walking the actual declared route manifest (the same fs-driven manifest
  // route-policy.test.ts's "no route escapes classification" test trusts).
  it("no app/api/**/route.ts declares a password-setting endpoint — provisioning is native-IPC-only (electron/ipc-handlers.ts's \"change-password\" channel), never HTTP-reachable", () => {
    const handlers = listRouteHandlers();
    const passwordRoutes = handlers.filter((h) => /password/i.test(h.pathname));
    expect(passwordRoutes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Row 21
// ---------------------------------------------------------------------------
describe("§6 row 21 — Password change transaction", () => {
  // COVERED BY: tests/electron/password-change.test.ts
  //   it("runs the steps in the exact spec order and reports success")
  //   it("writes the new hash BEFORE revoking, revokes BEFORE restarting, restarts BEFORE
  //       re-bootstrapping")
  //   it("aborts BEFORE writing anything when the current password is wrong")
  //   it("propagates a thrown error from a later step (transaction is not silently swallowed)")
  // Plus tests/electron/password-hash.test.ts (hash parity between the duplicated Electron
  // scrypt implementation and lib/auth/credentials) and tests/api/revoke-all.test.ts for the
  // revoke-all call this transaction makes.
  it("cited coverage files exist", () => {
    expectCitedTestsExist([
      "tests/electron/password-change.test.ts",
      "tests/electron/password-hash.test.ts",
      "tests/api/revoke-all.test.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Row 22
// ---------------------------------------------------------------------------
describe("§6 row 22 — safeStorage unavailable (keychain locked/unsupported) → fails closed", () => {
  // COVERED BY: tests/electron/encrypted-secrets.test.ts — 4 dedicated fail-closed tests:
  //   it("fails closed: throws instead of returning a value when encryption is unavailable")
  //   it("fails closed: throws instead of writing plaintext when encryption is unavailable")
  //   it("never falls back to plaintext storage anywhere on disk when encryption is unavailable")
  //   it("fails closed: throws when encryption is unavailable, never generating an unprotected
  //       secret") (loadOrCreateSecret) + the equivalent for rotateSecret.
  it("cited coverage file exists", () => {
    expectCitedTestsExist(["tests/electron/encrypted-secrets.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Row 23
// ---------------------------------------------------------------------------
describe("§6 row 23 — Service-credential rotation", () => {
  // COVERED BY: tests/electron/rotation.test.ts
  //   it("runs the steps in the exact order and reports success with the new credential")
  //   it("writes the new cred BEFORE restarting, restarts BEFORE re-bootstrapping")
  //   it("verifyElectronCred: OLD value fails, NEW value passes, once ELECTRON_SERVICE_CRED
  //       rotates")
  //   it("handleDesktopBootstrap: OLD cred 401s and NEW cred 200s once ELECTRON_SERVICE_CRED
  //       rotates")
  it("cited coverage file exists", () => {
    expectCitedTestsExist(["tests/electron/rotation.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Row 24
// ---------------------------------------------------------------------------
describe("§6 row 24 — Migration 079 fresh install + upgrade from 078; unique token_hash + expires_at indexes present", () => {
  // COVERED BY: tests/queries/sessions.test.ts — describe("migration 079: app_sessions")
  //   it("applies cleanly over a database seeded at 078 and creates the unique token index")
  //     — the UPGRADE path (migrateBelow(79) then apply 079 directly)
  //   it("full runMigrations path enforces the unique token index")
  //     — the FRESH-INSTALL path (runMigrations from an empty :memory: db, via this file's own
  //       fresh() helper, then a duplicate-token INSERT proves the unique index is real)
  //   Both paths reach the schema; idx_app_sessions_token (unique) + idx_app_sessions_expires
  //   are asserted present in the upgrade test.
  it("cited coverage file exists", () => {
    expectCitedTestsExist(["tests/queries/sessions.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Row 25
// ---------------------------------------------------------------------------
describe("§6 row 25 — Session expiry (idle + absolute); last_seen conditional-update throttle honored", () => {
  // Query-layer coverage: tests/queries/sessions.test.ts — verifySession expiry (both windows)
  // + touchSession throttle no-op/slide tests. Not yet asserted at the actual decideRequest
  // authorization boundary — closing that gap (mirrors row 16's pattern for revocation).
  it("decideRequest denies a session past its ABSOLUTE window even though the raw token is otherwise valid", () => {
    const db = fresh();
    const { rawToken } = createSession(db, { label: "phone" }, T0);
    const afterAbsolute = T0 + ABSOLUTE_MS + 1;
    const d = decideRequest(
      db,
      ctx({ method: "GET", pathname: "/api/summary", cookies: { [SESSION_COOKIE]: rawToken } }),
      afterAbsolute
    );
    expect(d.action).toBe("deny401");
  });

  it("decideRequest denies a session past its IDLE window even though it's inside the absolute window", () => {
    const db = fresh();
    const { rawToken } = createSession(db, { label: "phone" }, T0);
    const afterIdle = T0 + IDLE_WINDOW_MS + 1;
    const d = decideRequest(
      db,
      ctx({ method: "GET", pathname: "/dashboard/today", cookies: { [SESSION_COOKIE]: rawToken } }),
      afterIdle
    );
    expect(d.action).toBe("redirectLogin");
  });
  // The "no per-request write" throttle guarantee is proxy.ts calling touchSession only on
  // allow, and touchSession's own conditional UPDATE being a no-op inside the throttle window
  // — both already directly tested in tests/queries/sessions.test.ts's touchSession describe
  // block; not re-duplicated here.
});

// ---------------------------------------------------------------------------
// Row 26
// ---------------------------------------------------------------------------
describe("§6 row 26 — State-changing GET audit: no GET route performs a mutation; contract test forbids mutating GETs", () => {
  // COVERED BY: tests/api/no-state-changing-get.test.ts
  //   it("GET_WRITE_OFFENDERS is empty — every offender migrated to POST")
  //   it("no GET handler body contains a write call (durable static scan)")
  //   it("the scan would catch a planted write-through helper call in a GET body")
  // Plus tests/auth/route-policy.test.ts's own GET_WRITE_OFFENDERS assertion.
  it("cited coverage files exist", () => {
    expectCitedTestsExist(["tests/api/no-state-changing-get.test.ts", "tests/auth/route-policy.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Row 27
// ---------------------------------------------------------------------------
describe("§6 row 27 — Dynamic apiFetch call sites (template-literal + variable endpoints): ESLint AST rule catches raw unsafe fetch", () => {
  // Row 15 proves the CURRENT app/** tree is clean (0 violations today). This row is a
  // different claim — that the rule actually HAS TEETH against the dynamic/unprovable shapes
  // (template-literal endpoints, variable method values) the rule's own doc comment describes
  // as branch (b). Nothing exercises the rule's detection logic directly anywhere in the repo
  // (no RuleTester/unit test for eslint-rules/no-raw-api-fetch.js existed before this file).
  function violations(code: string): string[] {
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(code, {
      languageOptions: { ecmaVersion: 2022, sourceType: "module" },
      plugins: { local: { rules: { "no-raw-api-fetch": noRawApiFetchRule } } },
      rules: { "local/no-raw-api-fetch": "error" },
    });
    return messages.filter((m) => m.ruleId === "local/no-raw-api-fetch").map((m) => m.messageId ?? m.message);
  }

  it("flags a template-literal /api/ endpoint with a non-literal (variable) method as unprovable", () => {
    const code = `
      async function save(id, verb) {
        await fetch(\`/api/notes/\${id}\`, { method: verb });
      }
    `;
    expect(violations(code)).toEqual(["unprovableApiCall"]);
  });

  it("flags a template-literal /api/ endpoint with an explicit unsafe literal method", () => {
    const code = `
      async function remove(id) {
        await fetch(\`/api/levels/\${id}\`, { method: "DELETE" });
      }
    `;
    expect(violations(code)).toEqual(["unsafeMethodLiteral"]);
  });

  it("flags a literal /api/ endpoint whose init is an opaque variable (method can't be statically proven GET)", () => {
    const code = `
      async function post(opts) {
        await fetch("/api/settings", opts);
      }
    `;
    expect(violations(code)).toEqual(["unprovableApiCall"]);
  });

  it("does NOT flag a plain GET (no init at all) or an apiFetch(...) call", () => {
    const code = `
      async function load() {
        await fetch("/api/summary");
      }
      async function save() {
        await apiFetch("/api/notes", { method: "POST" });
      }
    `;
    expect(violations(code)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Row 28
// ---------------------------------------------------------------------------
describe("§6 row 28 — Both Worker primary calls removed (primary.ts + calendar-enrich.ts): immediate fallback, no MESH_HOSTNAME POST attempted", () => {
  // DONE 2026-08-14 (Task 25, #35 Phase D): workers/cron/src/primary.ts (which
  // exported callPrimary, called from index.ts's runJob) is deleted entirely.
  // workers/cron/src/calendar-enrich.ts's own local callEnrichPrimary (NOT
  // callPrimary — that naming in the original PHASE-D-BLOCKED note was
  // imprecise; callPrimary lived only in primary.ts) is also deleted.
  // runJob/runCalendarEnrich now go straight from the marker dedup check to
  // fallback.
  //   COVERED BY: workers/cron/test/primary-retirement.test.ts — asserts
  //   global.fetch is never called for either path, AND that every marker-
  //   skip path (mac-sent/cloud-sent/cloud-attempting/mac-running for the
  //   email path; already-sent-this-slot for calendar-enrich) still
  //   short-circuits before the fallback composer runs — proving the dedup
  //   that used to guard the post-primary race is intact with no primary
  //   call left to race against.
  it("cited coverage file exists", () => {
    expectCitedTestsExist(["workers/cron/test/primary-retirement.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Row 29
// ---------------------------------------------------------------------------
describe("§6 row 29 — UI mutation audit: import preview/commit/undo, notes, levels, settings writes all carry CSRF and succeed authenticated; all 401 unauthenticated", () => {
  // This is covered by COMPOSITION, not a per-route special case: classifyRoute defaults
  // everything not explicitly public/cron/electron/dual to "human" (route-policy.test.ts:
  // "defaults to human for anything not explicitly listed"), and decideRequest's CSRF check
  // for "human" routes is a single uniform code path (lib/auth/verify-request.ts's
  // decideHumanSession) — there is no route-specific branching, so the human-route CSRF tests
  // in tests/auth/verify-request.test.ts prove the mechanism for EVERY human route at once,
  // including these four surfaces. Plus tests/api/import-undo-recovery.test.ts's
  // handleUndoRequest tests (confirmation-token challenge, throttling) for the undo-specific
  // extra guard on top of the session/CSRF layer. Plus the 96-call-site apiFetch migration
  // (tasks 9-12) that specifically included import/notes/levels/settings client call sites,
  // gated by the eslint rule tested in rows 15/27.
  //
  // Light anchor: confirm none of these four surfaces is accidentally classified into a
  // weaker (public/cron/electron/dual) kind that would bypass the human/CSRF path.
  it("import, notes, levels, and settings mutation routes all classify as 'human' (full session + CSRF gate, no shortcut)", () => {
    const uiMutationRoutes: [string, string][] = [
      ["POST", "/api/import"],
      ["DELETE", "/api/import"],
      ["POST", "/api/notes"],
      ["PUT", "/api/notes"],
      ["DELETE", "/api/notes"],
      ["POST", "/api/levels"],
      ["PATCH", "/api/levels"],
      ["DELETE", "/api/levels"],
      ["POST", "/api/settings"],
    ];
    for (const [method, pathname] of uiMutationRoutes) {
      expect(classifyRoute(method, pathname)).toBe("human");
    }
  });
});

// ---------------------------------------------------------------------------
// Row 30
// ---------------------------------------------------------------------------
describe("§6 row 30 — Import-undo manifest + restoration: manifest complete + checksum valid; restore reproduces pre-undo state; re-import idempotent", () => {
  // COVERED BY: tests/api/import-undo-recovery.test.ts — extensive (20 tests across 6 describe
  // blocks): confirmation token issue/expiry/throttle; manifest capture (6 source tables +
  // import_batches, checksum, atomic write + retention prune); undo->restore round-trip
  // (including statement-authority preservation); checksum-invalid refusal; re-import
  // idempotence; corporate-actions capture/restore; restore hardening (fresh child ids,
  // occupied-id refusal, chronological prune); handleUndoRequest route core (challenge on
  // missing token, manifest-before-delete ordering, throttling).
  it("cited coverage file exists", () => {
    expectCitedTestsExist(["tests/api/import-undo-recovery.test.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Row 31
// ---------------------------------------------------------------------------
describe("§6 row 31 — Plaid OAuth return to the named hostname: Lax session reaches authenticated /dashboard/plaid-link; resume succeeds", () => {
  // The mechanical piece is covered by composition (same argument as row 29): /api/plaid/
  // exchange and /dashboard/plaid-link are unlisted -> default "human" -> the same uniform
  // session-cookie gate applies. Anchor below confirms the classification directly.
  it("anchor: /dashboard/plaid-link and POST /api/plaid/exchange both classify as 'human'", () => {
    expect(classifyRoute("GET", "/dashboard/plaid-link")).toBe("human");
    expect(classifyRoute("POST", "/api/plaid/exchange")).toBe("human");
  });

  it.todo(
    "MANUAL/E2E, entangled with Phase D transport cutover: the substantive claim of this row " +
      "is a real cross-origin top-level navigation (Plaid's domain redirecting back to ours) " +
      "surviving with the SameSite=Lax vgs_session cookie intact, over the NAMED hostname (not " +
      "the quick-tunnel this .env.local currently documents per §7's runbook-update item). " +
      "That's a live browser + live Plaid OAuth + live DNS/tunnel concern, not something " +
      "decideRequest's pure ctx model can simulate meaningfully. Cutover checklist: after the " +
      "named-hostname cutover, start a Plaid Link flow, complete OAuth at Plaid's site, confirm " +
      "the redirect back lands authenticated on /dashboard/plaid-link with no login bounce."
  );
});

// ---------------------------------------------------------------------------
// Consolidated manual/E2E cutover checklist (Task 26 / final review reference)
// ---------------------------------------------------------------------------
describe("§6 — consolidated manual/E2E verification checklist for live cutover", () => {
  // See the individual it.todo() entries above (rows 1, 2, 3, 8 partial, 9, 18 partial, 19,
  // 28, 31 partial) for the full per-row detail. This entry exists so `vitest run` surfaces a
  // single grep target ("consolidated manual/E2E") that points a reader at every todo. The
  // authoritative, human-readable version of this checklist is in
  // .superpowers/sdd/2026-08-14-packaged-app-trust-boundary/task-23-report.md.
  it.todo(
    "See task-23-report.md 'Consolidated manual/E2E verification checklist' for the full " +
      "list, grouped by: (A) items whose code (loopback flip + Worker-primary retirement, " +
      "both landed 2026-08-14) is done but which still need the packaged-app rebuild/install " +
      "cutover before live verification is possible (rows 1, 2, 8-partial, 28), " +
      "(B) live-packaged-Electron-app items (rows 3, 19), (C) live-Cloudflare-Access-edge " +
      "items (row 9), (D) live-Plaid-OAuth item entangled with named-hostname cutover " +
      "(row 31), (E) live-device PIN-lockout UI item (row 18)."
  );
});
