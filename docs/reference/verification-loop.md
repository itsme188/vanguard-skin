# Verification Loop (#52)

The normal path for any feature or bug fix:

1. **Write observable acceptance criteria** — what will be true when done, phrased so a check can fail.
2. **Reproduce at the decision point** — find the actual line/query/value that is wrong before changing anything.
3. **Smallest coherent vertical change** — one behavior, all its layers, nothing else.
4. **Focused tests** — `npm run verify:changed` keeps working-diff mode. Use `bash scripts/verify.sh changed --base <integration-base>` for the whole task: committed changes since merge-base plus staged, unstaged and untracked files. `--dry-run` is a plan only. Unmapped changes return 3 (manual selection required); add explicit `--test <path>` selections after review. No relevant changes is a distinct result, not a test pass.
5. **Real user path + data** — use the task-scoped sandbox and serialized smoke from [coordination.md](coordination.md). Each worktree needs local installed dependencies: Turbopack rejects external node_modules symlinks. Keep server startup, browser checks and shutdown within a supervised process when the execution host cleans up background descendants. Restart after server-side edits; keep evidence private.
6. **Authoritative completion** — `bash scripts/verify.sh full --base <integration-base>` runs the full suite with pinned Node 24 and preserves its exit code and logs. Run `bash scripts/verify.sh typecheck` separately. Do not rerun the full suite on every edit or Stop. Use `npm run build` for authorized builds so the build cannot migrate the live database.
7. **Hand off evidence** — `bash scripts/verify.sh status [--base <integration-base>]` checks the latest full evidence. Records under the worktree Git directory's `verification/` bind HEAD, index/working diff, untracked contents and mode, resolved base/merge-base, Node version and before/after fingerprints. New commits or dirty changes invalidate earlier passes. Evidence does not hash environment variables, ignored files or node_modules; disclose relevant environment changes. Full means regression tests, not typecheck/browser/build acceptance. Record these separately.

The final machine-readable line is `verify: result=<result> run=<id> base=<sha>`. Exit 0 distinguishes `passed` from `no-relevant-changes`; exit 3 means manual selection required; status exit 4 means stale/missing evidence. Actual subprocess failures retain their exit codes; inspect the result and logs rather than interpreting numeric codes alone. For the currently environment-dependent mocked AI tests, the established isolated-suite command is `ANTHROPIC_API_KEY=verification-fixture-only bash scripts/verify.sh full --base <integration-base>`; this synthetic placeholder is not a service credential.

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
- Shared CLI: `scripts/verify.sh` → `scripts/verify-runner.ts`; compatibility adapter `scripts/verify-changed.ts`
- Smoke: `scripts/verify-smoke.sh` (agent-browser; evidence in `qa/verify-evidence/`, gitignored; privacy mode forced on for authenticated screenshots)
- Spec with full rationale: `docs/superpowers/specs/2026-08-16-verification-loop-design.md`
