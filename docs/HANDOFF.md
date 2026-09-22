# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Waiting on:** USER: the queued data steps, in order — (1) the Roth `tax_treatment` stamp `--apply` (rehearsed on a VACUUM copy this evening: applies, second run is a no-op; live DB write needs your go); (2) the option-attached-levels repair: dry run shows 0 move / 3 leave / 6 review / 2 duplicate, the six review rows need your judgment; (3) the broker-realized transcription then `reconcile-tax-report-vs-broker --stamp`; (4) the opening-lots importer decision. (Evening addendum: the Herfindahl ruling (gross weights) and the position-risk maturity filter were implemented and deployed — see below; the four cherry-picked local branches were force-deleted on the user's instruction.) Earlier-handoff standing items, restated: option-attached-levels review rows, broker-realized transcription then `reconcile-tax-report-vs-broker --stamp`, the opening-lots importer, the retirement-account `tax_treatment` stamp (register `qa-fix-findings-2026-09-16`, `user-run-data-steps-2026-09-14`); (d) purge decision now covers PR #86's originals too (TODO privacy item). Otherwise nobody: no open PRs, no stranded `qa-*` branch.

**Session date:** 2026-09-22 (Tuesday) ~11:05 ET → ~12:30 ET, then an evening block ~16:35 → ~18:15 ET. Focus (user pick at session start): land PR #85 + PR #86 + the stranded fixer branches and deploy; print-watch schema decision A.

## 1. Goal + exact files changed

**Why:** the 2026-09-20 16:30 ET model-catalog refresh moved the frontier tier onto a model family that rejects forced tool use, so the LIVE app's Trade Reviews and the print-watch first-pass read had been dead since then with no code change (found by the 09-22 deep sweep).

**Landing (main `93be54b1` → `617e41c1`, 28 commits, built on `claude/qa-landing-2026-09-22` in the sibling worktree `../vanguard-skin-landing` because the nightly fixer was still running its suite in the main checkout at session start):**
- PR #85 merged (`b2de01a4`): `lib/ai/generate.ts` requests native Anthropic structured output, `lib/ai/classify-anthropic-error.ts` gains `model_capability`, `app/api/trade-review/route.ts` + `TradeReviewView.tsx` render domain-language failures.
- Print-watch decision A (`800617f4`, `7c540b19`): `lib/print-watch/first-pass-prompt.ts` schema carries no array count keyword (native mode rejects `minItems` other than 0/1 AND `maxItems` — the second fact came from the re-probe); counts stay in `lib/print-watch/read.ts`, which now passes `FIRST_PASS_MAX_OUTPUT_TOKENS`. Tests: `tests/ai/structured-output-schemas.test.ts` (fails on any count keyword), `tests/print-watch/first-pass-prompt.test.ts`, `tests/print-watch/read-max-output-tokens.test.ts`.
- PR #86 landed as six sanitized cherry-picks (`30223934` `0d8f2770` `7285fc3f` `506885ea` `3599ae62` `75c22c65`) — three originals carried the live book's effective-position count / HHI in a source comment and test, and a live integrity-hit count in a test comment; PR closed unmerged, remote branch deleted. Files: `EarningsConflictMarker.tsx`, `DataConfidenceIndicator.tsx`, `DrillDownPanel.tsx`, `lib/queries/concentration-universe.ts` (new), `drill-down.ts`, `analysis.ts`, `lib/compute/risk.ts`, `lib/analysis/interpret.ts`, security hub + WeekAheadView.
- 09-20 fixer branch merged (`a5e61e70`, 7 commits — the register/TODO had wrongly recorded it "0 ahead"): `lib/queries/data-confidence.ts`, `today-holdings.ts`, `lib/digest/group-by-company.ts`, `lib/securities/normalize-market-cap.ts` (new), `lib/compute/factors.ts`, `lib/queries/analysis.ts`.
- Review fix wave (7 fixers, one owner per file): `917802c1` route/view; `de3b5cd2` data-confidence.ts + indicator; `280469ae` `lib/compute/scenarios.ts`, `lib/queries/chat-tools.ts`, `lib/compute/factors.ts`; `23a14488` group-by-company.ts; `feb8de25` `lib/queries/holdings.ts`; `eb2de4fe` drill-down.ts + DrillDownPanel.tsx + concentration-universe.ts; `291f2088` interpret.ts + ClassificationCard.tsx; `7dd76ddb` browser-pass residuals (data-confidence cash/holdings action gates, trade-review sentence termination).
- Docs: `4a61401d`/`617e41c1` (TODO closed block + follow-ups + purge addendum, DECISIONS 2026-09-22 entry, CLAUDE.md AI/LLM convention line).
- The 09-17 fixer branch was NOT landed: every one of its four fixes was already on main as an edited cherry-pick (Codex `0052ec8d`).

