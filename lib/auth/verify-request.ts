import type Database from "better-sqlite3";
import { timingSafeEqual } from "node:crypto";
import { classifyRoute, isImmutableAsset } from "@/lib/auth/route-policy";
import { verifySession } from "@/lib/queries/sessions";
import { csrfMatches } from "@/lib/auth/csrf";
import { SESSION_COOKIE, CSRF_COOKIE } from "@/lib/auth/cookies";

// Packaged-app trust boundary (#35, task 18) — the single authorization
// decision. Pure over an injected `db` (DI, like every other data-layer fn):
// no Next.js types, no HTTP, no env reads. `proxy.ts` builds the ctx from the
// live NextRequest + env and applies the returned action; every enforcement
// test drives this fn directly. classifyRoute is the single source of truth
// for which credential kind a route needs — never fork that logic here.

export interface RequestCtx {
  method: string;
  pathname: string;
  /** The Host header, host[:port] form (e.g. "localhost:3099"). */
  host: string;
  /** Cookie name → value (already parsed). */
  cookies: Record<string, string | undefined>;
  headers: {
    origin?: string;
    "x-csrf-token"?: string;
    "x-cron-secret"?: string;
    "x-electron-cred"?: string;
  };
  /** Allowlist of acceptable Host values (host[:port]). */
  hosts: Set<string>;
  /** Allowlist of acceptable Origin values (scheme://host[:port]). */
  origins: Set<string>;
  /** Configured cron secret (CRON_SHARED_SECRET). Blank ⇒ fail-closed. */
  cronSecret: string;
  /** Configured Electron-main service credential. Blank ⇒ fail-closed. */
  electronCred: string;
}

export interface Decision {
  action: "allow" | "deny401" | "redirectLogin";
  /** Set only on a human-session allow — the session id to slide the idle
   * window for. Absent on service-credential and public allows. */
  touchId?: number;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Constant-time equality for a presented service credential against the
 * configured one. FAIL-CLOSED: a blank/undefined *configured* secret never
 * matches, even against a blank presented value — a misconfigured (empty)
 * secret must lock the route, never trivially satisfy equality. A blank
 * presented value also never matches.
 */
function serviceCredMatches(presented: string | undefined, configured: string): boolean {
  if (!configured) return false; // fail-closed: unconfigured secret
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Resolves the human-session leg of the decision: a valid session cookie is
 * required, and on unsafe methods a trusted Origin plus a matching
 * double-submit CSRF token. Returns the deny decision (from `deny`) on any
 * failure, or an allow carrying the session id as touchId.
 */
function decideHumanSession(
  db: Database.Database,
  ctx: RequestCtx,
  nowMs: number,
  deny: () => Decision,
): Decision {
  const token = ctx.cookies[SESSION_COOKIE];
  if (!token) return deny();

  const session = verifySession(db, token, nowMs);
  if (!session) return deny();

  if (UNSAFE_METHODS.has(ctx.method.toUpperCase())) {
    const origin = ctx.headers.origin;
    if (!origin || !ctx.origins.has(origin)) return deny();
    const csrfHeader = ctx.headers["x-csrf-token"] ?? "";
    const csrfCookie = ctx.cookies[CSRF_COOKIE] ?? "";
    if (!csrfMatches(csrfHeader, csrfCookie, session.csrfSecret)) return deny();
  }

  return { action: "allow", touchId: session.id };
}

/**
 * The single authorization decision, default-deny and credential-kind-specific.
 * See spec §E/§F. Order matters: immutable assets first, then the Host gate,
 * then classify and check exactly the one credential kind that route accepts.
 */
export function decideRequest(db: Database.Database, ctx: RequestCtx, nowMs: number): Decision {
  // Immutable static assets carry no credential and are safe to serve openly.
  if (isImmutableAsset(ctx.pathname)) return { action: "allow" };

  // Deny mapping is pathname-driven: API callers get a JSON 401, humans a
  // redirect to the login page.
  const deny = (): Decision =>
    ctx.pathname.startsWith("/api/") ? { action: "deny401" } : { action: "redirectLogin" };

  // Host gate — reject anything not on the canonical Host allowlist before
  // looking at credentials at all.
  if (!ctx.hosts.has(ctx.host)) return deny();

  const kind = classifyRoute(ctx.method, ctx.pathname);

  switch (kind) {
    case "public":
      return { action: "allow" };

    case "cron":
      // ONLY the cron secret — never the electron cred, never a session.
      if (serviceCredMatches(ctx.headers["x-cron-secret"], ctx.cronSecret)) {
        return { action: "allow" };
      }
      return deny();

    case "electron":
      // ONLY the electron cred — never the cron secret, never a session.
      if (serviceCredMatches(ctx.headers["x-electron-cred"], ctx.electronCred)) {
        return { action: "allow" };
      }
      return deny();

    case "dual":
      // Electron cred (main-process fetch, no cookie) OR a human session.
      // Never the cron secret.
      if (serviceCredMatches(ctx.headers["x-electron-cred"], ctx.electronCred)) {
        return { action: "allow" };
      }
      return decideHumanSession(db, ctx, nowMs, deny);

    case "human":
    default:
      return decideHumanSession(db, ctx, nowMs, deny);
  }
}
