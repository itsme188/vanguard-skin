# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Waiting on:** USER: (a) review/land the 2026-09-14 nightly PRs #81 and #82 (eight commits, nothing auto-merged — the same landing recipe applies); (b) the three remaining user-run data steps in `user-run-data-steps-2026-09-14` once their code halves land. Otherwise nobody. The JPY repair is DONE (user ran `--from-ibkr --apply` and synced; the row is `ibkr_ledger`).

**Session date:** 2026-09-13 (Saturday evening) ~20:45 ET → ~21:50 ET. Focus (user pick at session start): land the four stranded nightly-QA PRs #77–#80 and rebuild. Housekeeping first: seven stale local `qa-*` refs whose content had landed as sanitized cherry-picks, the `claude/qa-landing-2026-09-11-v1` backup, and five merged origin branches deleted; three prunable Codex worktree registrations pruned.

## 1. Goal + exact files changed

- **Same-day follow-up (2026-09-14 evening, main `0075c14a`, build `eEKR4YpxMpJWel3ruFhrt`): the TWS FX derive is deleted.** The user saw a large phantom loss on Today (a 2% yen move on a position booked at ~7× the account). Root cause confirmed on the live DB: TWS `Position.marketValue` is native currency, the derive produced exactly 1.0, and the precedence guard only protects currencies that already hold an `ibkr_ledger` rate (the Web API fallback writes those, but only while TWS is disconnected). Files: `lib/tws/positions.ts` (derive block + imports deleted), `lib/ibkr/map-positions.ts` (`deriveUsdPerUnit` removed), `lib/mutations/fx-rates.ts` (any `*_derived` rate within 1% of parity for a non-USD currency is skipped with a warn), new `scripts/repair-fx-rate.ts` (+ tests; `--from-ibkr` reuses `fetchIbkrPortfolio`, `--usd-per-unit` writes `manual`, dry-run default, `REPAIR_DB_PATH`), `tests/tws/positions-fx-removal.test.ts`, obsolete derive test removed from `tests/tws/positions.test.ts`. Suite on main 806 files / 9,713 passed; deploy preflight + notarization + bundle gate ok. Dry run against the live DB proposed the broker ledger rate; nothing written — the `--apply` is the user's.

- **Integration branch `claude/qa-landing-2026-09-13`** (main `4a2c5e83` → `fce2ddde`, 25 commits, 51 files): merges of #77 (`f5dd7aae`) and #78 (`e8e2da33`); cherry-picks of #79's three and #80's four commits — two re-messaged (the holdings-unit and Finnhub commits named live portfolio counts), the Finnhub one re-amended again when review found the same counts in its comments and fixtures (`14926bc8`); seven review-fix commits `7dda6827` `4df41ca1` `1471616f` `f7a9e526` `a88928ed` `69731c52` + the Today-pin update inside `1471616f`; docs `85c79d8f` + `fce2ddde`. Full list: `git diff --stat 4a2c5e83..fce2ddde`.
- PRs #77 and #78 close as merged (their heads are ancestors of main). PRs #79 and #80 were closed unmerged and their remote branches deleted; the leaked originals (`c087560d`, `3dfc9595`) remain reachable through the PR refs — same class as the 2026-09-11 purge question the user decided NOT to pursue.

## 2. Tests / E2E / deploy result

