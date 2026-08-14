/**
 * Task 5 (#35 trust boundary) — no state-changing GET routes.
 *
 * The session cookie is SameSite=Lax, so the browser sends it on cross-site
 * top-level GET navigations. Any GET route that WRITES is therefore reachable
 * by a hostile page via a plain hyperlink / prefetch / <img> — a GET-CSRF hole
 * that can trigger side effects (notably paid-AI generation) with no token.
 *
 * Two guards:
 *   1. Contract — GET_WRITE_OFFENDERS is empty (Task 5 migrated them all).
 *   2. Static scan — every GET-exporting route.ts has a write-free GET body.
 *      This is the DURABLE guard: it fails the moment a new GET handler grows
 *      a write, independent of the hand-maintained offenders list.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { GET_WRITE_OFFENDERS, listRouteHandlers } from "@/lib/auth/route-policy";

const __dirnameLocal = path.dirname(fileURLToPath(import.meta.url));
const APP_API_DIR = path.resolve(__dirnameLocal, "../../app/api");

/** `/api/foo/[id]/bar` → absolute app/api/foo/[id]/bar/route.ts */
function routeFileForPathname(pathname: string): string {
  const rel = pathname === "/api" ? "" : pathname.replace(/^\/api\/?/, "");
  return path.join(APP_API_DIR, rel, "route.ts");
}

/**
 * Extract the body of `export [async] function GET(...) { ... }` by matching
 * braces from the first `{` after the signature to its partner. All 65 GET
 * routes in the tree use the function-declaration form (verified: none use
 * `export const GET =`), so this covers the whole surface.
 */
function extractGetBody(source: string): string | null {
  const sigRe = /export\s+(?:async\s+)?function\s+GET\s*\(/m;
  const sigMatch = sigRe.exec(source);
  if (!sigMatch) return null;

  // Find the first "{" after the parameter list closes.
  let i = sigMatch.index + sigMatch[0].length;
  let depthParen = 1;
  while (i < source.length && depthParen > 0) {
    const c = source[i];
    if (c === "(") depthParen++;
    else if (c === ")") depthParen--;
    i++;
  }
  // Skip whitespace + a possible return-type annotation up to the opening brace.
  const braceIdx = source.indexOf("{", i);
  if (braceIdx === -1) return null;

  let depth = 0;
  let start = braceIdx;
  for (let j = braceIdx; j < source.length; j++) {
    const c = source[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start + 1, j);
      }
    }
  }
  return null;
}

/**
 * Write-call signatures — the set named by the Task 5 brief: `.run(`,
 * INSERT/UPDATE/DELETE, and the `upsert*`/`ensure*`/`set*`/`record*` helper
 * families whose whole job is to persist. Deliberately NOT `reconcile*` or
 * `generate*`: those names are also worn by pure-compute reads (e.g.
 * `reconcileCostBasis` computes a diff and writes nothing), so flagging them
 * yields false positives. Read-through-cache generators are governed instead
 * by GET_WRITE_OFFENDERS + the per-route behavioral tests.
 *
 * `set*` is scoped to the persist helpers in this tree (setLast..., setCached...,
 * setMarker...) so it can't trip on setTimeout/setInterval/setHeader/searchParams.set.
 * Strings/comments are not stripped — a false positive is fixed by moving the
 * write, which is exactly the point.
 */
const WRITE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: ".run( statement execution", re: /\.run\s*\(/ },
  { label: "INSERT statement", re: /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b/i },
  { label: "UPDATE statement", re: /\bUPDATE\s+[`"']?\w/i },
  { label: "DELETE statement", re: /\bDELETE\s+FROM\b/i },
  { label: "upsert*() call", re: /\bupsert[A-Z]\w*\s*\(/ },
  { label: "ensure*() call", re: /\bensure[A-Z]\w*\s*\(/ },
  { label: "set*() persist call", re: /\bset(?:Last|Cached|Marker)\w*\s*\(/ },
  { label: "record*() persist call", re: /\brecord[A-Z]\w*\s*\(/ },
];

describe("no state-changing GET routes (SameSite=Lax GET-CSRF)", () => {
  it("GET_WRITE_OFFENDERS is empty — every offender migrated to POST", () => {
    expect(GET_WRITE_OFFENDERS).toEqual([]);
  });

  it("no GET handler body contains a write call (durable static scan)", () => {
    const getHandlers = listRouteHandlers().filter((h) => h.method === "GET");
    // Sanity: the enumeration is actually finding routes.
    expect(getHandlers.length).toBeGreaterThan(50);

    const violations: string[] = [];
    for (const h of getHandlers) {
      const file = routeFileForPathname(h.pathname);
      if (!fs.existsSync(file)) {
        violations.push(`${h.pathname}: route file not found at ${file}`);
        continue;
      }
      const source = fs.readFileSync(file, "utf8");
      const body = extractGetBody(source);
      if (body == null) {
        violations.push(`${h.pathname}: could not isolate GET body`);
        continue;
      }
      for (const { label, re } of WRITE_PATTERNS) {
        if (re.test(body)) {
          violations.push(`GET ${h.pathname}: GET body contains ${label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
