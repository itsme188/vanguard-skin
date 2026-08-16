# Evidence-Driven Verification Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `verify:changed` (changed-path → focused-test selector), `verify:smoke` (agent-browser smoke with evidence), and the verification-loop doc + evidence template, per issue #52.

**Architecture:** A pure, data-driven mapping module (`scripts/lib/verify-mapping.ts`) consumed by a thin CLI (`scripts/verify-changed.ts`); a bash smoke script (`scripts/verify-smoke.sh`) that drives the `agent-browser` CLI the same way `qa/run-qa.sh` does; one reference doc. No new dependencies, no schema changes, no product-behavior changes.

**Tech Stack:** TypeScript via `tsx`, Vitest, bash 3.2 (macOS), `agent-browser` CLI, `sqlite3` CLI (read-only checks only).

**Spec:** `docs/superpowers/specs/2026-08-16-verification-loop-design.md` — read it first; it carries the Codex-review resolutions and the exact scope boundaries.

## Global Constraints

- Test/tsx runs always use the node@24 pin: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run …` / `npx tsx …`.
- No new npm dependencies. No `npm install`, no `npm rebuild`, no schema changes, no migrations.
- `verify:changed` must never write files, touch the DB, or make network calls.
- `verify:smoke` must never start a server (Turbopack single-writer rule), never click the import commit button, never print the password or portfolio values, and only ever reads the DB via read-only sqlite queries. Bounded exception: a successful login creates a server-side session row, exactly as any manual login does — that is the only state the smoke leaves behind.
- Commit messages: write to a temp file and use `git commit -F <file>` — never inline `-m` (macOS bash 3.2 quoting rule).
- All dates `YYYY-MM-DD`. Scripts carry the house JSDoc header (filename — purpose, then `Usage:` lines with literal `npx tsx scripts/<name>.ts` commands); no shebang (dominant house style).
- bash scripts must pass `bash -n` after editing (heredoc-apostrophe gate).

---

### Task 1: Mapping engine (`planVerification`)

**Files:**
- Create: `scripts/lib/verify-mapping.ts`
- Test: `tests/verify/verify-mapping.test.ts`

**Interfaces:**
- Produces: `type MappingEntry`, `type Plan`, `planVerification(changedPaths: string[]): Plan`, `formatPlan(plan: Plan): string`, and the exported `MAPPING: MappingEntry[]` table. Task 3's CLI imports `planVerification` and `formatPlan`.

- [ ] **Step 1: Write the failing tests**

Create `tests/verify/verify-mapping.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planVerification, formatPlan, MAPPING } from "../../scripts/lib/verify-mapping";

