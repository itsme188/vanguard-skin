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
