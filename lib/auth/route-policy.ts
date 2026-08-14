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
 * GET-write audit (task 3, 2026-08-14) — every route below performs a DB
 * write inside a GET handler, either directly or via a read-through-cache
 * helper (`generate*`/`getOrGenerate*`/`ensure*`/`upsert*`/`reconcile*`)
 * called unconditionally from GET. Under the new auth boundary a bare GET
 * carries no CSRF protection, so each of these is a mutation reachable by
 * a plain hyperlink/prefetch/img-tag — seeded here so task 5 can migrate
 * them one at a time (empties this array; the seeded test asserts the
 * membership, not the length, so partial progress doesn't break CI).
 *
 * Full audit trail (`route.ts` → write call → what it writes):
 *   - GET /api/security/[id]/regression → upsertRegression()
 *       → INSERT ... ON CONFLICT DO UPDATE into security_regressions.
 *   - GET /api/earnings/cockpit → ensureIntelForEvents()
 *       → writes earnings intel rows (TTL-guarded, "best-effort by
 *         contract, never throws" per the route's own comment).
 *   - GET /api/suggested-levels → getOrGenerateNarrative() (lib/chart/narrate-levels.ts)
 *       → INSERT OR IGNORE into suggested_level_narratives on a cache miss.
 *   - GET /api/analysis/narrative → generateNarrative() (lib/compute/analysis-narratives.ts)
 *       → upsertNarrative() UPSERTs analysis_narratives on a cache miss.
 *   - GET /api/analysis/macro-themes → generateMacroThemes() (lib/compute/macro-themes.ts)
 *       → upsertMacroThemes() UPSERTs analysis_macro_themes on a cache miss
 *         (including the empty-array/under-threshold branch).
 *   - GET /api/digest/status → reconcileRecentCloudSends() (lib/cron/marker-check.ts)
 *       → advanceDigestMarkerAfterCloudSend() writes settings.last_digest_sent_at.
 *         By the function's own doc comment this is BY DESIGN: "an open
 *         dashboard heals the pointer within one poll" — but it is still a
 *         write behind a bare GET.
 *   - GET /api/digest/preview → generateDigestSinceAdaptive() (lib/digest/daily-digest.ts)
 *       → on a synthesis fallback, recordSynthesisFallback() writes a
 *         telemetry ring buffer to settings.synthesis_fallbacks_last_30d.
 *         Best-effort/try-catch-wrapped, but still a write on GET.
 */
export const GET_WRITE_OFFENDERS: string[] = [
  "GET /api/security/[id]/regression",
  "GET /api/earnings/cockpit",
  "GET /api/suggested-levels",
  "GET /api/analysis/narrative",
  "GET /api/analysis/macro-themes",
  "GET /api/digest/status",
  "GET /api/digest/preview",
];

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
