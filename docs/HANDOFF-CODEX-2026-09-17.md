# QA stabilization and acceptance review — 2026-09-17

**State:** code committed at `0052ec8d`, with PR #83 merged into the reviewed candidate at `a68c7751`; PR #84 is already an ancestor. Integration/push and desktop/Worker deployment authorized by the user on 2026-09-17 and in progress. Original QA worktrees preserved. Historical production-data repairs are separate.
**Waiting on:** CODEX: complete integration, push and deployment verification. No further shipping permission needed.
**Next action:** fast-forward clean main under the integration lock, push, use the coordinated desktop deploy wrapper, deploy the matching Worker and verify both. Optional private-data AI validation was not run and does not block deployment.

## Review disposition

- **PR #83:** four financial-display/tax-report fixes reviewed. Correction required and implemented locally: `buildSuggestionContext` now carries threshold provenance; the AI prompt must not call today's MA the fire-time threshold of an old alert. New regression checks cover recorded, current and creation fallback values. Existing saved AI sentences still age out; Worker-fired alerts still lack recorded thresholds and must be labeled as fallbacks. Recent Sales conversion uses the stored current FX rate, not broker historical realized FX; the separate broker-USD capture backlog remains.
- **PR #84:** freshness labels, inline inbox error and cold-generation retry reviewed. A failing regression test demonstrated that the new render helper prioritized old text over a new scope's GET error; local correction restores error precedence. Cold-generation error/retry checked with controlled browser responses. The PR's generic suite-passed statement conflicts with the original sweep report and should be corrected when authorized to update the PR.
- **Local `qa-fix-work-20260917`:** option expiry year, discrepancy count/list disclosure, and digest article-cap disclosure reviewed. Original `3dc79527` was held because Worker input was unbounded, overflow removed held sections, and length-limit diagnostics guessed the cause. **Continuation resolved those code blockers:** parity-pinned budget modules on Mac/Worker, full-input held-section enforcement, deterministic delivered coverage note, subject fallback bounding, strict macro budget handling, Worker anomaly/watchlist priorities and matching 16,384 output cap. One live-model call with synthetic-only content finished normally; no real-data AI call or email was sent.

## Verification and repairs

- Reproduced 22 calendar-date failures in five files. Pin only `todayET` for the fixed calendar fixtures; real timers remain active for drain timeouts and cross-process waits. The first repaired focused run passed 207/207.
- Reproduced 20 type errors in four test files. Typed fetch/service mocks, kept differently shaped query results in separate bindings, and used `undefined` for optional security names. Typecheck passes. The optional-name fixture needed a second correction; no production type casts were introduced.
- All 72 coordination tests pass with local-server/process permissions. No coordination implementation change was needed.
- Combined changed-file run: 6,524 passed, 9 TODOs. Runner requested manual coverage for migrations/types/repair script; migration and repair suites are included in the full run, and real-copy rehearsal covers the additive migrations.
- First full combined run: 9,999 passed, 3 skipped, 9 TODOs, 836 files. After the narrative correction, a second full run had 9,999 passed and one pre-existing 30-second ESLint subprocess timeout in `tests/auth/boundary-matrix.test.ts`. The final run limits contention with `VITEST_MAX_WORKERS=4`; its result is recorded in the task register/private evidence. No assertion or timeout was relaxed. This environment variable is not captured by the runner fingerprint and must be preserved when reproducing the evidence.
- Migration rehearsal on a VACUUM copy: digest of every pre-existing column in every table unchanged (except migration tracking); foreign-key check empty, integrity check OK, existing alert thresholds NULL and account treatments default taxable. No live data changed.
- Standard isolated browser smoke: 4/4. Targeted browser/API checks cover inline inbox failure, narrative failure/retry, retirement no-export UI and API 409, all-account report exclusion, alert fallback caption, Performance scope-owned start date, and Data Health list disclosure. Screenshots and exact results are private evidence.
- Test additions scanned for long/comma-grouped financial figures: no private figure found; the sole eight-digit match is a synthetic compact option date.

## Ownership and remaining work

Recompute diagnosis task was reconciled with the September 15 evening handoff: direction backfill and v2 recompute already ran. Do not run them again from its old next-action text. Broker acceptance, option-level review and opening-lots decisions remain under `user-run-data-steps-2026-09-14`.

No task record proves today's local fixer is still active; its clean worktree and all four commits were preserved. Do not merge duplicate `qa-fix-work-20260916` commits as well as PR #83. Older Codex coordination work is already integrated; do not replay it.

Retirement stamping was rehearsed on the sandbox copy only. Production stamping needs its own authorization, backup and verified account selection after schema deployment. The high-confidence badge hiding a skipped drift scan remains a separate next task.

## Retrospective

Goal: stabilize verification and review pending QA work. Accomplished: test/type repairs, independent patch review, two review corrections, copy migration rehearsal and browser acceptance. Calendar repairs and alert/narrative corrections passed their first fix attempts; optional-name typing took two. Restricted process access and browser-daemon lifecycle caused harness delays. Next time: supervise the sandbox from startup, distinguish browser mock failure from app failure, and publish precise test evidence with every QA PR.


## Digest continuation verification

- Focused: 83/83 tests, including final Worker email content, all held sections despite overflow, summary-only limits, subject fallback, strict macro budget, issuer-family ranking, and mirrored implementation parity.
- Full candidate: 10,005 passed, 3 skipped, 9 TODO, 837 files with `VITEST_MAX_WORKERS=4`. Root typecheck and Worker `tsc --noEmit -p workers/cron/tsconfig.json` pass. Existing Worker dependencies were APFS-cloned from main; no dependency installation.
- Live synthetic-only stress test: 200 invented companies, five fabricated articles each; bounded to 15 buckets / 59,846 prompt characters. Provider finished `stop`, 14,166 input / 2,544 output tokens. All 40 designated held-company sections retained via synthesis plus source-excerpt backstop; coverage disclosure present. Synthetic fixture has 185 overflow names, deliberately exercising the disclosure and demonstrating that very large days can still produce a long email.
- Browser: isolated :3095 Research → Feeds → Preview, with the saved live synthetic response injected only at the preview boundary. Verified the generated HTML in the actual modal and inspected the closing notice. First route interception did not apply; corrected the harness to proxy fetch. No app defect was inferred from the harness miss. Screenshots/logs: `docs/private/qa-review-2026-09-17/`.
- Automatic approval review rejected the proposed copied real-data model call (private research/held-symbol egress lacked explicit approval). It never executed. User was offered synthetic-only or explicit one-call approval. Do not retry private-data egress without that answer.
- Production logic passed the new coverage regressions on its first implementation. Test harness needed one old-format expectation update and one correction from a nonexistent `sent` result tag to `success`. Cached tsx runner was used after discovering it is not a project dependency. No production bug exceeded two failed fix attempts.
- Next-session improvement: use the existing cached runner and fetch interception from the outset; keep a synthetic no-send heavy-day fixture for reproducible AI acceptance. CLAUDE.md was not changed; this handoff contains the decisions and lessons.


## Shipping authorization and integration

User explicitly authorized committing and deploying. PR #83 merge conflicted only in the alert-provenance correction and its regression test; retained the already-reviewed versions. The merge index was byte-identical to the verified code commit before committing the merge. No dependency manifests changed. Original QA worktree remains intact; no historical data repairs are included.
