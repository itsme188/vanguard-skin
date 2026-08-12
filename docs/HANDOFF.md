# Session Handoff — for Codex review

> Rolling file, overwritten at each `/session-end`. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-12 (session started 2026-08-11 evening)

## 1. Goal + files changed

One workstream: issue #37 (IBKR Corporate Actions ingestion), taken through the full arc — brainstorm → spec → implementation plan → subagent-driven build → merge → live repair — in a single session, under the new review-intake flow (see §3).

**Process artifacts:** `docs/superpowers/specs/2026-08-11-ibkr-corporate-actions-design.md`, `docs/superpowers/plans/2026-08-11-ibkr-corporate-actions.md`, `.claude/commands/codex-review-plan.md` (new slash command: independent read-only Codex design review via `codex exec --sandbox read-only`).

**Feature commits (`ea29e85..78f817a`):**
- `lib/db/migrations/078_corporate_actions_import.sql` — additive columns: `source_key` (unique partial index), `import_batch_id`, `account_id`, `quantity_delta`, `reconcile_delta`.
- `lib/import/types.ts` + `lib/import/parsers/ibkr-activity.ts` — `ParsedCorporateAction` (required field on `ParsedImportResult`, every producer swept); Corporate Actions section parsing (header-name columns, ratio from description, effective date from Date/Time not Report Date, real-calendar-date validation, delta as evidence only, named warnings for every unsupported shape).
- `lib/compute/corporate-actions.ts` + `app/api/corporate-actions/route.ts` — shared `validateCorporateActionInput`, `ImportedActionError`; manual road guards (403 undo of import rows, type-agnostic 409 collision pre-check).
- `lib/compute/tax-lots.ts` — replay integration: `source='import'` events applied chronologically in the sells loop (end-of-day rule: strict `<`, split-date sells first), lots adjusted qty ×ratio / per-share ÷ratio with cost_basis + acquisition_date untouched, account-scoped sign-aware delta cross-check persisted to `reconcile_delta`, `replayWarnings` on the result, RECONCILE_CLOSE pass skips orphans whose zero-date predates an applied split (fabricated-gain guard).
- `lib/import/engine.ts` + `lib/import/validate.ts` + `lib/mutations/import-batches.ts` — commit block (resolve-only security lookup, collision warnings never swallowed by INSERT OR IGNORE, batch tagging, accounting), `"corporateAction"` validation category, batch-undo deletion, holdings-snapshot sweep gate (`parsed.holdings.length > 0` now required before purges/closed-equity reconcile).
- `app/api/import/route.ts` + `app/dashboard/components/ImportFlow.tsx` + `CorporateActionsSection.tsx` — replay status (`clean|mismatch|failed`, null when no CAs) on commit responses, preview block from `validatedResult`, CA-only importability, imported chip (never "Pending"), reconcile delta rendered through `<Shares>`.
- `app/dashboard/components/ImportHistory.tsx` — standalone fix (`78f817a`): `useState` hoisted above the empty-state early return (Rules-of-Hooks violation, pre-existing since `eaf8bfe` 2026-04-12; crashed the Import page on a fresh DB's first import).
- Tests: `tests/fixtures/ibkr-corporate-actions.csv` (fake tickers, 4 valid + 5 decoy rows), `tests/import/corporate-actions-migration.test.ts` (true upgrade-path test), `ibkr-corporate-actions-parser.test.ts`, `engine-corporate-actions.test.ts`, `corporate-actions-integration.test.ts`, `tests/compute/tax-lots-splits.test.ts` (13), `corporate-actions-guards.test.ts`, `tests/api/import-corporate-actions-route.test.ts`, `corporate-actions-route.test.ts`.

**Docs reconcile:** `CLAUDE.md` (replay-vs-rewrite invariant bullet), `docs/plans/TODO.md` (#37 closed with evidence; hardening follow-ups filed; #34/#35/#37 issue anchors added at session start).

## 2. Tests / E2E / deploy

- Full suite **4,723 passed / 438 files** (baseline 4,677; +46 net new). Run three ways: worktree branch tip, merged main, and per-task focused runs with red→green TDD evidence for every task.
- **Browser E2E** against a worktree dev server running the branch: preview shows the corporate-actions block + all named warnings, Import button enabled for CA-bearing files, commit works, security-detail shows the imported chip with no Undo, privacy masking round-trips on the reconcile delta, re-import is a 0-new/all-dupes no-op. The E2E also *found* the ImportHistory hooks crash (fresh-DB-only path).
- **Live repair (separately authorized in-session):** backup `data/backups/pre-corp-actions-import-2026-08-12.db`; July statement re-imported through the normal import road on a restarted dev server running merged main. Result: exactly one new corporate-action row, replay status **clean** (`reconcile_delta` NULL — ledger-implied delta matched the statement exactly), post-split sells now consume the split-adjusted lots (the prior future-lot pairing at the oversell point is gone), open position matches the broker's post-split book, zero synthetic closes, second re-import a proven no-op. Issue #37 closed with sanitized evidence.
- **Deploy:** `electron:deploy` exit 0, notarization successful, installed + relaunched, `:3099` health 200. (First deploy attempt was hook-blocked pending a TODO.md reconcile — satisfied, not bypassed.)

## 3. Open concerns, rejected approaches, user decisions

- **New standing workflow rule (user, this session):** every plan/spec gets an independent Codex review via `/codex-review-plan` — iterate until settled — BEFORE the user reviews. This session ran 4 such rounds (2 on the spec, 2 on the plan); real catches included business-key collisions silently swallowing imported actions, the non-blocking post-commit recompute stranding replay warnings, an account-scoping error in the delta cross-check, and a CA-only import triggering the closed-equity reconciler against an empty snapshot. Recorded in project memory; progress comment left on issue #34.
- **Semantics decision (user):** splits are replay-native events — history is never rewritten (approach B, driving the legacy `addCorporateAction` rewrite machinery from import, was rejected for re-import idempotence breakage; approach C, zero-cost share injection, rejected for basis corruption). The manual Apply/Undo road is untouched this round; its multi-minute-freeze QA finding stays a separate item.
- **Sanitization decision (user):** committed docs may name tickers (public market facts; consistent with existing repo practice) but never quantities/basis; the issue-close comment itself is fully sanitized per #37's stricter rule.
- **Known limitations, disclosed:** duplicate-owner batch undo semantics are inherited platform behavior (documented, test-pinned, not special-cased); preview CA counts are shape-validated only (no DB handle) so an unknown-symbol row previews but resolve-skips at commit with a warning; reverse-split cash-in-lieu is out of scope with the persisted delta as tripwire.
- **Hardening follow-ups filed in TODO** (from the final whole-branch review): equal-date orphan guard should widen `>` to `>=` (plan defect, narrow); `splitEvents` query should filter `action_type IN ('SPLIT','REVERSE_SPLIT')`; mixed long+short single-security book lacks a cross-check covering test.
- **Not addressed this session:** issues #34 (progress comment only) and #35 (untouched).

## 4. Uncommitted changes / live-process state (post-deploy)

- Working tree clean; all commits pushed through the final handoff commit. Feature worktree `../vanguard-skin-ca` removed after merge; the nightly fixer's `../vanguard-skin-qa-fix` worktree stands (deliberate).
- **PR #46 (`qa-auto-fixes-2026-08-12`) is OPEN** — the nightly QA fixer ran overnight (first natural pass of the node@24 sandbox fix — it worked) and needs triage next session.
- Live: packaged app (with corporate-actions code) on `:3099`, healthy; dev server on `:3000` running merged main (restarted this session — it had pre-merge code); Worker unchanged (no parity work needed — import path is Mac-only by architecture, rationale in the spec).
- Watch items: NBIS earnings preview ~05:00–05:30 ET Wed 8/12 (sweep now runs on node@24-pinned code); PR #46 triage.

## 5. Claude session link

https://claude.ai/code/session_013RhpNgKkYnkirVxKq7C3Hw
