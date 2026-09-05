/**
 * Repo guard, slice F (M-F18, Codex round 1 #18). The existing
 * tests/repo/print-watch-import-boundaries.test.ts covers `lib/print-watch`;
 * it does NOT cover what a Today client file may pull out of `lib/earnings`,
 * `lib/queries`, `lib/digest` or `lib/calendar` — and `lib/earnings/cockpit-stages.ts`,
 * which F's chips need the TYPES from, value-imports @/lib/calendar/reaction-snapshot
 * and @/lib/calendar/enrichment-runner, which pull @stoqey/ib and half of lib/.
 * A value import from a "use client" file there does not fail a test; it fails
 * `next build` outright (R-D20).
 *
 * The rule: from a file that is compiled into the browser bundle, any import of
 * those trees (or of a non-allowlisted lib/print-watch module) must be
 * `import type`. Newlines are collapsed first so a Prettier-wrapped import is
 * still one specifier.
 *
 * WHICH FILES ARE SCANNED (fix round 1, review I1). The `"use client"` directive
 * is NOT the test — a module with no directive is bundled for the browser the
 * moment a client component value-imports it, and the guard's single most
 * important target lives in exactly such a file: `hub-live/types.ts` is the only
 * module in the repo that imports `@/lib/earnings/cockpit-stages`. So the scan
 * set is three unions:
 *
 *   (a) every `"use client"` file under app/dashboard/today/**;
 *   (b) EVERY file under app/dashboard/today/hub-live/** and
 *       app/dashboard/today/live-print/**, which are client-only subtrees by
 *       construction (F's plan creates nothing else in them);
 *   (c) everything else under app/dashboard/today/** that (a) or (b) reaches
 *       through a relative import, transitively.
 *
 * It is deliberately NOT "every file under app/dashboard/today/**": that
 * directory legitimately holds SERVER components (page.tsx, EarningsHub.tsx,
 * WeekAheadView.tsx, SignificantMovesCard.tsx) whose whole job is to
 * value-import `@/lib/queries/…` and the db singleton.
 *
 * Ruling R-F3 (slice F controller) — the allowlist below and the purity test
 * that guards it. The rule as first written red-lighted FOUR value imports that
 * already existed on `main` and build fine:
 *
 *   BogeysEditModal.tsx    -> @/lib/earnings/actuals-validation   { parseActualsInput }
 *   BogeysEditModal.tsx    -> @/lib/earnings/format-bogey-fields  { formatBogeyFields, … }
 *   EarningsDateChip.tsx   -> @/lib/calendar/date-utils           { todayET }
 *   EarningsHubAddForm.tsx -> @/lib/calendar/date-utils           { addDays, … }
 *
 * All three modules are provably pure, so the honest fix is an allowlist with
 * teeth rather than a weaker rule: a blanket ban that red-lights working code is
 * a guard the next person deletes, and a bare allowlist with no purity check is
 * a hole that widens silently. The purity check is TRANSITIVE (review I2): the
 * hazard shape it exists to stop is `cockpit-stages -> reaction-snapshot ->
 * @stoqey/ib`, which no depth-1 check can see.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO = process.cwd();
const ROOT = path.join(REPO, "app", "dashboard", "today");

/** Client-only by construction: everything in them ships to the browser, so
 *  every file in them is scanned whether or not it carries the directive. */
const CLIENT_ONLY_SUBTREES = [path.join(ROOT, "hub-live"), path.join(ROOT, "live-print")];

/** Kept in step with tests/repo/print-watch-import-boundaries.test.ts — the
 *  assertion below fails if the two lists drift apart, in EITHER direction. */
const CLIENT_SAFE = ["types", "first-pass-types", "reconcile", "first-pass-format", "extra-metrics"];

const TYPE_ONLY_TREES = ["@/lib/earnings/", "@/lib/queries/", "@/lib/digest/", "@/lib/calendar/"];

/**
 * Modules in the four server trees that a Today client file MAY value-import,
 * because they are pure: no db, no node builtins, no @stoqey/ib. Each entry is
 * asserted pure — transitively — by the second test below, so this list can
 * never become a hole.
 * The guard's real target is @/lib/earnings/cockpit-stages, which value-imports
 * @/lib/calendar/reaction-snapshot and @/lib/calendar/enrichment-runner and drags
 * @stoqey/ib across the client line — a build break, not a test failure.
 */
const CLIENT_SAFE_LIB = [
  "@/lib/earnings/actuals-validation",
  "@/lib/earnings/format-bogey-fields",
  "@/lib/calendar/date-utils",
];

/** What an allowlisted module may never reach for, directly or transitively, or
 *  it stops being safe to bundle for the browser. */
const IMPURE_PREFIXES = ["node:", "better-sqlite3", "@stoqey/ib", "@/lib/db", "@/lib/ai/"];

/** Naming ANY of these — in a type position too — is the signature of a SERVER
 *  module, so none may appear anywhere in the client-only subtrees. */
const SERVER_MARKERS = ["node:", "better-sqlite3", "@stoqey/ib", "@/lib/db"];