describe("planVerification", () => {
  it("maps compute changes to tests/compute/", () => {
    const plan = planVerification(["lib/compute/risk.ts"]);
    expect(plan.selectedTests).toContain("tests/compute/");
    expect(plan.unmatched).toEqual([]);
  });

  it("maps queries and mutations changes to their test dirs", () => {
    const plan = planVerification(["lib/queries/holdings.ts", "lib/mutations/calendar.ts"]);
    expect(plan.selectedTests).toContain("tests/queries/");
    expect(plan.selectedTests).toContain("tests/mutations/");
  });

  it("maps lib/format.ts to the format test file", () => {
    const plan = planVerification(["lib/format.ts"]);
    expect(plan.selectedTests).toContain("tests/lib/format.test.ts");
  });

  it("maps import and import-API changes to tests/import/", () => {
    const plan = planVerification(["lib/import/parsers/vanguard-holdings.ts", "app/api/import/route.ts"]);
    expect(plan.selectedTests).toContain("tests/import/");
  });

  it("maps generic API changes to api/auth test dirs with a route-policy reminder", () => {
    const plan = planVerification(["app/api/levels/route.ts"]);
    expect(plan.selectedTests).toEqual(
      expect.arrayContaining(["tests/api/", "tests/apis/", "tests/http/", "tests/auth/"])
    );
    expect(plan.reminders.join(" ")).toContain("proxy.ts route policy");
  });

  it("flags browser verification for dashboard UI changes", () => {
    const plan = planVerification(["app/dashboard/components/LevelsPanel.tsx"]);
    expect(plan.selectedTests).toContain("tests/dashboard/");
    expect(plan.reminders.join(" ")).toContain("Browser verification required");
  });

  it("maps worker changes to BOTH tests/cron/ and tests/workers/ with the parity reminder", () => {
    const plan = planVerification(["workers/cron/src/html.ts"]);
    expect(plan.selectedTests).toContain("tests/cron/");
    expect(plan.selectedTests).toContain("tests/workers/");
    expect(plan.reminders.join(" ")).toContain("lib/calendar/briefing-html.ts");
  });

  it("gives the paired parity reminder from the Mac side too", () => {
    const plan = planVerification(["lib/gmail/theme-sanitize.ts"]);
    expect(plan.reminders.join(" ")).toContain("workers/cron/src/fallback-digest.ts");
  });

  it("migrations get a manual reminder and NO auto test targets", () => {
    const plan = planVerification(["lib/db/migrations/071-new-table.sql"]);
    expect(plan.selectedTests).toEqual([]);
    expect(plan.reminders.join(" ")).toContain("never applies migrations");
    // migrations must NOT also match the lib/db/ entry
    expect(plan.selectedTests).not.toContain("tests/db/");
  });

  it("selects a changed test file directly (untracked new test included)", () => {
    const plan = planVerification(["tests/auth/login-page.test.ts"]);
    expect(plan.directTests).toEqual(["tests/auth/login-page.test.ts"]);
    expect(plan.selectedTests).toContain("tests/auth/login-page.test.ts");
    expect(plan.unmatched).toEqual([]);
  });

  it("unknown paths land in unmatched, never in selectedTests", () => {
    const plan = planVerification(["some/new/area/thing.ts"]);
    expect(plan.unmatched).toEqual(["some/new/area/thing.ts"]);
    expect(plan.selectedTests).toEqual([]);
  });

  it("tooling/docs paths produce the no-focused-test message, not unmatched", () => {
    const plan = planVerification(["scripts/verify-changed.ts", "docs/plans/TODO.md", "qa/run-qa.sh"]);
    expect(plan.selectedTests).toEqual([]);
    expect(plan.unmatched).toEqual([]);
    expect(plan.categories).toContain("tooling");
  });

  it("empty input yields an empty plan", () => {
    const plan = planVerification([]);
    expect(plan.selectedTests).toEqual([]);
    expect(plan.reminders).toEqual([]);
    expect(plan.unmatched).toEqual([]);
  });

  it("every mapped test target exists on disk", async () => {
    const { existsSync } = await import("node:fs");
    for (const entry of MAPPING) {
      for (const target of entry.testTargets) {
        expect(existsSync(target), `${entry.category}: ${target} missing`).toBe(true);
      }
    }
  });

  it("formatPlan output is deterministic and sorted", () => {
    const a = formatPlan(planVerification(["lib/mutations/x.ts", "lib/queries/y.ts"]));
    const b = formatPlan(planVerification(["lib/queries/y.ts", "lib/mutations/x.ts"]));
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/verify/verify-mapping.test.ts`
Expected: FAIL — cannot resolve `scripts/lib/verify-mapping`.

- [ ] **Step 3: Implement `scripts/lib/verify-mapping.ts`**

```ts
/**
 * verify-mapping.ts — Pure changed-path → focused-check planner for `npm run verify:changed`.
 *
 * Usage: imported by scripts/verify-changed.ts; not run directly.
 *
 * The mapping is DATA (ordered MAPPING table below), per issue #52: each entry
 * pairs path-prefix matchers with vitest targets and human reminders. Entries
 * are evaluated in order per changed path; an entry with `exclusive: true`
 * (migrations) claims its path and stops later entries from also matching it
 * (lib/db/migrations/** must not drag in tests/db/). Multiple non-exclusive
 * matches union their targets. Paths matching nothing land in `unmatched` —
 * the CLI reports "manual selection required"; it NEVER falls back to a broad
 * test run.
 */

export type MappingEntry = {
  category: string;
  /** repo-relative path prefixes; a trailing "/" means directory prefix */
  match: string[];
  testTargets: string[];
  reminders: string[];
  /** when true, a matching path is claimed and later entries skip it */
  exclusive?: boolean;
};

export type Plan = {
  changed: string[];
  directTests: string[];
  selectedTests: string[];
  categories: string[];
  reminders: string[];
  unmatched: string[];
};

const MIRROR_REMINDER =
  "Parity-pinned Mac↔Worker mirrors — change both sides (see CLAUDE.md pinned list). " +
  "Known pairs: lib/calendar/briefing-html.ts ↔ workers/cron/src/html.ts; " +
  "lib/gmail/theme-sanitize.ts ↔ workers/cron/src/fallback-digest.ts.";

export const MAPPING: MappingEntry[] = [
  {
    category: "migrations",
    match: ["lib/db/migrations/"],
    testTargets: [],
    reminders: [
      "Migration touched — verify:changed never applies migrations. " +
        "Test via lib/db/migrate.ts against a DB COPY first; back up data/vanguard.db before applying live.",
    ],
    exclusive: true,
  },
  {
    category: "compute",
    match: ["lib/compute/", "lib/chart/", "lib/format.ts", "lib/format/"],
    testTargets: ["tests/compute/", "tests/chart/", "tests/lib/format.test.ts"],
    reminders: [],
  },
  {
    category: "db",
    match: ["lib/queries/", "lib/mutations/", "lib/db/"],
    testTargets: ["tests/queries/", "tests/mutations/", "tests/db/"],
    reminders: [],
  },
  {
    category: "import",
    match: ["lib/import/", "app/api/import/"],
    testTargets: ["tests/import/"],
    reminders: [],
  },
  {
    category: "api",
    match: ["app/api/", "proxy.ts", "lib/auth/"],
    testTargets: ["tests/api/", "tests/apis/", "tests/http/", "tests/auth/"],
    reminders: [
      "New/renamed route? Update proxy.ts route policy + tests/auth/route-policy.test.ts.",
    ],
  },
  {
    category: "ui",
    match: ["app/dashboard/", "app/login/", "components/", "lib/privacy/"],
    testTargets: ["tests/dashboard/", "tests/pages/"],
    reminders: [
      "Browser verification required — restart the dev server first if any server-side code changed (npm run verify:smoke).",
    ],
  },
  {
    category: "tws",
    match: ["lib/tws/", "lib/ibkr/"],
    testTargets: ["tests/tws/", "tests/ibkr/", "tests/contracts/"],
    reminders: [],
  },
  {
    category: "email-calendar",
    match: [
      "lib/calendar/",
      "lib/email.ts",
      "lib/email/",
      "lib/digest/",
      "lib/earnings/",
      "lib/gmail/",
      "lib/alerts/",
      "lib/levels/",
    ],
    testTargets: [
      "tests/calendar/",
      "tests/email/",
      "tests/digest/",
      "tests/earnings/",
      "tests/gmail/",
      "tests/alerts/",
      "tests/levels/",
    ],
    reminders: [MIRROR_REMINDER],
  },
  {
    category: "ai",
    match: ["lib/ai/", "lib/chat/", "lib/claude-models.ts"],
    testTargets: ["tests/ai/", "tests/chat/"],
    reminders: [],
  },
  {
    category: "worker",
    match: ["workers/cron/"],
    testTargets: ["tests/cron/", "tests/workers/"],
    reminders: [MIRROR_REMINDER],
  },
  {
    category: "tooling",
    match: [
      "scripts/",
      "qa/",
      "docs/",
      "electron/",
      ".claude/",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "vitest.config.ts",
      "eslint.config.mjs",
      ".gitignore",
      "README.md",
      "CLAUDE.md",
      "AGENTS.md",
    ],
    testTargets: [],
    reminders: [
      "Tooling/docs-only change — no focused tests mapped; run what the change itself documents. " +
        "(electron/ changes: tests/electron/ exists — add it manually if lib logic moved.)",
    ],
  },
];

const TEST_FILE_RE = /^tests\/.+\.test\.tsx?$/;

function entryMatches(entry: MappingEntry, p: string): boolean {
  return entry.match.some((m) => (m.endsWith("/") ? p.startsWith(m) : p === m || p.startsWith(m)));
}

export function planVerification(changedPaths: string[]): Plan {
  const directTests: string[] = [];
  const selected = new Set<string>();
  const categories = new Set<string>();
  const reminders = new Set<string>();
  const unmatched: string[] = [];

  for (const p of [...changedPaths].sort()) {
    if (TEST_FILE_RE.test(p)) {
      directTests.push(p);
      selected.add(p);
      continue;
    }
    let matchedAny = false;
    for (const entry of MAPPING) {
      if (!entryMatches(entry, p)) continue;
      matchedAny = true;
      categories.add(entry.category);
      entry.testTargets.forEach((t) => selected.add(t));
      entry.reminders.forEach((r) => reminders.add(r));
      if (entry.exclusive) break;
    }
    if (!matchedAny) unmatched.push(p);
  }

  return {
    changed: [...changedPaths].sort(),
    directTests: directTests.sort(),
    selectedTests: [...selected].sort(),
    categories: [...categories].sort(),
    reminders: [...reminders].sort(),
    unmatched: unmatched.sort(),
  };
}

export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  const section = (title: string, items: string[]) => {
    lines.push(`${title}:`);
    if (items.length === 0) lines.push("  (none)");
    else items.forEach((i) => lines.push(`  - ${i}`));
  };
  section("Changed files", plan.changed);
  section("Matched categories", plan.categories);
  section("Selected test targets", plan.selectedTests);
  section("Reminders", plan.reminders);
  section("Unmatched paths (manual test selection required)", plan.unmatched);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/verify/verify-mapping.test.ts`
Expected: PASS (15 tests). If the exists-on-disk test fails, fix the MAPPING table (not the test) — a mapped target that doesn't exist is a mapping bug.

- [ ] **Step 5: Commit**

```bash
printf '%s\n' "feat(verify): pure changed-path->test planner for verify:changed (#52)" > /tmp/vgs-commit.txt
git add scripts/lib/verify-mapping.ts tests/verify/verify-mapping.test.ts
git commit -F /tmp/vgs-commit.txt
```

---

### Task 2: Git changed-files collector (`--porcelain=v1 -z`)

**Files:**
- Create: `scripts/lib/git-changed.ts`
- Test: `tests/verify/git-changed.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `parsePorcelainZ(raw: string): string[]` (pure) and `getChangedFiles(): string[]` (runs git). Task 3's CLI imports `getChangedFiles`; tests use `parsePorcelainZ`.

- [ ] **Step 1: Write the failing tests**

Create `tests/verify/git-changed.test.ts`. Porcelain v1 `-z` format facts the tests encode: records are NUL-terminated `XY <path>`; when X or Y is `R`/`C` the record is followed by ONE extra NUL-terminated field (the ORIGINAL path); untracked records are `?? <path>`; paths with spaces are NOT quoted under `-z`.

```ts
import { describe, it, expect } from "vitest";
import { parsePorcelainZ } from "../../scripts/lib/git-changed";

const NUL = "\0";

describe("parsePorcelainZ", () => {
  it("parses staged, unstaged, and untracked records", () => {
    const raw = [`M  lib/compute/risk.ts`, ` M lib/queries/holdings.ts`, `?? tests/auth/login-page.test.ts`].join(NUL) + NUL;
    expect(parsePorcelainZ(raw)).toEqual([
      "lib/compute/risk.ts",
      "lib/queries/holdings.ts",
      "tests/auth/login-page.test.ts",
    ]);
  });

  it("takes the NEW path for renames and skips the original-path field", () => {
    const raw = `R  lib/new-name.ts${NUL}lib/old-name.ts${NUL}M  lib/other.ts${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual(["lib/new-name.ts", "lib/other.ts"]);
  });

  it("handles paths with spaces (unquoted under -z)", () => {
    const raw = `?? docs/My Notes File.md${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual(["docs/My Notes File.md"]);
  });

  it("returns [] for empty output", () => {
    expect(parsePorcelainZ("")).toEqual([]);
  });

  it("dedupes a path that is both staged and unstaged", () => {
    const raw = `MM lib/compute/risk.ts${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual(["lib/compute/risk.ts"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/verify/git-changed.test.ts`
Expected: FAIL — cannot resolve `scripts/lib/git-changed`.

- [ ] **Step 3: Implement `scripts/lib/git-changed.ts`**

```ts
/**
 * git-changed.ts — Collect changed files for verify:changed via
 * `git status --porcelain=v1 -z` (staged + unstaged + untracked; -z avoids
 * quoted-path ambiguity). Read-only: runs exactly one git status command.
 *
 * Usage: imported by scripts/verify-changed.ts; not run directly.
 */
import { execFileSync } from "node:child_process";

export function parsePorcelainZ(raw: string): string[] {
  const fields = raw.split("\0");
  const out: string[] = [];
  let i = 0;
  while (i < fields.length) {
    const rec = fields[i];
    i += 1;
    if (!rec) continue; // trailing empty field after final NUL
    const status = rec.slice(0, 2);
    const p = rec.slice(3);
    if (p) out.push(p);
    // rename/copy records carry ONE extra field: the original path — skip it
    if (status.includes("R") || status.includes("C")) i += 1;
  }
  return [...new Set(out)];
}

export function getChangedFiles(): string[] {
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return parsePorcelainZ(raw);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/verify/git-changed.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
printf '%s\n' "feat(verify): porcelain-z changed-file collector (#52)" > /tmp/vgs-commit.txt
git add scripts/lib/git-changed.ts tests/verify/git-changed.test.ts
git commit -F /tmp/vgs-commit.txt
```

---

### Task 3: `verify:changed` CLI + npm script

**Files:**
- Create: `scripts/verify-changed.ts`
- Modify: `package.json` (add one script line)

**Interfaces:**
- Consumes: `planVerification`, `formatPlan` from `scripts/lib/verify-mapping.ts`; `getChangedFiles` from `scripts/lib/git-changed.ts`.
- Produces: `npm run verify:changed [-- --dry-run]`. Exit codes: 0 on clean tree / dry-run / reminder-only plan / passing tests; vitest's exit code otherwise.

- [ ] **Step 1: Implement `scripts/verify-changed.ts`**

(No unit test for the CLI wrapper itself — all logic is in the two tested modules; the CLI is verified by the Step 3 dry-run below.)

```ts
/**
 * verify-changed.ts — Select and run the smallest relevant Vitest checks for
 * the current working diff. Part of the #52 evidence-driven verification loop.
 *
 * Usage:
 *   npm run verify:changed                # plan + run selected tests
 *   npm run verify:changed -- --dry-run   # plan only, deterministic output
 *
 * Guarantees: read-only (one `git status`), never applies migrations, never
 * touches the DB, no network. With zero selected targets it exits 0 WITHOUT
 * invoking vitest (a bare `vitest run` would run the full suite).
 */
import { spawnSync } from "node:child_process";
import { planVerification, formatPlan } from "./lib/verify-mapping";
import { getChangedFiles } from "./lib/git-changed";

const dryRun = process.argv.includes("--dry-run");

const changed = getChangedFiles();
if (changed.length === 0) {
  console.log("Working tree clean — nothing to verify.");
  process.exit(0);
}

const plan = planVerification(changed);
console.log(formatPlan(plan));
console.log("");
console.log("Recommended optional checks (not run automatically):");
console.log("  npx tsc --noEmit");
console.log("  npx next build");

if (dryRun) process.exit(0);

if (plan.selectedTests.length === 0) {
  console.log("");
  console.log("No focused tests mapped — manual test selection required (see reminders above).");
  process.exit(0);
}

const env = {
  ...process.env,
  PATH: `/opt/homebrew/opt/node@24/bin:${process.env.PATH ?? ""}`,
};
console.log("");
console.log(`Running: npx vitest run ${plan.selectedTests.join(" ")}`);
const res = spawnSync("npx", ["vitest", "run", ...plan.selectedTests], {
  stdio: "inherit",
  env,
});
process.exit(res.status ?? 1);
```

- [ ] **Step 2: Add the npm script**

In `package.json` "scripts", after the `"seed:demo"` line, add:

```json
"verify:changed": "tsx scripts/verify-changed.ts",
```

- [ ] **Step 3: Verify with a real dry-run**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify:changed -- --dry-run`
Expected: the current diff (this task's own files) prints under "Changed files", category `tooling` matches for `scripts/**` + `package.json`, `tests/verify/*.test.ts` files appear under direct selection if uncommitted, output ends with the optional-checks block, exit 0. Run it twice — byte-identical output both times (determinism).

- [ ] **Step 4: Verify the executing path on a synthetic compute diff**

```bash
touch lib/compute/.verify-probe.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify:changed 2>&1 | tail -5
rm lib/compute/.verify-probe.ts
```
Expected: it runs `npx vitest run tests/compute/ …` and the compute suite passes. (The probe file is untracked and deleted immediately after; `verify:changed` itself never creates or deletes anything.)

- [ ] **Step 5: Commit**

```bash
printf '%s\n' "feat(verify): verify:changed CLI + npm script (#52)" > /tmp/vgs-commit.txt
git add scripts/verify-changed.ts package.json
git commit -F /tmp/vgs-commit.txt
```

---

### Task 4: `verify:smoke` script

**Files:**
- Create: `scripts/verify-smoke.sh`
- Modify: `qa/.gitignore` (add `verify-evidence/` line — evidence lives under `qa/verify-evidence/`)
- Modify: `package.json` (add one script line)

**Interfaces:**
- Consumes: `qa/lib/agent-browser-cleanup.sh` (`ab_cleanup_init`), the `agent-browser` CLI (`open`, `wait`, `eval [--stdin]`, `screenshot`, `close`), `tests/fixtures/vanguard-holdings-sample.csv` (4 data rows → preview Securities 4 / Holdings 4 / Prices 4).
- Produces: `npm run verify:smoke`; evidence dir `qa/verify-evidence/<YYYY-MM-DD-HHMM>/` with screenshots + `summary.md`; exit 0 only if all four flows pass.

Hard-won facts (from code reading — do not rediscover):
- Login page `/login` SSR-renders `<h1>Portfolio Desk</h1>`; password input is `#password`; submit is `button[type="submit"]` labeled "Sign in". Login POST is JSON sent by the page's own JS — the script only fills the field and clicks.
- `APP_PASSWORD_HASH` is NOT in `.env.local` — a bare `npm run dev` server returns the "Login unavailable" error on submit. The packaged app (:3099) injects it from the keychain. The smoke script needs the PLAINTEXT password in env var `VERIFY_SMOKE_PASSWORD` (no existing var holds it; only the hash is stored anywhere).
- Privacy mode: `localStorage.setItem("vgs:privacyMode","1")` before navigating to authenticated pages (provider reads it on mount).
- Cmd+K: open via header `button[aria-label="Open search"]`; input selector `input[placeholder^="Jump to ticker"]`; no-match text starts with `No ticker matches`.
- Import: drop zone `[aria-label="File upload drop zone"]`; the hidden `input[type="file"]` can't be clicked — the flow uses a synthetic `DragEvent("drop")` with a `DataTransfer` carrying a `File` built from the fixture text. Preview heading is `Import Preview`; commit button label is `Import 1 file` (NEVER click it); `Cancel` exits preview.
- React inputs need the native-setter pattern: set value via `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set` then dispatch an `input` event, or React state won't update.

- [ ] **Step 1: Write `scripts/verify-smoke.sh`**

```bash
#!/usr/bin/env bash
# verify-smoke.sh — Browser smoke verification for the #52 verification loop.
#
# Usage:
#   VERIFY_SMOKE_PASSWORD=... npm run verify:smoke
#
# Detects a healthy server (dev :3000 first, packaged app :3099 fallback);
# NEVER starts one. Verifies app identity before any credential entry.
# Four flows: login surface, dashboard landing, import preview (never
# commits), Cmd+K no-match empty state. Evidence (screenshots + summary.md)
# goes to qa/verify-evidence/<timestamp>/ (gitignored). Privacy mode is
# enabled before authenticated screenshots. The password is read from
# VERIFY_SMOKE_PASSWORD and passed to the browser via `eval --stdin` only.
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"

# --- Preconditions -----------------------------------------------------------
command -v agent-browser >/dev/null 2>&1 || { echo "FAIL: agent-browser CLI not on PATH"; exit 1; }
if [ -z "${VERIFY_SMOKE_PASSWORD:-}" ]; then
  echo "FAIL: VERIFY_SMOKE_PASSWORD is not set."
  echo "Export the app password (the one the login page accepts) and re-run:"
  echo "  VERIFY_SMOKE_PASSWORD=... npm run verify:smoke"
  exit 1
fi

echo "NOTE: if you changed server-side code, restart the dev server before trusting this smoke."

# --- Server detection + identity check (before ANY credential use) ----------
BASE_URL=""
for port in 3000 3099; do
  html=$(curl -sf --max-time 5 "http://localhost:${port}/login" 2>/dev/null || true)
  if printf '%s' "$html" | grep -q "Portfolio Desk"; then
    # localhost (not 127.0.0.1): login cookies default to Secure, and
    # Secure-over-http is reliably accepted only for the localhost hostname.
    BASE_URL="http://localhost:${port}"
    break
  elif [ -n "$html" ]; then
    echo "WARN: port ${port} responded but is NOT Portfolio Desk — skipping (no credentials sent)."
  fi
done
if [ -z "$BASE_URL" ]; then
  echo "FAIL: no healthy Portfolio Desk server on :3000 or :3099."
  echo "Start one first (never done by this script — Turbopack is single-writer):"
  echo "  npm run dev            # dev server on :3000 (needs APP_PASSWORD_HASH in its env)"
  echo "  open the packaged app  # serves :3099 with keychain-injected auth"
  exit 1
fi
echo "Target: $BASE_URL"

# --- Evidence dir + cleanup --------------------------------------------------
STAMP=$(TZ=America/New_York date '+%Y-%m-%d-%H%M')
EVIDENCE="$PROJECT_DIR/qa/verify-evidence/$STAMP"
mkdir -p "$EVIDENCE"
SUMMARY="$EVIDENCE/summary.md"
SESSION="verify-smoke-$$"
source "$PROJECT_DIR/qa/lib/agent-browser-cleanup.sh"
ab_cleanup_init

PASS=0; FAIL=0
record() { # record <flow> <PASS|FAIL> <detail>
  echo "- **$1**: $2 — $3" >> "$SUMMARY"
  if [ "$2" = "PASS" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL[$1]: $3"; fi
}
# Every browser command is bounded at 30s (perl alarm — portable on macOS,
# bash-3.2 safe) so no flow can hang the smoke forever.
ab() { perl -e 'alarm shift; exec @ARGV' 30 agent-browser --session "$SESSION" "$@"; }
ab_eval() { ab eval --stdin 2>/dev/null | sed 's/^"//;s/"$//'; }

printf '%s\n' "# verify:smoke — $STAMP" "" "Target: $BASE_URL" "" "## Flows" "" > "$SUMMARY"

# --- Flow 1: login surface ---------------------------------------------------
ab open "$BASE_URL/login" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
h1=$(printf '%s' 'document.querySelector("h1")?.textContent || ""' | ab_eval)
ab screenshot "$EVIDENCE/1-login.png" >/dev/null 2>&1
if [ "$h1" = "Portfolio Desk" ]; then
  record "login-surface" PASS "h1 identity marker + screenshot 1-login.png"
else
  record "login-surface" FAIL "expected h1 'Portfolio Desk', got '$h1'"
fi

# Enable privacy mode BEFORE authenticating (same origin — persists post-login)
printf '%s' 'localStorage.setItem("vgs:privacyMode","1"); "ok"' | ab_eval >/dev/null

# --- Login (password via stdin eval only; never argv, never echoed) ---------
# read -r -d '' (quoted heredoc, NO command substitution): apostrophes inside
# are safe on bash 3.2; $(cat <<EOF) is the documented crash shape — never use it.
read -r -d '' LOGIN_JS <<'EOF' || true
(() => {
  const el = document.querySelector("#password");
  if (!el) return "no-input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, __PW__);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  setTimeout(() => document.querySelector('button[type="submit"]')?.click(), 50);
  return "submitted";
})()
EOF
# Substitute the password as a JSON string literal (handles quotes/backslashes)
PW_JSON=$(python3 -c 'import json,os;print(json.dumps(os.environ["VERIFY_SMOKE_PASSWORD"]))')
printf '%s' "${LOGIN_JS/__PW__/$PW_JSON}" | ab_eval >/dev/null
ab wait --load networkidle >/dev/null 2>&1
ab wait 2000 >/dev/null 2>&1

# --- Flow 2: dashboard landing ----------------------------------------------
loc=$(printf '%s' 'window.location.pathname' | ab_eval)
err=$(printf '%s' 'document.querySelector("[role=alert]")?.textContent || ""' | ab_eval)
nav=$(printf '%s' 'document.querySelector("nav") ? "yes" : "no"' | ab_eval)
boundary=$(printf '%s' 'document.body.innerText.includes("Application error") ? "yes" : "no"' | ab_eval)
ab screenshot "$EVIDENCE/2-dashboard.png" >/dev/null 2>&1
if [ "$loc" = "/dashboard/today" ] && [ "$nav" = "yes" ] && [ "$boundary" = "no" ]; then
  record "dashboard-landing" PASS "redirected to /dashboard/today, tab nav present, no error boundary (privacy mode on) — 2-dashboard.png"
else
  hint=""
  case "$err" in *unavailable*) hint=" (server likely missing APP_PASSWORD_HASH — dev servers need it exported)";; esac
  record "dashboard-landing" FAIL "loc='$loc' nav=$nav errorBoundary=$boundary alert='$err'$hint"
fi

# --- Flow 3: import preview (NEVER commits) ----------------------------------
DB_PATH="${DATABASE_PATH:-$PROJECT_DIR/data/vanguard.db}"
# Fail CLOSED: the count must be numeric; a failed query must not compare
# "n/a" == "n/a" into a pass.
batches_count() {
  local n
  n=$(sqlite3 "file:$DB_PATH?mode=ro" "SELECT COUNT(*) FROM import_batches;" 2>/dev/null)
  case "$n" in ''|*[!0-9]*) echo "query-failed";; *) echo "$n";; esac
}
batches_before=$(batches_count)
ab open "$BASE_URL/dashboard/import" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
FIXTURE_JSON=$(python3 -c 'import json;print(json.dumps(open("tests/fixtures/vanguard-holdings-sample.csv").read()))')
read -r -d '' DROP_JS <<'EOF' || true
(() => {
  const zone = document.querySelector('[aria-label="File upload drop zone"]');
  if (!zone) return "no-zone";
  const dt = new DataTransfer();
  dt.items.add(new File([__CSV__], "vanguard-holdings-sample.csv", { type: "text/csv" }));
  zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  return "dropped";
})()
EOF
printf '%s' "${DROP_JS/__CSV__/$FIXTURE_JSON}" | ab_eval >/dev/null
ab wait --load networkidle >/dev/null 2>&1
ab wait 3000 >/dev/null 2>&1
preview=$(printf '%s' '[...document.querySelectorAll("h3")].some(h => h.textContent === "Import Preview") ? "yes" : "no"' | ab_eval)
btn=$(printf '%s' '[...document.querySelectorAll("button")].map(b => b.textContent.trim()).find(t => t.startsWith("Import ")) || ""' | ab_eval)
# Assert the six preview count cells against the fixture's known contents
# (label/value pairs from the preview grid; fixture = 4 holdings rows).
read -r -d '' COUNTS_JS <<'EOF' || true
(() => {
  const want = { Transactions: 0, Securities: 4, Holdings: 4, Prices: 4, Snapshots: 0 };
  const cells = [...document.querySelectorAll("div")].filter((d) => d.children.length === 0);
  const bad = [];
  for (const [label, n] of Object.entries(want)) {
    const labelEl = cells.find((c) => c.textContent.trim() === label);
    const valueEl = labelEl && labelEl.previousElementSibling;
    const got = valueEl ? valueEl.textContent.trim() : "missing";
    if (got !== String(n)) bad.push(label + "=" + got + " want " + n);
  }
  return bad.length === 0 ? "counts-ok" : bad.join("; ");
})()
EOF
counts=$(printf '%s' "$COUNTS_JS" | ab_eval)
ab screenshot "$EVIDENCE/3-import-preview.png" >/dev/null 2>&1
# leave preview WITHOUT committing
printf '%s' '[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Cancel")?.click(); "cancelled"' | ab_eval >/dev/null
batches_after=$(batches_count)
if [ "$preview" = "yes" ] && [ "$btn" = "Import 1 file" ] && [ "$counts" = "counts-ok" ] \
   && [ "$batches_before" != "query-failed" ] && [ "$batches_before" = "$batches_after" ]; then
  record "import-preview" PASS "preview counts match fixture (Sec/Hold/Prices=4, Txn/Snap=0), 'Import 1 file' present (not clicked), import_batches unchanged ($batches_before) — 3-import-preview.png"
else
  record "import-preview" FAIL "preview=$preview btn='$btn' counts='$counts' batches $batches_before->$batches_after"
fi

# --- Flow 4: Cmd+K no-match empty state --------------------------------------
ab open "$BASE_URL/dashboard/today" >/dev/null 2>&1
ab wait --load networkidle >/dev/null 2>&1
printf '%s' 'document.querySelector("button[aria-label=\"Open search\"]")?.click(); "opened"' | ab_eval >/dev/null
ab wait 500 >/dev/null 2>&1
read -r -d '' CMDK_JS <<'EOF' || true
(() => {
  const input = document.querySelector('input[placeholder^="Jump to ticker"]');
  if (!input) return "no-input";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "ZZZXQ99");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return "typed";
})()
EOF
printf '%s' "$CMDK_JS" | ab_eval >/dev/null
ab wait 1500 >/dev/null 2>&1
nomatch=$(printf '%s' 'document.body.innerText.includes("No ticker matches") ? "yes" : "no"' | ab_eval)
ab screenshot "$EVIDENCE/4-cmdk-empty.png" >/dev/null 2>&1
if [ "$nomatch" = "yes" ]; then
  record "cmdk-empty-state" PASS "deterministic no-match state rendered — 4-cmdk-empty.png"
else
  record "cmdk-empty-state" FAIL "no-match text not found"
fi

# --- Wrap up -----------------------------------------------------------------
ab close >/dev/null 2>&1 || true
printf '%s\n' "" "## Result" "" "- Passed: $PASS / 4" "- Evidence: $EVIDENCE" >> "$SUMMARY"
echo ""
echo "verify:smoke — $PASS/4 passed. Evidence: $EVIDENCE"
[ "$FAIL" -eq 0 ] || exit 1
```

- [ ] **Step 2: Syntax-gate the script**

Run: `bash -n scripts/verify-smoke.sh`
Expected: no output, exit 0. (The JS heredocs use the quoted `<<'EOF'` form assigned via `read -r -d ''` — NOT `$(cat <<EOF)` command substitution — so apostrophes inside them are safe on bash 3.2. Never convert them to the `$(cat …)` form.)

- [ ] **Step 3: Add gitignore entry + npm script**

Append to `qa/.gitignore`:

```
verify-evidence/
```

In `package.json` "scripts", after `"verify:changed"`, add:

```json
"verify:smoke": "bash scripts/verify-smoke.sh",
```

- [ ] **Step 4: Run the smoke end-to-end**

Precondition: a healthy server. Ask the user for `VERIFY_SMOKE_PASSWORD` if not already exported — NEVER guess it, never read the keychain.

Run: `VERIFY_SMOKE_PASSWORD=<from user> npm run verify:smoke`
Expected: `verify:smoke — 4/4 passed`, evidence dir contains 4 screenshots + `summary.md`, `git status` shows NO new tracked files (evidence is ignored). Verify screenshots 2-4 show masked (`•••`) values — privacy mode active. If flow 2 fails with the APP_PASSWORD_HASH hint against :3000, that is the documented dev-server limitation: re-run against the packaged app or export the hash into the dev server env first.

- [ ] **Step 5: Commit**

```bash
printf '%s\n' "feat(verify): verify:smoke browser smoke with evidence capture (#52)" > /tmp/vgs-commit.txt
git add scripts/verify-smoke.sh qa/.gitignore package.json
git commit -F /tmp/vgs-commit.txt
```

---

### Task 5: Operating doc + CLAUDE.md pointer

**Files:**
- Create: `docs/reference/verification-loop.md`
- Modify: `CLAUDE.md` (Workflow Rules section — two lines)

**Interfaces:**
- Consumes: the commands shipped in Tasks 3-4 (`npm run verify:changed [-- --dry-run]`, `npm run verify:smoke`).
- Produces: the doc future agents follow; the evidence template.

- [ ] **Step 1: Write `docs/reference/verification-loop.md`**

```markdown
# Verification Loop (#52)

The normal path for any feature or bug fix:

1. **Write observable acceptance criteria** — what will be true when done, phrased so a check can fail.
2. **Reproduce at the decision point** — find the actual line/query/value that is wrong before changing anything.
3. **Smallest coherent vertical change** — one behavior, all its layers, nothing else.
4. **Focused tests** — `npm run verify:changed` selects and runs the smallest relevant Vitest targets from your working diff. `-- --dry-run` prints the plan without running. Zero mapped targets → it tells you manual selection is required; it never falls back to a broad run.
5. **Real user path + data** — for UI-visible changes run `npm run verify:smoke` (needs `VERIFY_SMOKE_PASSWORD` exported; detects dev :3000 then app :3099; never starts a server). Restart the dev server first after ANY server-side change. For data work, verify the actual numbers against fixtures/queries — never assert confidence.
6. **Full suite** — `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run` (report the count). `npx next build` catches what tests don't.
7. **Hand off evidence** — fill the template below.

Two-attempt rule: if a fix fails verification twice, stop and reassess (see ~/.claude/CLAUDE.md).

## Verification evidence template

    ## Verification evidence
    - Contract / acceptance criteria:
    - Root cause or implementation boundary:
    - Focused tests: command + result
    - Data invariant verified: (REQUIRED for financial/holdings/valuation/tax-lot/import/sync work — actual fixture/query/calculation evidence, not an assertion of confidence)
    - Browser evidence: flow + screenshot/artifact + result, if applicable
    - Full regression: exact command + pass/fail + test count
    - Known limitations / not verified:

## Implementation

- Mapping table + planner: `scripts/lib/verify-mapping.ts` (data-driven; tests in `tests/verify/`)
- Changed-file collection: `scripts/lib/git-changed.ts` (`git status --porcelain=v1 -z`, read-only)
- CLI: `scripts/verify-changed.ts`
- Smoke: `scripts/verify-smoke.sh` (agent-browser; evidence in `qa/verify-evidence/`, gitignored; privacy mode forced on for authenticated screenshots)
- Spec with full rationale: `docs/superpowers/specs/2026-08-16-verification-loop-design.md`
```

- [ ] **Step 2: Add the CLAUDE.md pointer**

In `CLAUDE.md`, in the **Workflow Rules** section, after the existing full-suite paragraph, add:

```markdown
Before the full suite, run `npm run verify:changed` to execute the smallest relevant checks for your diff, and `npm run verify:smoke` for UI-visible changes. The loop + evidence template: `docs/reference/verification-loop.md`.
```

- [ ] **Step 3: Commit**

```bash
printf '%s\n' "docs(verify): verification-loop operating doc + CLAUDE.md pointer (#52)" > /tmp/vgs-commit.txt
git add docs/reference/verification-loop.md CLAUDE.md
git commit -F /tmp/vgs-commit.txt
```

---

### Task 6: Acceptance pass

**Files:** none created — verification only.

- [ ] **Step 1: Full new-module test run**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/verify/`
Expected: PASS, ~20 tests.

- [ ] **Step 2: Dry-run determinism check on the real diff**

Run `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify:changed -- --dry-run` twice; diff the outputs.
Expected: byte-identical; categories/reminders/unmatched all plausible for the actual working diff.

- [ ] **Step 3: Confirm the smoke ran with evidence (Task 4 Step 4)**

Confirm `qa/verify-evidence/<stamp>/summary.md` reports 4/4 and the four screenshots exist with masked values. If Task 4's live run was blocked (no server / no password), report that explicitly to the user as NOT VERIFIED — do not claim it.

- [ ] **Step 4: Full pinned suite + build**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run`
Expected: 0 failures; report the exact count (baseline was 5,365 passed + 9 todo).
Then, if a stale `dist/` exists (stale-dist build gotcha), remove it with the ABSOLUTE path only: `rm -rf /Users/Yitzi/code/vanguard-skin/dist` (never a relative `rm -rf` — repo safety rule). Then `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx next build` — expect clean.

- [ ] **Step 5: Close-out**

Fill the new evidence template for this work itself (dogfooding) and present it to the user. Do NOT close issue #52 or push without the user's say-so.

---

## Codex plan-review round (2026-08-16)

REVISE with 9 findings. Folded in: preview count-cell assertions (1), dashboard nav/error-boundary assertions (2, partial — network-error capture stays best-effort per the spec), fail-closed numeric DB counts (3), `localhost` instead of `127.0.0.1` for Secure-cookie reliability (4), absolute-path `dist/` removal (5), bounded session-row exception documented (6), heredoc note corrected + all JS blocks moved to `read -r -d ''` quoted heredocs (9).

Rejected with rationale:
- Finding 7 (don't reap pre-existing orphan browser processes): `ab_reap_orphans` killing PPID-1 agent-browser/playwright leftovers is the pre-authorized stale-process cleanup policy (global CLAUDE.md, 2026-07-17) and the established nightly-QA convention — keeping it.
- Finding 8 (full suite before every task commit): tasks are additive new files; per-task commits stay LOCAL and nothing is pushed, reported done, or deployed until Task 6's full pinned suite is green — the established session pattern. The CLI integration-test seam is unnecessary: all logic lives in the two unit-tested pure modules.
```