## 2. Tests / E2E / deploy result

| Check | Result |
|---|---|
| Read-only Opus landing reviews (3, one per branch, against the merged tree) | no DO-NOT-LAND; #85 LAND-WITH-FIX (2 Important), #86 LAND-WITH-FIX (4 Important incl. a privacy leak + a caption claiming a parity the code lacks), 09-20 branch LAND-WITH-FIX (5 Important, all sibling call sites) |
| Privacy scan (commit messages + added lines, before and after the fix wave) | clean except the reviewer-found ratios → sanitized cherry-picks |
| Paid probes | print-watch first pass ×2 (first exposed `maxItems`; second answered with a parsed object from the frontier model) |
| `verify.sh changed --base main` | 624 files / 7,061 passed (manual-selection-required, as expected for the diff size) |
| `tsc --noEmit` | 0 errors (three times) |
| `npm run build` | clean, twice (before and after the fix wave) |
| Sandbox `:3090` from the worktree + `npm run smoke` | 4/4 |
| Browser pass (agent-browser CLI; both browser MCPs down) | 8 items: 6 PASS, 1 PARTIAL (data-confidence Holdings/Cash action rows — fixed in `7dd76ddb`), 1 COULD-NOT-CHECK (no expired-but-held option and no capped score on the DB copy); console clean |
| `verify.sh full --base main` on the tip | 856 files, 10,186 passed, 3 skipped, 9 todo, 0 failed (with `/usr/sbin` on PATH — the "5 known coord failures" are the missing `lsof`) |
| Ledger | 12 rows → `merged` (backup `ledger.json.bak-2026-09-22-landed`) |
| Deploy | **DEPLOYED 12:18–12:24 ET** via `npm run deploy -- --task qa-landing-2026-09-22 --commit 617e41c1`: preflight ok (notarization creds present), pack + bundle gate ok, notarization successful, POST-VERIFY BUILD_ID `SAlZvgr0PvDfILrDRIqw7` matches on both sides, installed to `/Applications/Vanguard Dashboard.app`; log `.git/portfolio-desk-coord/logs/deploy-20260922T161820Z.log` |

## 3. Open concerns / rejected approaches / decisions for the user

