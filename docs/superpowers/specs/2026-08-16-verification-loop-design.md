# Evidence-Driven Verification Loop — Design

**Date:** 2026-08-16
**Issue:** [#52](https://github.com/itsme188/vanguard-skin/issues/52) (Codex-filed; this spec resolves its open questions)
**Status:** Approved design, pre-implementation

## Goal

A repeatable, evidence-producing verification workflow for feature and bug-fix work:

```
acceptance criteria → focused test → implementation → browser/data verification → full regression → concise evidence handoff
```

Three deliverables: a changed-scope test selector (`verify:changed`), a browser smoke script (`verify:smoke`), and an operating doc with a handoff evidence template. No product-behavior changes, no schema changes, no new dependencies.

## Decisions resolved (2026-08-16 session)

| Open question from #52 | Decision |
|---|---|
| Browser runner | Checked-in script drives the existing `agent-browser` CLI (nightly-QA machinery). No Playwright dependency. |
| Smoke target server | Detect healthy server: dev `127.0.0.1:3000` first, packaged app `127.0.0.1:3099` fallback. Never start a server. |
| Typecheck in `verify:changed` | Recommend-only: print `npx tsc --noEmit` as an optional check. (Full tsc carries pre-existing test-file errors; auto-running it fails every run with unrelated noise.) |
| CI integration | None — the repo has no `.github/workflows/`. Revisit if CI is ever added. |

## Component 1 — `verify:changed`

### `scripts/lib/verify-mapping.ts` (pure planner)

The path→check mapping is **data**: an ordered table of entries

```ts
type MappingEntry = {
  category: string;            // e.g. "compute", "db", "import", "api", "ui", "worker", "tooling"
  match: string[];             // path-prefix/glob matchers, repo-relative
  testTargets: string[];       // vitest paths to run, e.g. ["tests/compute/"]
  reminders: string[];         // extra human-facing notes for this category
};
```

`planVerification(changedPaths: string[]): Plan` is a pure function (no fs, no git, no db) returning:

- `selectedTests: string[]` — deduped vitest targets;
- `categories: string[]` — matched category names;
- `reminders: string[]` — deduped reminder lines;
- `unmatched: string[]` — changed paths no entry matched;
- `directTests: string[]` — changed paths that are themselves test files (always selected verbatim, including untracked new test files like `tests/auth/login-page.test.ts`).

Minimum category table (from #52, adapted to this repo's `tests/<domain>/` mirror):

| Changed surface | Test targets | Reminders |
|---|---|---|
| `lib/compute/**`, `lib/format/**`, `lib/chart/**` | `tests/compute/`, `tests/chart/`, format tests | — |
| `lib/queries/**`, `lib/mutations/**`, `lib/db/**` | `tests/db/`, `tests/queries-*`/matching domain dirs | — |
| `lib/db/migrations/**` | (none auto) | **Migration touched — verify:changed never applies migrations.** Reminder text points at the existing convention: test via `lib/db/migrate.ts` against a DB *copy* first, back up `data/vanguard.db` before applying live. (A full migration-safety runbook is out of scope for #52.) |
| `lib/import/**`, `app/api/import/**` | `tests/import/` | — |
| `app/api/**` | `tests/api/`, `tests/apis/`, `tests/http/`, `tests/auth/` (route-policy tests when routes added) | New route → update `proxy.ts` route policy + `tests/auth/route-policy.test.ts` |
| `lib/queries/**` (also) | `tests/queries/`, `tests/mutations/` | — |
| `app/dashboard/**`, `components/**` | `tests/dashboard/` + matching component tests | **Browser verification required** — restart dev server first if any server component changed |
| `lib/tws/**` | `tests/ibkr/`, `tests/contracts/` | — |
| `lib/calendar/**`, `lib/email*`, `lib/digest/**`, `lib/earnings/**` | matching domain dirs | Mirror-parity check if the paired Worker file is in the pinned list |
| `workers/cron/**` | `tests/cron/`, `tests/workers/` | **Parity-pinned mirror — change both sides.** Reminder names the specific Mac↔Worker file pair (pairs stored in the mapping data, sourced from CLAUDE.md's pinned list). |
| `scripts/**`, `qa/**`, `docs/**`, config files | (none) | "Tooling/docs-only change — no focused tests mapped; run what the change itself documents." |

The table above is the minimum shape; at implementation time the exact `testTargets` are pinned by enumerating the real `tests/` tree (the mapping data file + its unit tests become the authority, not this table). A mapped target that doesn't exist on disk is a mapping bug the unit tests must catch.

Rules:

- Conservative selection: a path matching nothing lands in `unmatched` with a clear "manual test selection required" message — never a fallback to running large unrelated suites.
- Matching multiple entries selects the union.
- No-change case: exit 0, "working tree clean — nothing to verify."

### `scripts/verify-changed.ts` (CLI)

- npm script: `"verify:changed": "tsx scripts/verify-changed.ts"`.
- Collects changed files via `git status --porcelain=v1 -z` (staged + unstaged + untracked, repo-relative; no branch/remote/base assumption; `-z` avoids quoted-path ambiguity). Renames use the new path. Parsing is unit-tested against fixture strings covering rename records, paths with spaces, and untracked files.
- If the plan's `selectedTests` is empty (reminder-only or tooling-only diff), exit 0 **without invoking vitest at all** — never spawn `vitest run` with zero targets (which would run the full suite). Print the reminders and the manual-verification message instead.
- `--dry-run`: print the full plan — changed files, matched categories, selected commands, reminders, unmatched paths with reasons — and exit 0. Deterministic output (sorted lists) so it is diffable in reviews.
- Default mode: print the plan, then execute `npx vitest run <targets>` once with `PATH=/opt/homebrew/opt/node@24/bin:$PATH` prepended in the spawned environment. Exit code mirrors vitest's.
- Always prints the recommended optional checks (`npx tsc --noEmit`, `npx next build`) without running them.
- Hard guarantees: never writes files, never touches the DB, never applies migrations, never runs `npm install`/`npm rebuild`, no network.

## Component 2 — `verify:smoke`

`scripts/verify-smoke.sh` (bash; npm script `verify:smoke`), modeled on the smoke half of `qa/nightly-qa-cron.sh`:

- node@24 PATH pin; source `qa/lib/agent-browser-cleanup.sh` + `ab_cleanup_init` so no browser processes leak.
- Server detection: probe `http://127.0.0.1:3000` then `http://127.0.0.1:3099` (expect the login surface / a 200-class response through the #35 proxy). If neither is healthy: print the safe start instruction (`npm run dev` in a free terminal, or launch the packaged app) and exit non-zero. **Never starts a server** (Turbopack single-writer rule).
- Prints up front: "If you changed server-side code, restart the dev server before trusting this smoke."
- **Identity check before credentials** (Codex finding 4): after the port probe, the script confirms the responding page is *this app* (login page carries the app's known title/marker) before any credential entry. A 200 from an unknown process on the port is a hard fail, not a login attempt.
- **Login sequence** (defined here — the nightly QA scripts predate the #35 boundary and have no login flow to reuse): navigate to `/login` → agent-browser fills the app password read from the local env (exact var name taken from the #35 implementation at build time; passed via environment, never in argv or logged output) → submit → assert redirect to `/dashboard/today` with an authenticated session (the login form's own double-submit CSRF cookie flow handles CSRF). Cleanup: close the browser via the cleanup trap; the server-side session row persisting is acceptable (same as any manual login).
- **Privacy rule for evidence** (Codex finding 3): before any authenticated screenshot, the script enables the app's privacy mode (the existing header toggle / localStorage `vgs:privacy` mechanism — exact hook confirmed at implementation) so portfolio-derived numbers are masked in artifacts. The pass/fail summary text must never contain portfolio values, quantities, or account names. `verify-evidence/` is added to the existing `qa/.gitignore`.
- Flows, each with explicit assertions and a 30s per-flow timeout; a flow fails on assertion miss, timeout, or an uncaught page error (4xx/5xx network responses are noted in the summary; only 5xx on the app's own routes fail the flow):
  1. **Login surface**: `/login` renders the identity marker + password field (pre-auth screenshot).
  2. **Dashboard landing**: post-login `/dashboard/today` shows the app header and tab nav, and no Next.js error boundary / "Application error" text.
  3. **Import preview**: upload `tests/fixtures/vanguard-holdings-sample.csv` (anonymized, committed) on the Import tab, preview only — assert the preview reports the fixture's expected record count (a committed expectation for a committed fixture — no real financial figures involved) and the script **never clicks the commit/Import button**. Afterwards the script verifies no new `import_batches` row exists via a read-only sqlite query.
  4. **Stable empty state**: open the Cmd+K ticker-jump palette and type a nonsense query (`ZZZXQ99`) — assert the deterministic no-match empty state renders. Chosen because it is data-independent: it looks identical on any DB.
- No live-TWS, external-API, or credential dependencies beyond the local app password.

## Component 3 — Operating doc + evidence template

`docs/reference/verification-loop.md`, compact:

1. The seven-step loop: observable acceptance criteria → reproduce at the decision point → smallest coherent vertical change → focused tests (`verify:changed`) → real user path + data verification (`verify:smoke` / manual browser + queries) → full suite (pinned command) → evidence handoff.
2. The copyable template:

```md
## Verification evidence
- Contract / acceptance criteria:
- Root cause or implementation boundary:
- Focused tests: command + result
- Data invariant verified: (REQUIRED for financial/holdings/valuation/tax-lot/import/sync work — actual fixture/query/calculation evidence, not confidence)
- Browser evidence: flow + screenshot/artifact + result, if applicable
- Full regression: exact command + pass/fail + test count
- Known limitations / not verified:
```

3. Links: CLAUDE.md pinned test command + node@24 rule, dev-server restart rule, mandatory real-user browser verification, the 2-attempt stop rule.

CLAUDE.md change: two-line pointer in **Workflow Rules** referencing the doc and the two commands. Nothing else in CLAUDE.md changes.

## Testing

- `tests/verify/verify-mapping.test.ts` — pure-function tests on `planVerification` covering at minimum: compute path, query/mutation path, import/API path, UI path (browser reminder present), `workers/cron` path (mirror reminder names the pair), migrations path (manual-migration reminder, no auto-targets), unknown path → unmatched, empty input → clean message case, changed test file → direct selection (tracked and untracked forms).
- CLI-level check: `--dry-run` run against a synthetic `git status --porcelain` sample (porcelain parsing unit-tested with a fixture string; the git call itself is a thin seam).
- Tool acceptance: one real `--dry-run` on a non-destructive diff; one full `verify:smoke` run producing evidence; full pinned suite green with count reported.

## Non-goals (restated from #52)

No weakening of the full-suite-before-handoff bar; no new dependencies; no second dev server ever; no schema/styling/product changes; no hardcoded financial figures anywhere in smoke assertions (structure checks only — "renders without error", never "value equals X").

## Acceptance criteria

Inherited verbatim from #52's checklist, with the resolved decisions above substituted for its open questions.

## Codex review round (2026-08-16)

Independent Codex design review returned REVISE with 10 findings. Resolutions:

- **Accepted and folded in above:** import-preview count assertion + no-write check (1), evidence privacy rules + `qa/.gitignore` entry (3), app-identity check before credential entry + env-only password passing (4), explicit login sequence — verified the nightly QA scripts have no login flow to reuse (5), migration reminder text now points at the copy-first/backup convention (6, reminder-text scope only), `workers/cron/**` maps to `tests/workers/` too — directory verified to exist (7), empty-`selectedTests` exits without invoking vitest (8), `--porcelain=v1 -z` parsing with rename/space/untracked fixtures (9), pinned Cmd+K no-match empty state + per-flow assertions/timeouts (10).
- **Rejected as out of scope for #52, with rationale:**
  - Finding 2 (commit → re-import idempotence tests): re-import idempotence is a product invariant owned by the existing import suite — six files under `tests/import/` already exercise `source_key` dedupe and duplicate handling; #52 explicitly forbids product-behavior work, and the smoke never commits an import. If a coverage gap is found there, it gets its own issue.
  - Finding 6 (full migration-safety runbook with backup/rollback procedure): `verify:changed` is a read-only selector; a migration runbook is a separate documentation task. The reminder now points at the existing safe convention, which is the extent of this tool's responsibility.
