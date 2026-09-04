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
 * The rule: from a "use client" file under app/dashboard/today/**, any import
 * of those trees (or of a non-allowlisted lib/print-watch module) must be
 * `import type`. Newlines are collapsed first so a Prettier-wrapped import is
 * still one specifier.
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
 * a hole that widens silently.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd(), "app", "dashboard", "today");

/** Kept in step with tests/repo/print-watch-import-boundaries.test.ts — the
 *  assertion below fails if the two lists drift apart. */
const CLIENT_SAFE = ["types", "first-pass-types", "reconcile", "first-pass-format", "extra-metrics"];

const TYPE_ONLY_TREES = ["@/lib/earnings/", "@/lib/queries/", "@/lib/digest/", "@/lib/calendar/"];

/**
 * Modules in the four server trees that a Today client file MAY value-import,
 * because they are pure: no db, no node builtins, no @stoqey/ib. Each entry is
 * asserted pure by the second test below, so this list can never become a hole.
 * The guard's real target is @/lib/earnings/cockpit-stages, which value-imports
 * @/lib/calendar/reaction-snapshot and @/lib/calendar/enrichment-runner and drags
 * @stoqey/ib across the client line — a build break, not a test failure.
 */
const CLIENT_SAFE_LIB = [
  "@/lib/earnings/actuals-validation",
  "@/lib/earnings/format-bogey-fields",
  "@/lib/calendar/date-utils",
];

/** What an allowlisted module may never reach for, directly or it stops being
 *  safe to bundle for the browser. */
const IMPURE_PREFIXES = ["node:", "better-sqlite3", "@stoqey/ib", "@/lib/db", "@/lib/ai/"];

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

/** Every `import … from "…"` specifier, with a flag for the `import type` form. */
function imports(source: string): Array<{ spec: string; typeOnly: boolean }> {
  const flat = source.replace(/\n/g, " ");
  const out: Array<{ spec: string; typeOnly: boolean }> = [];
  for (const m of flat.matchAll(/import\s+(type\s+)?([^"';]*?)from\s*["']([^"']+)["']/g)) {
    out.push({ spec: m[3], typeOnly: Boolean(m[1]) });
  }
  return out;
}

/** "@/lib/x/y" -> the repo-relative source file that backs it. */
function sourceFileFor(spec: string): string {
  const rel = spec.replace(/^@\//, "");
  for (const ext of [".ts", ".tsx"]) {
    const candidate = path.join(process.cwd(), `${rel}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  const index = path.join(process.cwd(), rel, "index.ts");
  if (fs.existsSync(index)) return index;
  throw new Error(`allowlisted module ${spec} does not resolve to a source file`);
}

describe("Today's client files cross the server line with types only", () => {
  it("keeps the client-safe list in step with the print-watch boundary guard", () => {
    const sibling = fs.readFileSync("tests/repo/print-watch-import-boundaries.test.ts", "utf8");
    for (const name of CLIENT_SAFE) expect(sibling, `${name} missing from the sibling guard`).toContain(`"${name}"`);
  });

  it("every value-importable server module on the allowlist is actually pure", () => {
    const offenders: string[] = [];
    for (const spec of CLIENT_SAFE_LIB) {
      const file = sourceFileFor(spec);
      for (const { spec: dep } of imports(fs.readFileSync(file, "utf8"))) {
        if (IMPURE_PREFIXES.some((p) => dep === p || dep.startsWith(p))) {
          offenders.push(`${spec} imports ${dep}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never value-imports a server tree from a \"use client\" file", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const raw = fs.readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/m.test(raw)) continue;
      for (const { spec, typeOnly } of imports(raw)) {
        if (mustBeTypeOnly(spec) && !typeOnly) {
          offenders.push(`${path.relative(process.cwd(), file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
