# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-16 (pm) — QA-branch landing + 17 QA decisions + Codex-advisory batch (#48/#49 + 2 blocked findings)

## 1. Goal + exact files changed

Three-part session, user-picked at session start.

**Part 1 — landed all three unlanded QA fix branches (15 fixes total):**
- Merge `origin/qa-auto-fixes-2026-08-14` (= PR #51, now MERGED): Filtered-audit pagination past 100 with full-set `categoryCounts` on a shared predicate builder (`lib/queries/research.ts`), All-Accounts holdings `quantity != 0` (shorts render, reconciler tombstones don't) (`lib/queries/holdings.ts`).
- Merge `qa-deep-fixes-2026-08-14`: sanitizer JSON-envelope remnant guard (`lib/gmail/theme-sanitize.ts` + Worker mirror `workers/cron/src/fallback-digest.ts` + render-side in `ResearchFeedsView` + storage-side in `reconcile-cloud-fetched.ts`), email word-break (`briefing-html.ts` + mirror `html.ts`), concentration-chart y-axis margin, expired-option "(expired)" label. **Conflict resolution note:** the branch's week-ahead crash fix was superseded by main's round-2 `reaction-snapshot-core.ts` layout (branch's shape would re-drag `@stoqey/ib` toward client bundles) — resolved toward main, duplicate helpers dropped.
- Merge `qa-auto-fixes-2026-08-16` (clean): level past-expiry 400 gate (`app/api/levels/route.ts`, ET-anchored, create-only), narrative plausibility guard at storage/render/accept (`lib/levels/narrative-guard.ts`, new, pure), slot-only date-correction fix (`lib/mutations/calendar.ts`, adopted-manual-row slot update — sync-owned invariant respected), RECONCILE_CLOSE excluded from account transactions, stale-bar as-of captions (`MarketDataPanel.tsx`), risk-vol window/basis captions + `MIN_POSITION_OBSERVATIONS` basket floor (`lib/compute/risk.ts`), position-risk narrative re-ranked by riskContribution, clean vanguard-pdf JSON-parse errors.
- Branch cleanup: all `qa-auto-fixes-*`/`qa-deep-fixes-*`/`qa-fix-work-20260814/15` deleted (local + remote); `qa-fix-work-20260816` left (checked out in the fixer's worktree; content fully landed).

**Part 2 — 17 QA decisions recorded** (`qa/findings/ledger.json`, gitignored; backup `ledger.json.bak-2026-08-16-decisions`; `DECISIONS-PENDING.md` rewritten with a summary): all 17 pending findings now `disposition: auto` with `DECIDED:` plans, `decision_resolved: 2026-08-16`. User overrode the recommendation on 3: Workspace keeps vanguard default (+ pills + visible label, NOT scope=all); Cash-Deploy widens to held securities in underweight sectors; Credit Rating pill is hidden. Paired scenario fixes (exponential duration + additive shock composition) are one implementation unit. Five findings carry USER-RUN data companions (fixer must not touch live DB); the `symbol_release_times` composite-PK migration is PR-only; import post-commit backgrounding got explicit protected-pipeline sign-off (route-level only).

**Part 3 — Codex-advisory batch, 4 fixes as 4 commits** (implemented by parallel Sonnet subagents, reviewed by session model; issues #48 + #49 closed):
- `TodayReleases.tsx` + tests: upcoming-mode released-date gate (`upcomingRowReleased`/`isReleaseEnriched`, ET, mirrors `releasedFigureGates` — do-not-fork comment).
- `lib/levels/action-visibility.ts` (new) + `LevelsPanel.tsx` + 3 test files: Pause/Reactivate on every row regardless of review status; Re-queue on active+rejected rows via existing `PATCH /api/levels/review` `status:"pending_review"` (never `approveLevelGuarded`); chip guidance matches reality.
- `DataConfidenceIndicator.tsx` + static-scan test: Actions section `message`/`fix` wrapped in `<PrivateText>` (portfolio-derived counts/tickers/account names).
- `app/dashboard/alerts/page.tsx` + tests: `buildReviewSections`/`isDefaultStreamSort` — explicit sort renders one flat globally-ordered section; default sort keeps author grouping.

Also: `docs/plans/TODO.md` — added [#52] tracking line (evidence-driven verification loop); advisory-batch item marked fixed.

## 2. Tests / deploy result

- Full suite after each phase; final **5,365 passed + 9 todo (487 files), 0 failed**; `next build` clean (stale `dist/` removed first per the known gotcha). `tsc --noEmit` still carries only the pre-existing unrelated test-file errors.
- **Worker deployed** (sanitizer + html mirrors changed): `vanguard-skin-cron` version `5cfc667b`, `*/15` trigger intact.
- **Electron deployed**: signed, **notarized**, installed to /Applications, relaunched. Post-launch health: server log `Ready in 71ms`, TWS sync pipeline started immediately (synchronous stages block HTTP for a stretch right after boot — health probe polls until /login returns 200).

## 3. Open concerns / decisions

- The nightly fixer's next run implements the 17 DECIDED plans' auto halves; the five USER-RUN repair scripts need supervised sessions (tax-lot backfill, empty-enrichments, LAC/LAND re-verify, OCC dupes, ghost securities).
- `workers/cron/fallback-evening.ts:176` still carries a literal beta-lookback 60 (harmless while the constant is 60 — noted in TODO).
- Deferred: [#52] verification-loop tooling, [#34] review-intake process, [#35 Phase 2] passkeys — all in TODO Open items.

## 4. Uncommitted changes / live-process state

- Working tree clean; `main` pushed through the advisory-batch commits. Open PRs: none. Open issues: #52, #34.
- Live: packaged app (rebuilt today) on loopback `:3099` behind the #35 boundary; `cloudflared` tunnel LaunchAgent; Worker fallback-only (new version live). QA ledger decisions are local-only (gitignored).

## 5. Claude session link

https://claude.ai/code/session_01Jz646DAdkWmVkp3oLErRs6
