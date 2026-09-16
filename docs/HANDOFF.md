# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Waiting on:** USER: (a) the option-attached-levels repair `--apply` after a look at its seven `review` rows; (b) the broker-realized transcription then `reconcile-tax-report-vs-broker.ts --stamp`; (c) whether to build the opening-lots importer for the pre-ledger Vanguard positions. Otherwise nobody: no open PRs, no unlanded qa branches.

**Evening addendum (2026-09-15, ~19:40–20:50 ET, user at the keyboard):** the runbook's steps 1–2 ran live (direction backfill on copy then live; v2 recompute on copy then live; the script's idempotence check false-alarms on synthetic-close ids — TODO (l)). Then, on the user's delegation, four ledger repairs applied live with backups in `data/backups/`: CRWD re-symbol (`scripts/repair-mistyped-option-legs.ts`, new targets + a stale-refusal fix) plus the August-31 unsettled sale imported (batch 216); FB→META merged (`scripts/merge-duplicate-securities.ts`, table list completed); the Twitter cash merger imported as a SELL (batch 217); UBER rewritten to the fund's three carryover lots (new `scripts/repair-inkind-transfer-lots.ts`, config gitignored), two December-2023 transfer legs (batch 218) + DAF contribution records (batch 219) with FMV = close on the transfer date, lots assigned FIFO and the January-2025 gift re-assigned under MinTax. Final v2 recompute: identity ok, marker `v3:103`; integrity criticals 24→19 (all statement lag, pre-ledger opening lots, or the cash-equivalent false positive). Details: `docs/DECISIONS.md` 2026-09-15 evening entry.

**Session date:** 2026-09-15 (Tuesday) ~10:20 ET → ~11:40 ET. Focus (user pick at session start): B then A — diagnose the tax-lots Recompute engine gap on a copy while the nightly chain finished, then land PRs #81/#82 and deploy. Quick items first: the landed coord worktree and six merged `claude/*` branches removed; the option-attached-levels repair dry-run.

## 1. Goal + exact files changed

**B — Recompute engine-gap diagnosis (read-only, VACUUM copies in the session scratchpad; no live writes).** Report: `docs/private/recompute-diagnosis-2026-09-15.md` (gitignored, real figures). Direction-only summary:
- The 82→45 confidence drop after a press is the position-vs-lot integrity scan waking up: it is dark while the convention stamp is stale (`legacy` vs the current input generation) and lights when the press re-stamps. The drift it reports predates the press (a SQL replica of the scan on the legacy lots finds the same count).
- The minted synthetic closes and the "unmatched closing quantity" warnings come from historical IBKR fills carrying no `IBKR trade direction:` note, so under the chronological engine every short round-trip fails to match. Pressing Recompute before the direction backfill would publish phantom realized gains (synthetic closes of un-covered cover lots) — the ruling stands.
- With the direction backfill rehearsed on a copy (all twelve `ibkr-activity` batches have their original file on this Mac — Desktop, Downloads and the Trading subfolder), synthetic closes and unmatched warnings collapse to a handful, short lots are modeled, backwards matches go to zero, and realized figures sit next to the legacy ones. The engine is idempotent across consecutive runs; the ledger row's "non-idempotent" claim is wrong.
- Residual after the backfill, classified: statement lag (self-heals on the September import), pre-ledger Vanguard positions with no opening lots (`tax_lots.is_from_opening_snapshot` has no producer; the Vanguard cost-basis export is a candidate seed), the cash-equivalent false positive in `scanLotDriftHits`, the CRWD option re-symbol, FB→META, UBER, forex, two mixed O;C rows.
- Docs: `docs/plans/TODO.md` (new item at the top of Bugs / Quality + pointers on the P0 runbook and trade-review items), `docs/DECISIONS.md` (2026-09-15 entry). Register: `recompute-diagnosis-2026-09-15` in review with the `USER:` next action.

**A — Landing of PRs #81/#82 + the stranded `qa-deep-fixes-2026-09-15` commit (main `ae1709e1` → `a943e7b9`, 21 commits).** Built in the main checkout (no parallel session was live): #81's four commits cherry-picked — `dc305d75` re-committed as `2ba771d7` with a synthetic fixture and sanitized message (its message AND test carried live alpha/R² figures from the ledger; PR #81 closed unmerged, remote branch deleted, the original SHA filed as a purge candidate); #82 merged `--no-ff` (GitHub shows it merged); the 09-15 sweep commit merged `--no-ff` (the sweep died before its run log, so the anti-strand guard never opened a PR). Ten review-fix commits on top, one owner per file:
- `05ef1717` release-time refusal copy + case-insensitive param guard + tighter quantity-unit pin
- `07d66114` `interpretBeta` R² tiers, alpha tile colour by tone, direction-only comment, wiring pin
- `ab1e8002` `WeekOverWeekBadge` masks itself (fixes 8 call sites), null delta keeps the em-dash
- `ebbdca85` ScenarioModeling: `setError(null)`, request token, `setExpanded(null)`
- `1ed88aa9` AllHoldingsTable/HoldingsTable: split exclusion tooltip, em-dash titles, zero→null sort key, abs-denominator footer %, per-account zero = unknown
- `52664084` `lib/valuation.ts` + `security-detail.ts`: zero basis falls through to the statement-row rescue on both sides of the SQL; security total counts only known legs
- `fb00e578` wash-sale nearest replacement (tie → after), same-day wording, exported phrase rendered by the card, non-listed fixture ticker
- `b6d99f0f` expiry-day theta capped at remaining time value (`sameDayTheta`), as-of `today` without `now` no longer mixes the live clock
- `f520a12d` security hub DTE via ET-anchored `daysToExpiry` (was UTC midnight minus local now)
- `1a282a41` notes copy: 401/403 → session expired, unreadable 2xx named, error on its own row, typing clears it, lazy draft hydration
- `a943e7b9` docs