- **Signed-weight Herfindahl with shorts** (reviewer, PR #86): both cards now square SIGNED weights; a short adds `w²` and shrinks the denominator (unbounded; a long/short pair can print HHI > 1 and "~0 equal positions"). Negligible today (shorts ≈0.1% of gross MV). Needs the user's ruling — filed, not changed.
- **Three universes on the Analysis page, not one:** Concentration chart (signed, unpriced at cost, matured excluded) vs risk drawer / Position-Level Risk (priced longs, no maturity filter) vs sector drawers. The drawer caption now says what it is instead of claiming parity. Folding `computePositionRisk` onto the shared universe changes published risk figures → user call.
- **Rejected:** pinning `printWatchFirstPass` to the workhorse tier (hides a capability bug behind a tier preference); merging PR #86 as-is (leaky commits); running the browser pass from the main checkout while the fixer's suite was alive; landing the 09-17 branch a second time.
- **Follow-ups filed** (TODO `[qa-landing 2026-09-22 follow-ups]` a–j): generate.ts jsonTool fallback + regex single-source + Worker `generateWithFailover` mirror + pin the four other anthropic `generateObject` schemas; TradeReviewView success banner renders raw `tradeCount`/`winRate`; drill-down `"risk"` sort default defeated by a persisted URL param; data-confidence price action string singular; market-cap SQL twin whitespace; legacy `YYYYMMDD` `expiration_date` rows read as always-live; Worker `bucketByCompany` non-dedupe; source-pin anchor sweep (`indexOf` → -1 makes a pin cover the whole file); position-risk route multi-account scope.
- **Process fact:** the nightly fixer was still running `verify.sh full` in the main checkout at session start (its run log was already written); a session-start `ps` for `claude -p` is now part of the landing recipe (memory).

## 4. Uncommitted changes / live-process state

- Main checkout clean at the handoff commit on top of `384749ac`, pushed; installed app build `XGu6CTFrX6DGlANPeefX2` (commit `384749ac`). No sandbox up (the :3090 landing sandbox and the sweep's leftover :3097 server are down); no locks held; the landing worktree `../vanguard-skin-landing` was removed after the fast-forward.
- Worktree `../vanguard-skin-qa-fix` (the nightly fixer's) sits detached at `93be54b1`, clean. The four cherry-picked local branches were force-deleted on the user's instruction (evening); the PR #86 originals remain reachable via `refs/pull/86/head` regardless (purge item).
- Remote: no `qa-*` branch with unlanded commits; open PRs: none; open issues: #34 only (process, unchanged).
- Ledger: 12 rows flipped to `merged` (backup `qa/findings/ledger.json.bak-2026-09-22-landed`). Register: `qa-landing-2026-09-22` landed with deploy evidence; decision records open: `herfindahl-signed-vs-gross-weights` (new), plus the standing user-run data steps.

## Evening addendum — Herfindahl ruling implemented + deployed

- **Rulings:** user → gross |MV| weights; Claude (delegated) → `computePositionRisk` excludes matured securities only (shorts/unpriced stay out: risk contribution needs a price and a return series). Decision entry "2026-09-22 (pm)" in `docs/DECISIONS.md`.
- **Commits:** `47073d45` (lib/queries/concentration-universe.ts — gross total helper, `ORDER BY ABS(SUM(market_value))`; lib/queries/analysis.ts getConcentrationMetrics; lib/compute/risk.ts computeConcentration + computePositionRisk maturity guard; drill-down.ts + DrillDownPanel.tsx comments; tests incl. new tests/queries/concentration-gross-weights.test.ts) and `384749ac` (docs). Latent bug fixed on the way: the universe's ORDER BY bound `market_value` to one unaggregated account leg (SQLite resolves a bare name in an ORDER BY expression against FROM before the SELECT alias), so a cross-account position ranked on whichever leg SQLite picked.
- **Effect on the live book:** the two shorts are ~1.2% of gross value (the TODO's 0.1% checkpoint was stale), so effective positions read ~62 instead of ~59 at the all-accounts scope; both Diagnostics cards agree (sandbox :3091).
- **Evidence:** tsc 0; `verify.sh changed` passed; `npm run build` clean; smoke 4/4; full suite 857 files — 10,206 passed, 1 failed = the documented `tests/print-watch/watcher.test.ts` timing flake (passes twice in isolation); an earlier run's 10 `tests/ai/generate.test.ts` failures were the worktree's missing `.env.local`, not the diff.
- **Deploy:** DEPLOYED 18:05–18:12 ET, commit `384749ac`, BUILD_ID `XGu6CTFrX6DGlANPeefX2`, notarized, installed, post-verify ok (`deploy-20260922T220540Z.log`). Worktree `../vanguard-skin-hhi` removed; branch deleted.
- **Not done (still on the follow-ups item):** one weight denominator for the whole Analysis page (the risk drawer still ranks priced longs only, by design).

## 5. Claude session link

https://claude.ai/code/session_015RBtyCNZwpWSibvN21KWnm
