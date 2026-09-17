# Confidence and coverage cleanup — 2026-09-17

**Waiting on:** nobody.

**State:** Implemented in `e6cc4100`, integrated and pushed through `24085115`, and deployed. Installed build `Egac-HggTIL9J0XxHm4qh`; signed/notarized, bundle gate passed, installed build ID matched, signature verified, new standalone listener and login health check passed. Integration base `0e0fa344c5a365cc9dd5c43b1779b4632b1f18b0`. User authorized all three fixes and committing/deploying in this session.

## Changes

- Integrity results distinguish skipped position/lot comparison from a successful scan. High freshness with stale tax inputs shows amber Unchecked, an explanation, and a Tax Lots link. Lower/stale and critical cap behavior remains intact.
- Data Health shares Accounts' scaled nonzero basis fallback, retaining unknown, recovered historical, and negative basis semantics.
- Idempotency snapshots key engine-owned reconciliation sales by source identity, ignoring regenerated IDs while detecting actual amount changes.

## Verification

- Full suite: 837 files passed; 10,008 tests passed, 3 skipped, 9 TODO.
- Typecheck and 93 focused regression tests passed.
- Browser on isolated localhost:3095: stale marker warning and Tax Lots link verified; current-marker fixture removes Unchecked and preserves integrity cap. Marker restored on copy. Data Health rendered successfully. Privacy-mode screenshots retained in ignored `docs/private/confidence-cleanup-2026-09-17/`.
- Isolated smoke: 4/4 passed.
- Separate database-copy rehearsal with `--apply --verify-idempotent`: daily accounting identity passed and second run IDENTICAL. Production database unchanged; broker acceptance and historical-data repairs remain outside this task.

## Retrospective

Goal: remove three misleading confidence/coverage verification outcomes. All three corrected; implementation passed on its first production-code attempt. The synthetic-close regression fixture needed a security type before it exercised the intended path. Browser automation needed the actual link reference rather than a text selector; screenshots confirmed navigation and stale warning. Next time, include the minimum security metadata in synthetic reconciliation fixtures from the start. Notarization was the longest waiting step; deployment completed successfully.

**Next action:** none for these three fixes. Any remaining historical-data repair or acceptance stamping is a separate task. Final main-checkout suite evidence is recorded by `scripts/verify.sh` in `.git/verification/`; ignored evidence is preserved before removing the temporary worktree.