## 2. Tests / E2E / deploy result

| Check | Result |
|---|---|
| Three read-only Opus landing reviews against the built integration branch | #81: 2 LAND + 2 LAND-WITH-FIX (1 Critical = live figures in `dc305d75`; 5 Important); #82: 4 LAND-WITH-FIX (8 Important incl. the expiry-day theta blow-up and the wash-sale selection bug); 09-15 commit: LAND-WITH-FIX (2 Important) |
| Privacy scan (added test lines + all commit messages, before and after the fix wave) | clean except the reviewer-found alpha/R² figures → sanitized cherry-pick |
| Fix wave | 10 fixers (7 Sonnet, 3 Opus), TDD, mutation-verified pins, no agent git writes; orchestrator committed by pathspec (new test files need `git add` first) |
| `tsc --noEmit` | 20-error baseline, none in changed files |
| `next build` | clean (BUILD_ID `7-2dki39bBQUtdHi5U8LU` on the tip pre-docs) |
| Sandbox `:3090` + `npm run smoke` | 4/4 |
| Browser pass (agent-browser CLI — both browser MCPs were down) | 8/8: release-time refusal via the API (new copy, no param name); Market Regression beta/alpha "Indicative only" at a loose fit, alpha masked under privacy; Position-Level Risk masked with a null delta still showing the em-dash; all-accounts footer "N positions excluded — N with unknown cost basis" + `~` disclosures + em-dash tooltips; wash-sale phrases (no old copy); security hub `(3d)` for a contract expiring in three days; notes overlay 401 → "your session has expired… your note is still here" with the draft kept and the error clearing on typing |
| Full suite on the tip (`verify.sh full --base main`) | 819 files, 9,863 passed, 9 todo, 0 failed, result=passed |
| Ledger | 11 rows → `merged` with landed SHAs (backup `ledger.json.bak-2026-09-15-landed`) |
| Deploy (`npm run deploy --commit a943e7b9`) | **DEPLOYED 11:24–11:31 ET**: locks taken, preflight ok (no wrangler leak, notarization creds present), pack + `verify-bundle` OK, notarization successful, installed BUILD_ID `JI2pWt48T_Cn4w1pemkaj` == built, codesign verified, new listener answered `/login`; log `.git/portfolio-desk-coord/logs/deploy-20260915T152434Z.log` |

## 3. Open concerns / rejected approaches / decisions for the user

- **Nightly deep sweep died before its run log (2026-09-15):** the wrapper logged `DEEP-QA FAILURE … wrote no run log`; the ledger was merged (22 filed, 1 high) and one auto-fix committed, but no `runs/2026-09-15.md`, no Pushover, and the fixer chain never ran. Filed as TODO (j); the sweep's last message says its worktree suite was still running in the background — same headless background-ceiling class as before. Worth checking `qa/nightly-deep-qa.sh`'s finalization order before tonight.
- **Purge candidate:** PR #81's original `dc305d75` (message + fixture with live figures) is reachable through the PR ref — same class as the 2026-09-11 purge question the user declined (TODO (k)).
- **Product calls flagged by the reviews, not decided here:** Position-Level Risk stays sorted by risk contribution under privacy (ranking readable from row order) and the Pairwise Correlations matrix stays unmasked; a fix answering neither was landed.
- **Behaviour change to note:** on an option's expiry day, far-OTM hedges now carry ~0 delta so `computeDefenseAnalysis`'s protection ratio reads ~0 that day (previously excluded outright). Financially right; no code change.
- **Rejected:** merging PR #81 as-is (leaky commit); amending inside the merge (rebuilt the branch instead); a call-site privacy wrapper per badge (moved the mask into the badge); clamping theta at full option value (capped at remaining time value so a deep-ITM put keeps its carry sign).
- Follow-ups from the reviews are one TODO item (`[qa-landing 2026-09-15 follow-ups]`, a–k): ~20 raw `err.message` render sites, privacy-aware quantity nouns, Data Health's fourth cost-basis fallback copy, beta tile colour at low R², the position-risk route's `resolveScopeToSingleId` + UTC today, `WashSaleWarning.description` unused.

## 4. Uncommitted changes / live-process state

- Main checkout clean at the handoff commit on top of `a943e7b9`, pushed. No integration worktree (built in the main checkout). Nightly `../vanguard-skin-qa-fix` worktree still checked out on `qa-deep-fixes-2026-09-15` (landed; the branch cannot be deleted while checked out there — the fixer detaches it on its next run).
- Sandbox `:3090` down; no locks held; register: `qa-landing-2026-09-15` landed, `recompute-diagnosis-2026-09-15` in review, `user-run-data-steps-2026-09-14` planned (USER).
- Remote: no `qa-*` refs; PR #81 closed, PR #82 merged. Local: only long-lived branches remain (`analysis-classification-backbone`, `ibkr-ledger-rebuild`, `pair-2026-08-28-landing`, three `codex/*`) plus the checked-out `qa-deep-fixes-2026-09-15`.
- Scratch evidence (session scratchpad, not persisted): the three DB copies, `diag-*.log`, `direction-manifest-all12.json`, screenshots.

## 5. Claude session link

https://claude.ai/code/session_012dDyMM5EHardGpmxaF73Gc
