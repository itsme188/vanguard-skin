# Session Handoff — for Codex review

**Waiting on:** USER: the September 2026 statements (IBKR activity + Vanguard Taxable + Roth; decision record `september-2026-statements`). Then CLAUDE: run `import-monthly-statements`, rehearse `recompute-tax-lots-v2.ts --apply --verify-idempotent` on a copy, and with the user's OK run `--apply --live` (the stored ledger reads stale under the new `v3r2` stamp until then). CLAUDE (next): review/rebase PR #96 (nightly fixer 2026-10-02; it overlaps this session's `commitImport` opt-in change and carries the stranded `0c157527`); the reconciler's carryEnrichment can still prefer a wrong-slot twin's reaction snapshot. CODEX: nothing.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session dates:** 2026-10-01 evening → 2026-10-02. Interactive session with the user.

## 1. Goal + exact files changed

**(a) Land the stranded nightly-QA backlog** (main `86120120` → `845a1678`): pushed 11 never-pushed fixer commits; merged PRs #88–#95; PR #87 landed as sanitized cherry-picks (a source comment carried a live figure), closed unmerged. Five read-only Opus reviews, then a four-fixer wave:
- `lib/import/engine.ts`, `app/api/import/route.ts`: unknown-account exclusion is opt-in (`excludeUnknownAccounts`) for the API route only; CLI imports throw before writing.
- `lib/calendar/briefing-html.ts` + `workers/cron/src/html.ts`: two consecutive short table rows stay two rows.
- `app/dashboard/components/CommandPalette.tsx`, `lib/compute/trade-roundtrips.ts`: queued Enter dies with the palette; spinner clears.
- `app/dashboard/security/[id]/page.tsx`, `lib/queries/options.ts`, `lib/compute/exposure.ts`: expired options drop out on the ET calendar; XIRR test reproduces its defect.

**(b) Earnings reconcile HIGH** (user ruling options 1+2; `7eb835a4`, `f46d80ae`): `lib/calendar/reconcile-earnings-dates.ts` — a manual row on the print date is the print; a row owning a delivered recap (sent on/after its date), a preview (±1 day) or an accepted print-watch line/callout is never a phantom; shared `createTwinFolder`; the loop now folds every losing row. New `scripts/repair-reconcile-stripped-actuals.ts` (dry-run default; folds the slot-matched donor first, `be457103`). One live cluster repaired with the user's authorization (backup in `data/backups/`, gitignored).

**(c) Statement-only synthetic closes** (user ruling option A; spec `docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md`; `f34e8ea1`, `e9f616e1`, `7278809c`, docs `70cea674`):
- `lib/db/holding-sources.ts`: `statementGradeHoldingSql(alias)` / `liveOriginHoldingSql(alias)` (legacy unsuffixed tombstones count only with a same-date statement-prefix row).
- `lib/compute/tax-lots.ts`: broker-close pass anchors on the newest statement-grade row; `lib/compute/synthetic-close-guards.ts` (shared split/fill guards).
- `lib/compute/tax-convention.ts`: stamp `v3r2`, "revision" staleness, statement-grade price bumps.
- `lib/mutations/closed-equity.ts`: origin-aware bumps; the statement pass confirms live flats dated before or on the statement date (same-date row relabelled in place).
- `lib/tws/positions.ts`, `lib/ibkr/refresh.ts`, `lib/plaid/refresh.ts`: no generation bump for live-only changes.
- `lib/queries/pending-statement.ts` (new), `lib/queries/tax-lots.ts`, `lib/queries/chat-tools.ts`, `lib/queries/portfolio-summary.ts`, `lib/queries/integrity-checks.ts` (`kind: "statement-lag"`), `lib/chat/tools.ts`, `lib/chat/system-prompt.ts`, `app/dashboard/tax-lots/page.tsx`, `TaxLotSummary.tsx`, `TaxLotTables.tsx`, `DataConfidenceIndicator.tsx`, the security hub page, `app/dashboard/components/pending-statement-copy.ts`.
- Static guard `tests/repo/synthetic-close-consumers.test.ts`; determinism test through the real live writers.

**Docs:** `docs/plans/TODO.md`, `docs/DECISIONS.md` (two 2026-10-02 entries), `CLAUDE.md` (statement-evidence invariant).

## 2. Tests / E2E / deploy

| Check | Result |
|---|---|
| Landing (a) | 5 Opus reviews; smoke 4/4; browser 8/8; full suite 10,346 passed; deployed `MAvVP2tJaoKOOlkfp6jmn` |
| Reconcile (b) | Opus review SHIP + minors folded; sandbox Refresh healed the damaged cluster 7/7; full suite 10,361; deployed `ZKYPuuPDTn2kU4bh0zR3C` |
| Synthetic closes (c) | Codex round (REVISE, 9 findings folded; ran with `-m gpt-5.5` because the configured default model is rejected on the ChatGPT login); Opus review SHIP-WITH-FIX (2 Important fixed) + focused re-review SHIP; smoke ok; browser 7/7 + expected chat skip; deployed `tXtTSFIbcDA0DU6TIk6z5` at `70cea674` |
| Final `verify.sh full --base main` | 10,489 passed, 0 failed |
| Flakes seen | print-watch watcher/replay and verify-CLI timing tests fail only under heavy machine load; each passes alone (existing TODO) |

## 3. Open concerns, rejected approaches, decisions

- User rulings: reconcile options 1+2; synthetic closes option A. Recorded in DECISIONS.
- Rejected: relabelling legacy tombstones in data (a historical repair); the code rule classifies them on read instead.
- The first reconcile after the (c) deploy writes zero-quantity `:stmt` tombstones dated the latest statement for pairs it omits and bumps the generation once; reviewed — no held position or bond/fund affected.
- Follow-ups in TODO: the statement pass dates confirmations at the LATEST statement (Dec/Jan crossing); undoing a batch that owns a relabelled tombstone briefly reads the pair as held; reconciler carryEnrichment slot preference; review-wave siblings (a)–(h) from the PR landing.
- Do not press Recompute on the live Tax Lots page before the September statements; run the rehearsed v2 recompute instead.

## 4. State after deploy

Main = origin/main. Live build `tXtTSFIbcDA0DU6TIk6z5`. Worktrees: only the nightly fixer's detached `../vanguard-skin-qa-fix`. Open PR: #96 (nightly fixer). Local branch `qa-fix-work-20260924` kept (its fix is now inside PR #96). No dev servers or sandboxes running; no locks held.

## 5. Agent

Claude Code (Claude Opus 5.5, 1M context) — https://claude.ai/code/session_01QhU9inSLtZLcsqj5b1ncvJ
