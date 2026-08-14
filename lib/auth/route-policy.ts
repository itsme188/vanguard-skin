import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Packaged-app trust boundary (#35, task 3) — route-policy manifest.
// Single source of truth for which credential kind a route needs. Pure
// classification + fs introspection: no DB, no HTTP. The proxy (a later
// task) and every enforcement test consume classifyRoute/isImmutableAsset
// from here — never fork this logic.

export type RouteClass = "public" | "human" | "cron" | "electron";

function routeKey(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`;
}

/**
 * Login surface only — reachable with no credential at all. Everything else
 * defaults to "human" (session cookie required).
 */
const PUBLIC_ROUTES = new Set<string>([
  "GET /login",
  "POST /api/auth/login",
]);

/**
 * X-Cron-Secret allowlist — the existing `/api/cron/*` (6 routes) plus the
 * four enrich/reconcile routes that already require the cron secret
 * unconditionally (spec §F.2: "the existing /api/cron/* + the four
 * enrich/reconcile routes"). This is the full 10-route set the design doc
 * counts as "10 of ~112 route files check anything."
 *
 * NOT included here (deliberately): `/api/research/sync` and
 * `/api/earnings/recap-modal` — both reference CRON_SHARED_SECRET but only
 * to relay it to an internal helper call; neither requires the header to
 * enter the handler, so both are human routes, not service routes.
 */
const CRON_ROUTES = new Set<string>([
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
]);

/**
 * Electron-main service credential — the main process's own Node-`fetch`
 * calls, which do not carry the renderer window's cookie jar (spec §F.3).
 * Exactly these three (method, pathname) entries and nothing else.
 */
const ELECTRON_ROUTES = new Set<string>([
  "GET /api/tws/status",
  "POST /api/tws/connect",
  "POST /api/auth/desktop-bootstrap",
  // task 15 — the change-password transaction's server-owned "log out
  // everywhere" call. Loopback + Electron-service-credential only (the route
  // enforces both as defense-in-depth); Electron main can't open the DB itself.
  "POST /api/auth/revoke-all",
]);

/**
 * Classifies a route by the credential kind it should require. Default is
 * "human" (session cookie) — public/cron/electron are explicit allowlists
 * keyed on the exact (method, pathname) pair, never a prefix match, so a
 * cron secret or an Electron credential can never leak onto a route it
 * wasn't specifically carved out for.
 */
export function classifyRoute(method: string, pathname: string): RouteClass {
  const key = routeKey(method, pathname);
  if (PUBLIC_ROUTES.has(key)) return "public";
  if (CRON_ROUTES.has(key)) return "cron";
  if (ELECTRON_ROUTES.has(key)) return "electron";
  return "human";
}

/**
 * True only for assets that are content-addressed/static and safe to serve
 * with no credential at all. Deliberately NOT a blanket `/_next/*` — Next's
 * dynamic data routes (`/_next/data/*`) carry page props that can leak
 * portfolio data and must go through the same auth boundary as everything
 * else.
 */
export function isImmutableAsset(pathname: string): boolean {
  if (pathname.startsWith("/_next/static/")) return true;
  if (pathname === "/favicon.ico") return true;
  if (pathname === "/robots.txt") return true;
  return false;
}

/**
 * GET-write audit (task 3, 2026-08-14) — MIGRATED EMPTY in task 5 (2026-08-14).
 *
 * Every route the task-3 audit found performing a DB write inside a GET handler
 * (directly or via a read-through-cache helper) has been split so the GET is
 * side-effect-free and the write lives on a POST (or an existing background
 * path). Under the SameSite=Lax session cookie a bare GET carries no CSRF
 * protection, so a state-changing GET is reachable by a plain
 * hyperlink/prefetch/img-tag — the durable guard is the static scan in
 * `tests/api/no-state-changing-get.test.ts`, which fails the moment any GET
 * handler body grows a write.
 *
 * Migration record (`route.ts` → where the write went):
 *   - GET /api/security/[id]/regression → POST persists (GET computes+returns,
 *     no cache write; compute is pure deterministic math).
 *   - GET /api/earnings/cockpit → POST runs ensureIntelForEvents (GET decorates
 *     from already-computed intel rows).
 *   - GET /api/suggested-levels → POST generates narratives (GET reads cached
 *     narratives via getCachedLevelNarrative, null when absent).
 *   - GET /api/analysis/narrative → POST regen (GET is cache-read-only; a miss
 *     returns notGenerated).
 *   - GET /api/analysis/macro-themes → POST regen (GET reads getCachedMacroThemes;
 *     empty cached array = under-threshold; a miss returns notGenerated).
 *   - GET /api/digest/status → POST runs reconcileRecentCloudSends (GET is a
 *     pure read; checkCloudMarker stays — it writes nothing).
 *   - GET /api/digest/preview → POST runs the adaptive Sonnet synthesis + its
 *     telemetry write (GET returns the two deterministic renderings only).
 *
 * This array is the CONTRACT the task-5 test asserts empty. Adding a new
 * state-changing GET must not re-populate it — fix the route instead.
 */
export const GET_WRITE_OFFENDERS: string[] = [];

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_API_DIR = path.join(__dirname, "../../app/api");

/** Recursively collect every `route.ts` under `dir` (no fast-glob — undeclared dep). */
function findRouteFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findRouteFiles(full));
    } else if (entry.isFile() && entry.name === "route.ts") {
      results.push(full);
    }
  }
  return results;
}

/** `app/api/foo/[id]/route.ts` (absolute) → `/api/foo/[id]`. */
function pathnameForRouteFile(filePath: string): string {
  const rel = path.relative(APP_API_DIR, filePath).split(path.sep);
  rel.pop(); // drop the trailing "route.ts" segment
  const dirPart = rel.join("/");
  return dirPart === "" ? "/api" : `/api/${dirPart}`;
}

/** Which of GET/POST/PUT/PATCH/DELETE this route.ts source exports. */
function detectMethods(source: string): (typeof HTTP_METHODS)[number][] {
  return HTTP_METHODS.filter((method) => {
    const fnExport = new RegExp(`^export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`, "m");
    const constExport = new RegExp(`^export\\s+const\\s+${method}\\s*=`, "m");
    return fnExport.test(source) || constExport.test(source);
  });
}

/**
 * Enumerates every `app/api/**\/route.ts` handler as `{method, pathname}`
 * pairs by walking the filesystem directly (Node `fs`, not `fast-glob` —
 * it's not a declared dependency) and reading each file for its exported
 * HTTP verbs. This is the manifest the "no route escapes classification"
 * test walks — it must reflect the real route tree, not a hand-maintained
 * list that drifts.
 */
export function listRouteHandlers(): { method: string; pathname: string }[] {
  const files = findRouteFiles(APP_API_DIR);
  const handlers: { method: string; pathname: string }[] = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const pathname = pathnameForRouteFile(file);
    for (const method of detectMethods(source)) {
      handlers.push({ method, pathname });
    }
  }
  return handlers;
}
