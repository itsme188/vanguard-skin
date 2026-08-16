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

/**
 * NARROW write-through-cache helper denylist. These helpers write INSIDE lib/
 * (INSERT/UPSERT on a cache miss, on-wake pointer heal, or intel refresh), so
 * the write is INVISIBLE to a GET-body scan of `.run(`/INSERT/etc. Their names
 * are deliberately generic (`generate*`/`getOrGenerate*`/`reconcile*`), which is
 * exactly why the broad WRITE_PATTERNS can't include those prefixes — a broad
 * `reconcile*` would false-positive on the pure-compute `reconcileCostBasis`.
 *
 * So we pin the SPECIFIC offending names instead: each of these seeded a task-3
 * GET-write offender (4 of the 7 were paid-AI generate-on-miss). If any exact
 * name reappears in a GET handler body, the generate-on-miss CSRF vector is back
 * and this test must fail — GET_WRITE_OFFENDERS being []-asserted gives no
 * ongoing detection on its own. Word-boundary match (`\bNAME\s*\(`) so it fires
 * on a real call, not on a substring or an unrelated identifier.
 *
 * A new write-through helper reached from a GET must be ADDED here (and the
 * route split so the write lives on POST), never worked around.
 */
const WRITE_THROUGH_HELPERS = [
  "generateNarrative",
  "generateMacroThemes",
  "generateDigestSinceAdaptive",
  "getOrGenerateNarrative",
  "reconcileRecentCloudSends",
  "ensureIntelForEvents",
] as const;

function helperCallPattern(name: string): RegExp {
  return new RegExp(`\\b${name}\\s*\\(`);
}

/** Scan one GET body; return the labels of every write signal it contains. */
function scanGetBody(body: string): string[] {
  const hits: string[] = [];
  for (const { label, re } of WRITE_PATTERNS) {
    if (re.test(body)) hits.push(label);
  }
  for (const name of WRITE_THROUGH_HELPERS) {
    if (helperCallPattern(name).test(body)) {
      hits.push(`write-through helper ${name}()`);
    }
  }
  return hits;
}

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
      for (const label of scanGetBody(body)) {
        violations.push(`GET ${h.pathname}: GET body contains ${label}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("the scan would catch a planted write-through helper call in a GET body", () => {
    // Synthetic proof the guard covers the generate-on-miss vector that seeded
    // 4 of the 7 offenders — a future GET calling one of these helpers writes
    // inside lib/ (invisible to the .run(/INSERT scan) yet must still be caught.
    const plantedGet = `
      const { searchParams } = new URL(req.url);
      const scope = searchParams.get("scope");
      // read-through cache: generates + UPSERTs on a miss, inside lib/
      const r = await generateNarrative(db, { scope, surfaceKey: "risk-metrics", weekOf: week });
      return NextResponse.json({ success: true, ...r });
    `;
    const hits = scanGetBody(plantedGet);
    expect(hits).toContain("write-through helper generateNarrative()");

    // Every pinned helper name is individually detected.
    for (const name of WRITE_THROUGH_HELPERS) {
      expect(scanGetBody(`await ${name}(db, x);`)).toContain(
        `write-through helper ${name}()`,
      );
    }

    // And a genuinely side-effect-free GET body trips nothing.
    const cleanGet = `
      const cached = getCachedNarrative(db, scope, surface, week);
      if (cached) return NextResponse.json({ success: true, narrativeMd: cached.narrativeMd });
      return NextResponse.json({ success: true, narrativeMd: null, notGenerated: true });
    `;
    expect(scanGetBody(cleanGet)).toEqual([]);
  });
});