| Check | Result |
|---|---|
| Four read-only Opus landing reviews, one per PR, run against the built integration branch | #77 LAND; #78/#79/#80 LAND-WITH-FIX. 1 Critical (live universe counts inside the Finnhub commit's source comments + fixtures), ~12 Important (weaker-than-reader Charts gate, unmasked note prose on the security hub, three drill-down affordance leftovers + a third allowlist copy, units→K rounding sibling, a false formatter contract comment, a not-scanned line hideable behind "+N more", a fix that answered an open product call), ~20 Minor → TODO |
| Privacy scan (test diffs + all 15 commit messages + the amended patch) | two messages sanitized, one commit re-amended, one pre-existing cash-flow fixture rebuilt synthetic; landed history clean |
| Fix wave | seven Sonnet fixers, one owner per file, no agent git writes, orchestrator committed by pathspec; one orphaned source pin updated by the orchestrator |
| `tsc --noEmit` | 20-error baseline only, none in changed files |
| Sandbox `:3090` (VACUUM copy, minted session, secret-free) + `npm run smoke` | 4/4 |
| Browser pass, 10 checks on the landed surfaces (Charts default, Today IBKR line incl. privacy, Diagnostics drill affordance both dimensions, Holdings singular unit, Alerts deep links ×3, security-hub note masking, notes composer date reset, Detected Strategies privacy, Finnhub refresh outcome, console) | 9/10 first pass; the Finnhub outcome failed on a pre-existing hole (skipped legs never reached the payload) → fixed in-wave (`69731c52`) → re-check PASS, 10/10 |
| Full suite on the integration tip (worktree) | 804 files, 9,688 passed, 3 skipped, 9 todo, 3 failed (3 failures in `tests/ai/generate.test.ts` are worktree-environment only — no `.env.local` there; the file passes 3/3 in the main checkout) |
| Full suite on main after landing (`verify.sh full --base main`) | 804 files, 9,692 passed, 9 todo, 0 failed, exit 0 (evidence 1789350107857-11b6c4e6) |
| `next build` on the tip | clean, 103 static pages, BUILD_ID cyx1-RqjEKje6c9iuhVAR (worktree build needed a migrated DB copy seated first — two build workers race to migrate a fresh worktree DB; not reproducible in the main checkout, recorded in memory) |
| Electron deploy through `npm run deploy` (`--commit fce2ddde`) | **DEPLOYED 21:44–21:50 ET** (second run — the first was stopped during its build step because the notarization exports had not been sourced; locks released by hand): locks taken, preflight all-ok incl. notarization creds, pack + `verify-bundle` OK (no leaks, runtime pieces present), notarization successful, installed BUILD_ID `vVbXXDPZSvNGb0LL1APdR` == built, codesign verified, new listener answered `/login`; log `.git/portfolio-desk-coord/logs/deploy-20260914T014441Z.log` |

## 3. Open concerns / rejected approaches / decisions for the user

- **Today IBKR line ≠ TWS daily P&L, accepted by the user (2026-09-14 evening):** after the JPY repair the line read a gain while TWS showed a flat day. Three definitional gaps, all by design: positions opened today get the whole prior-price-to-mark move (TWS counts from the fill); the prior price is the last sync mark, not the official close; the percent divides by prior-close gross exposure (this morning's ruling), TWS by net liquidation. The user's purpose for the line is intraday position watching on mobile without breaking the TWS API session, so no change is requested. If it should ever match TWS: measure today-opened positions from executions, anchor on the historical daily close, and show a net-liquidation percent.

- User rulings recorded in `docs/DECISIONS.md` (2026-09-13): shorts belong on the Today IBKR line with a gross-exposure day-percent denominator (closes the 2026-08-30 product call); Charts precedence refined to "largest held WITH cached daily priced bars"; portfolio-derived counts are leaks in messages, comments and fixtures alike; a fix answering an open product call is surfaced before landing; the concentration fix is landed as a partial (row universe still three-way split) — its ledger row stays for the sweep to re-verify.
- Follow-ups filed in TODO (qa-landing 2026-09-13, items a–m): concentration row-universe single-sourcing, four UTC-"today" components, TradeReviewView quantity nouns, short-row `today_pct` sign, Worker compact-rounding band, two weak pins, hand-rolled `formatDollar`/raw `fetch` in OptionsStrategies, Charts gate ignores bar age, bare-token 429 match, Cmd+K subtitle note prose, non-idempotent sync `newEvents`, sandbox AI-key 500 noise.
- Rejected: merging #79/#80 as-is (counts in messages); a fix commit on top of the leaky Finnhub commit (would leave the counts in history — re-amended at the tip instead); reclassifying skipped sync legs as errors (surfaced as a separate `skipped` list instead).

## 4. Uncommitted changes / live-process state

- Main checkout clean at the closing handoff commit on top of `0075c14a`, pushed; installed app build `eEKR4YpxMpJWel3ruFhrt`. Worktree `/Users/Yitzi/code/vanguard-skin-coord` on `claude/fx-derive-removal-2026-09-14` (fully landed; both session branches can be deleted). Nightly `../vanguard-skin-qa-fix` worktree untouched (detached at the old main).
- Sandbox `:3090` torn down; no locks held; register: `qa-landing-2026-09-13` landed; `qa-fix-20260912` / `qa-fix-20260913` review tasks closed as landed. Ledger: 15 rows flipped to `merged` with landed SHAs (backup `qa/findings/ledger.json.bak-2026-09-13-landed`).
- Remote: all four PR branches deleted — `qa-deep-fixes-2026-09-13` / `qa-auto-fixes-2026-09-13` (closed unmerged) and `qa-deep-fixes-2026-09-12` / `qa-auto-fixes-2026-09-12` (GitHub showed #77/#78 merged). No `qa-*` refs remain on origin or locally.

## 5. Claude session link

https://claude.ai/code/session_0116wA27Yp24hsxNA9TzMo7D
