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
