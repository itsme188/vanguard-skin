# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-31 — one thread: the **reconciler hardening** shipped end-to-end (the HIGH TODO item filed 2026-08-30 from the holdings-latest sweep review, Codex F2+F7).

## 1. Goal + exact files changed

**Merge `e3542fb`** (14 branch commits, 33 files, +3,584/−174), branch `reconciler-hardening`, spec `docs/superpowers/specs/2026-08-30-reconciler-hardening-design.md` (rev 4, 3× Codex design rounds), plan `docs/superpowers/plans/2026-08-31-reconciler-hardening.md` (rev 2, 1× Codex plan round).

- `lib/db/holding-sources.ts` — `RECON_HOLDING_SOURCE_PREFIX` + `:stmt`/`:live` origin suffixes; `statementOverwritableHoldingSql` (live prefixes + ANY recon row) and `liveOverwritableHoldingSql` (live prefixes + `:live` recon only) — supersession is directional, statement-wins preserved.
- `lib/mutations/closed-equity.ts` — tombstones origin-suffixed per pass, batch-owned only for the importing batch's own accounts, whole run in one transaction with a tax-generation bump when it marks; new `removeOrphanedReconTombstones` (origin-aware validity: `:stmt`/legacy need a surviving same-date STATEMENT row, `:live` any non-recon row; deletion only, never a rebuild — rebuilds would move historical close dates), `zeroLatestSecurityIds`, `countReconRowsOnDate`.
- `lib/import/engine.ts` — holdings upsert WHERE now the shared statement helper (a corrected same-date re-import supersedes any tombstone); `CommitResult.corporateActionWarningCount`; bump on `newHoldings > 0`; sweep failures push stable domain warnings + append a best-effort `import_batches.summary` marker (raw errors log-only); reconcile ownership from `parsed.holdings` account names (deduped retries still own their tombstones); `undoImport` captures affected accounts pre-delete and runs delete + orphan-cleanup + re-reconcile in ONE transaction (rebuild failure refuses the whole undo), recomputes stay best-effort after.
- `lib/mutations/import-batches.ts` — `deleteImportBatch` owns holdings-deletion bump AND price-pair capture/bump in its own transaction (direct script callers covered).
- `lib/compute/tax-convention.ts` — `bumpIfPricesAffectSyntheticCloses(db, pairs)`: bumps only for prices at-or-before a tombstoned security's zero date; held-security daily price syncs never bump.
- `lib/plaid/refresh.ts`, `lib/tws/positions.ts`, `lib/tws/snapshot.ts`, `lib/tws/historical.ts`, `lib/tws/streaming.ts`, `lib/ibkr/refresh.ts` — every runtime prices/holdings writer detects same-date AND newer-date tombstone supersession plus ghost-row-deletion reverts, and bumps inside one write transaction per writer (pre-state reads included; snapshot.ts price writes became a deferred single-transaction batch).
- `lib/import/recovery.ts` — restore guard now the shared helper (parity by construction), recon manifest rows skipped at INSERT time (checksum verified first, payload untouched), post-restore orphan-cleanup + re-reconcile, bump when the manifest carries holdings/prices.
- `app/api/import/route.ts` — replay evidence from CA counts, never `warnings.length` (sweep warnings can't fake corporate-action status).
- `app/dashboard/components/ImportHistory.tsx` — batch summary sub-line renders (failure markers visible).
- Tests: 6 new files + 8 extended (`tests/integration/reconciler-hardening.test.ts` is the cross-cutting lifecycle suite); docs: CLAUDE.md invariant bullet, DECISIONS.md entry, TODO close-out + deferred-minors ledger + PR #59 review item.

## 2. Tests / E2E / deploy result

- Full suite on merged main: **7,141 passed / 0 failures** (one pre-merge run showed a single non-recurring failure — the known eslint-subprocess-under-load flake; two consecutive clean full runs followed). `npx next build` compiles.
- Browser E2E 2/2 on a secretless `env -i` sandbox (:3095, DB copy, minted session): corrected same-date re-import restores a phantom-closed position (tombstone superseded in place); bad-import undo removes the batch AND its owned tombstone; ImportHistory summary sub-lines render. E2E method note: same-day fixtures against a Plaid-synced account don't isolate (the daily sync reconciles them away) — used a fresh synthetic account + earlier base date.
- Deploy: `npm run electron:deploy` green — notarization successful, `verify-bundle: OK`, installed + relaunched, `/login` 200 on :3099.

## 3. Open concerns / rejected approaches / decisions

- **Review posture:** spec 3 rounds (10+8+7 findings), plan 1 round (9 findings — incl. three price writers the plan had missed and a T4/T7 test-file collision), per-task SDD reviews with 5 fix rounds, final whole-branch review: READY TO MERGE, 0 Critical / 0 Important.
- **Notable rulings:** (a) plan-prescribed `recordSweepFailure` code was defective (unguarded marker UPDATE could fail the whole import in exactly the DB-error class it handles) — spec's "import still reports success" won, marker is best-effort; (b) controller self-reversal: price pairs are `res.changes`-gated after review showed unconditional collection lets a fully-deduped re-import clear filing-ready acceptance; (c) ghost-row cleanup deleting a row that had superseded a tombstone now bumps in Plaid AND TWS (spec gap found by T6's review, closed immediately in both writers).
- **Rejected:** wholesale tombstone rebuilds (would re-land tombstones on current reference dates, silently moving historical close dates in valuations and RECONCILE_CLOSE realization); per-sync blanket bumps (would permanently invalidate filing-readiness); a synthetic-close dependency-signature subsystem (coarse fail-closed doctrine instead — over-bump costs one acceptance re-run, under-bump risks a wrong filing); restore `.changes`-idempotence claims (false precision).
- **Deferred (all triaged, ledgered in TODO):** ~17 minors incl. plaid's unconditional price-pair collection asymmetry (comment-or-gate), stock/ETF type-filter doc note on the helpers, repair-script price-bump runbook line, double-restore bump-delta assertion.
- **Live watch:** the September statement import is the first real exercise of statement-over-tombstone supersession AND the existing reconciler-watch item; both are in TODO.

## 4. Uncommitted changes / live-process state (post-deploy)

- None uncommitted. Main pushed through this handoff commit; `reconciler-hardening` branch + worktree removed post-merge. Remaining worktree: `../vanguard-skin-qa-fix` (nightly fixer's own, untouched — note its checkout is on an older base).
- Packaged app live on :3099 from the fresh DMG. No dev servers running.
- **PR #59 "QA auto-fixes 2026-08-31" (branch `qa-auto-fixes-2026-08-31") is OPEN and UNREVIEWED** — the nightly fixer's first run on the 8 decided QA items; review + land next session (TODO item filed).

## 5. Claude session link

https://claude.ai/code/session_01PHmWbwTYzHhgYJnvndpiu6
