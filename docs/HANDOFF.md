# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-08-30 — landing the 16 stranded nightly-fixer commits (PR #57, PR #58, `qa-deep-fixes-2026-08-29`, `qa-deep-fixes-2026-08-30`) on branch `land-2026-08-30`, with an adversarial review pass before merge (4 Opus reviewers in parallel + 2 Codex rounds; Codex BLOCKed both rounds, every finding fixed).

## 1. Goal + exact files changed

**Landing (merge commits, no edits):** all 16 fixer commits merged as four `--no-ff` merges; one trivial conflict in `app/dashboard/security/[id]/FactorProfileSection.tsx` (flex-wrap vs a comment) resolved keeping both.

**Blocker — per-pair holdings resurrected closed positions.** PR #58's HIGH fix (`lib/queries/holdings.ts` → `latestHoldingsPredicate`) was right but exposed that the old per-account `MAX(as_of_date)` had been the de-facto closed-position filter for every asset class the reconciler skipped. On the live DB: two mutual funds fully sold 2026-05-05 (statements omit them; Plaid never reports funds) and eight options that dropped out of Plaid's daily book one at a time in August (46/46 options otherwise reported; no sell imported until the statement lands) all came back as live positions. Fix: `lib/mutations/closed-equity.ts` is now a THREE-PASS reconciler — (1) statement pass, any type except cash equivalents (`isCashEquivalentSecurity`), tombstone at the latest statement-sourced date, shrink-guarded statement-vs-prior-statement; (2) equity pass unchanged; (3) option pass, only when the latest live snapshot carries ≥1 option row, per-class shrink guard. Name/signature/return/call sites unchanged. Rehearsed on a `VACUUM INTO` copy of the live DB: exactly 2 funds (at 7/31) + 8 options (at 8/28), second run 0; `getAllHoldings` then returns 153 rows (123/18/12) with the 6 Treasuries and VMFXX×2 intact. Docs: `docs/reference/auto-refresh.md` §1.8, `docs/DECISIONS.md`.

**Fix-firsts / should-fixes from the reviews (13 follow-up commits, all by path):** `lib/ai/extract-json.ts` (whole-text-first lenient parse + C0 retry + `what` noun; `extractJsonArray` byte-identical), `lib/compute/classify-factors.ts` + `classify-securities.ts` + `lib/securities/classify-option-sectors.ts` (no NULL-only classification rows; zero-usable reply = batch error; sibling "not iterable" sites share the helper); `lib/queries/data-health.ts` (gap lists on the shared predicate; `todayET()`); `CashDeployCard.tsx` (Gap via `<PrivateText>`), `TrustStripDrawer.tsx` (single-month copy; distinct not-comparable months via `<Count>`), `EarningsHubAddForm.tsx` (out-of-week save note; true comment); `WhatIfCalculator.tsx` (`signedPp`/`formatDeltaUsd` negative-zero), `ClassificationCard.tsx` (`displaySecurityName`), `AccountDetail.tsx` (snapshot date = max across rows); `electron/external-url.ts` NEW + `main.ts` + `ipc-handlers.ts` (one allow-list for both exits; own-origin `_blank` → in-session child window so Settings → Plaid Reconnect works; file:/javascript:/custom denied), `lib/email/archive-srcdoc.ts` (existing `<base target>` and `_self/_parent/_top` forced to `_blank` outside script/style regions; `allow-same-origin` dropped); `lib/ai/classify-anthropic-error.ts` (error.type first; never embeds a non-JSON body), `lib/earnings/extract-bogeys.ts` (auth/rate-limit get their message), `lib/import/error-classify.ts` (envelope classifier wired; status-prefixed non-JSON bodies → generic); `NotificationBell.tsx` + `RecentAlertsPanel.tsx` (public level prices plain, incl. levels-to-review); test pins that were vacuous (nearby-levels privacy, eps-delta negative cases, statement-only cost basis).

## 2. Tests / E2E / deploy result