/** Defensive cap on the transitive purity walk (a cycle is already handled by
 *  the visited set; this catches a pathological graph). */
const MAX_PURITY_DEPTH = 12;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function mustBeTypeOnly(spec: string): boolean {
  if (CLIENT_SAFE_LIB.includes(spec)) return false;
  if (TYPE_ONLY_TREES.some((t) => spec.startsWith(t))) return true;
  if (spec.startsWith("@/lib/print-watch/")) {
    // `module` (the plan's name) is a reserved identifier under Next's lint.
    const moduleName = spec.slice("@/lib/print-watch/".length);
    return !CLIENT_SAFE.includes(moduleName);
  }
  return false;
}

/**
 * Every module specifier in a file, with the 1-based line the SPECIFIER sits on
 * and a flag for the erased-at-build `import type` / `export type` form.
 *
 * Newline → space keeps every character offset identical, so a match index
 * still maps back to a real line while a Prettier-wrapped statement reads as
 * one string. Five forms, covering everything the sibling guard's `importSpecs`
 * catches plus the type flag this one needs (M1): static `import … from`,
 * `export … from` (a VALUE re-export out of a client file is a real leak),
 * bare side-effect `import "…"`, dynamic `import("…")` and `require("…")`.
 *
 * The clause list between the keyword and `from` is matched EXACTLY rather than
 * as "anything without a quote": a loose `[^"\';]*?` bridge reads straight
 * across a doc comment, and this file's own subjects have prose like
 * "every export is a type" sitting two lines above a real import.
 */