- Full suite on the branch tip: **598 files / 6,997 passed / 0 failed** (6,869 at landing, before fixes). `npx next build` green. `tsc --noEmit`: the 20 pre-existing errors in four untouched test files only; `electron/tsconfig.json` clean.
- Browser E2E on a secret-less-intended dev server (:3095, `VACUUM INTO` DB copy, minted QA session, `APP_EXTRA_HOSTS`): **12/12 PASS** across Accounts (163 rows = DB oracle; old query 12), Factor Profile withhold + 375px wrap, week-ahead chips (16 green / 6 red / 9 neutral, negative-EPS cases right), add-ticker default date, privacy vs public level prices, What-if deltas, Cash-Deploy gaps, trust drawer, Data Health coverage, email link → new tab with iframe untouched, ET bogeys stamp, plain-English upload errors. Evidence: session scratchpad `e2e/shots/` (not in repo). After the reconciler: 153 rows via the exact page query, no phantoms, snapshot chip "Aug 28 · 2d ago" (was a false "Jul 31 · 30d ago").
- Gotcha learned: `ANTHROPIC_API_KEY=` (empty) does NOT disable the key — `@next/env` fills set-but-empty vars from `.env.local` (two small real calls were made). Use an invalid non-empty value next time.
- Deploy: see §4.

## 3. Open concerns / rejected approaches / decisions

- **Decisions** (in `docs/DECISIONS.md` 2026-08-30): statements are complete books → statement pass any type; options only with presence evidence; cash equivalents never reconciled; own-origin `_blank` → child window. Rejected: landing the per-pair fix alone (visible phantom value), reverting to per-account MAX (drops every statement-only Treasury), denying own-origin (dead Reconnect click).
- **First live run of the reconciler is a watch item** (TODO): expect ~10 marks on the next Plaid/TWS sync or import; inspect `holdings WHERE source_key LIKE 'recon:closed-equity:%'` if materially more.
- **Filed, not done:** ~15 sibling `MAX(as_of_date)` call sites (Today holdings, portfolio summary, chat tools, briefing, options, R2 snapshot) still disagree with Accounts on statement-only Treasuries — its own review round (TODO). Reviewer nits batched in one TODO entry.
- **Owner action still pending from 8/28:** Anthropic credit balance (`[levels/extract] … credit balance is too low` in the live log) — every AI feature degrades until topped up.
- 8 `needs-decision` QA findings remain in `qa/findings/DECISIONS-PENDING.md` (1 HIGH: Tax Lots account filter ignored by TAX REPORT card + exports).

## 4. Uncommitted changes / live-process state (post-deploy)

- Branch `land-2026-08-30` fast-forward-merged to main (32 commits) and pushed (`16ff141..19bf652`, TODO reconcile `649c6fb`); PRs #57 and #58 auto-marked MERGED. DEPLOY: `npm run electron:deploy` green — notarization successful, `verify-bundle: OK`, installed + relaunched. Packaged-app checks on :3099: `/login` 200; authenticated `/api/summary`, `/dashboard/today`, `/dashboard/accounts` (+`?id=1`, snapshot chip "Aug 28"), `/dashboard/analysis` all 200 via a temporary QA session (revoked). FIRST LIVE RUN of the three-pass reconciler fired on launch: `[auto-refresh] Reconciled 10 closed equity holdings` — exactly the rehearsed set (VHGEX, VIPSX at 7/31; NOK/WIX/AMZN/IGV/ICL/NBIS/HOOD/XOM options at 8/28). The `1 errors` in the auto-refresh summary is pre-existing (same on 8/28).
- QA branches whose commits are now on main: `qa-auto-fixes-2026-08-29`, `qa-auto-fixes-2026-08-30`, `qa-deep-fixes-2026-08-29`, `qa-deep-fixes-2026-08-30`, plus the local twins `qa-fix-work-20260829/30` (same subjects, different hashes). Branch deletion left to the owner (destructive). Fixer worktree `../vanguard-skin-qa-fix` untouched.
- The :3095 sandbox server was stopped; its DB copy lives only in the session scratchpad.

## 5. Claude session link

https://claude.ai/code/session_016F7iG9Ytf2BYfC6bEWa8LC