export function imports(source: string): Array<{ spec: string; typeOnly: boolean; line: number }> {
  const flat = source.replace(/\n/g, " ");
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  const out: Array<{ spec: string; typeOnly: boolean; line: number }> = [];
  const NAME = "[A-Za-z_$][\\w$]*";
  const CLAUSE = `(?:\\*\\s+as\\s+${NAME}|\\{[^{}]*\\}|${NAME})`;
  const patterns: Array<{ re: RegExp; typeGroup: number; specGroup: number }> = [
    // import x / {a} / * as x / type {a} / x, {a}  from "…"
    {
      re: new RegExp(`\\bimport\\s+(type\\s+)?(?:${NAME}\\s*,\\s*)?${CLAUSE}\\s*from\\s*["']([^"']+)["']`, "g"),
      typeGroup: 1,
      specGroup: 2,
    },
    // export * / * as x / {a}  from "…"
    {
      re: new RegExp(`\\bexport\\s+(type\\s+)?(?:\\*(?:\\s+as\\s+${NAME})?|\\{[^{}]*\\})\\s*from\\s*["']([^"']+)["']`, "g"),
      typeGroup: 1,
      specGroup: 2,
    },
    // bare side-effect import — cannot match `import(`, whose next char is `(`
    { re: /\bimport\s*["']([^"']+)["']/g, typeGroup: 0, specGroup: 1 },
    { re: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, typeGroup: 0, specGroup: 1 },
    { re: /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, typeGroup: 0, specGroup: 1 },
  ];
  for (const { re, typeGroup, specGroup } of patterns) {
    for (const m of flat.matchAll(re)) {
      const spec = m[specGroup];
      out.push({
        spec,
        typeOnly: typeGroup > 0 && Boolean(m[typeGroup]),
        line: lineOf((m.index ?? 0) + m[0].lastIndexOf(spec)),
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** "@/lib/x/y" -> the repo-relative source file that backs it. Throws, loudly
 *  and from inside the test, when an allowlist entry stops resolving. */
function sourceFileFor(spec: string): string {
  const rel = spec.replace(/^@\//, "");
  for (const ext of [".ts", ".tsx"]) {
    const candidate = path.join(REPO, `${rel}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const index of ["index.ts", "index.tsx"]) {
    const candidate = path.join(REPO, rel, index);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`allowlisted module ${spec} does not resolve to a source file`);
}

/** A specifier -> a file inside this repo, or null for a bare package (judged
 *  by prefix, never walked) and for anything with no .ts/.tsx behind it. */
function resolveInRepo(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(REPO, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const ext of [".ts", ".tsx"]) if (fs.existsSync(base + ext)) return base + ext;
  for (const index of ["index.ts", "index.tsx"]) {
    const candidate = path.join(base, index);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const rel = (file: string) => path.relative(REPO, file);

/** (a) + (b) + (c): every file under app/dashboard/today that ends up in the
 *  browser bundle. Server components are reached by nothing here, so they stay
 *  out — which is the whole point. */
function bundledClientFiles(): string[] {
  const all = walk(ROOT);
  const seeds = all.filter(
    (file) =>
      CLIENT_ONLY_SUBTREES.some((dir) => file.startsWith(dir + path.sep)) ||
      /^\s*["']use client["']/m.test(fs.readFileSync(file, "utf8")),
  );
  const reached = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const file = queue.pop()!;
    for (const { spec } of imports(fs.readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const dep = resolveInRepo(spec, file);
      // Bounded to ROOT on purpose: the shared app/dashboard/components tree is
      // another slice's territory and has its own reviewers.
      if (!dep || !dep.startsWith(ROOT + path.sep) || reached.has(dep)) continue;
      reached.add(dep);
      queue.push(dep);
    }
  }
  return [...reached].sort();
}

describe("Today's client files cross the server line with types only", () => {
  it("sees wrapped, dynamic, bare and re-export specifiers, not just single-line ones", () => {
    const wrapped = ["import {", "  todayET,", '} from "@/lib/calendar/date-utils";'].join("\n");
    expect(imports(wrapped)).toEqual([{ spec: "@/lib/calendar/date-utils", typeOnly: false, line: 3 }]);
    expect(imports('import type { X } from "@/lib/queries/x";')).toEqual([
      { spec: "@/lib/queries/x", typeOnly: true, line: 1 },
    ]);
    expect(imports('export { x } from "@/lib/earnings/x";')).toEqual([
      { spec: "@/lib/earnings/x", typeOnly: false, line: 1 },
    ]);
    expect(imports('const m = await import("@/lib/earnings/x");')).toEqual([
      { spec: "@/lib/earnings/x", typeOnly: false, line: 1 },
    ]);
    expect(imports('import "@/lib/earnings/x";')).toEqual([
      { spec: "@/lib/earnings/x", typeOnly: false, line: 1 },
    ]);
    expect(imports('const m = require("@/lib/earnings/x");')).toEqual([
      { spec: "@/lib/earnings/x", typeOnly: false, line: 1 },
    ]);
  });

  it("keeps the client-safe list in step with the print-watch boundary guard", () => {
    const sibling = fs.readFileSync("tests/repo/print-watch-import-boundaries.test.ts", "utf8");
    const literal = sibling.match(/const CLIENT_SAFE\s*=\s*\[([^\]]*)\]/);
    expect(literal, "the sibling guard no longer declares a CLIENT_SAFE array").not.toBeNull();
    const theirs = [...literal![1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    // Set equality, both directions: a name ADDED there and missing here would
    // silently widen what this guard lets across the line.
    expect([...theirs].sort()).toEqual([...CLIENT_SAFE].sort());
  });

  it("every value-importable server module on the allowlist is pure — transitively", () => {
    const offenders: string[] = [];
    for (const spec of CLIENT_SAFE_LIB) {
      const entry = sourceFileFor(spec);
      const seen = new Set<string>([entry]);
      let frontier = [{ file: entry, chain: spec }];
      let depth = 0;
      while (frontier.length && depth < MAX_PURITY_DEPTH) {
        const next: Array<{ file: string; chain: string }> = [];
        for (const { file, chain } of frontier) {
          for (const { spec: dep, line } of imports(fs.readFileSync(file, "utf8"))) {
            if (IMPURE_PREFIXES.some((p) => dep === p || dep.startsWith(p))) {
              offenders.push(`${chain} -> ${dep} (${rel(file)}:${line})`);
              continue;
            }
            const depFile = resolveInRepo(dep, file);
            if (!depFile || seen.has(depFile)) continue;
            seen.add(depFile);
            next.push({ file: depFile, chain: `${chain} -> ${dep}` });
          }
        }
        frontier = next;
        depth += 1;
      }
      if (frontier.length) offenders.push(`${spec}: import graph deeper than ${MAX_PURITY_DEPTH}`);
    }
    expect(offenders).toEqual([]);
  });

  it("never value-imports a server tree from a file that ships to the browser", () => {
    const offenders: string[] = [];
    for (const file of bundledClientFiles()) {
      for (const { spec, typeOnly, line } of imports(fs.readFileSync(file, "utf8"))) {
        if (mustBeTypeOnly(spec) && !typeOnly) offenders.push(`${rel(file)}:${line} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the hub-live and live-print subtrees hold no server component at all", () => {
    const offenders: string[] = [];
    for (const dir of CLIENT_ONLY_SUBTREES) {
      for (const file of walk(dir)) {
        for (const { spec, line } of imports(fs.readFileSync(file, "utf8"))) {
          // Type position included: a client-only subtree has no business
          // naming the db singleton, a node builtin or the broker SDK at all.
          if (SERVER_MARKERS.some((p) => spec === p || spec.startsWith(p))) {
            offenders.push(`${rel(file)}:${line} names ${spec}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually scans the three modules Task 6 created, none of which carries a directive", () => {
    const scanned = bundledClientFiles().map(rel);
    for (const name of ["types.ts", "poll-controller.ts", "expansion.ts"]) {
      expect(scanned, `${name} escaped the scan`).toContain(`app/dashboard/today/hub-live/${name}`);
    }
    // …and the genuine server components stay OUT, or the guard would red-light
    // the db singleton they are supposed to import.
    for (const name of ["page.tsx", "EarningsHub.tsx", "WeekAheadView.tsx"]) {
      expect(scanned, `${name} is a server component and must not be scanned`).not.toContain(
        `app/dashboard/today/${name}`,
      );
    }
  });
});
