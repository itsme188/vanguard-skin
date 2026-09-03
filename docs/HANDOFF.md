# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-09-03 morning (09:00 → ~11:00 ET). Focus: session-start sweep → land the nightly fixer's two QA branches behind independent landing reviews, deploy before tonight's first live print on slice A (ZS, 16:05 ET), plus four quick items surfaced by the sweep.

## 1. Goal + exact files changed

Commits on `main` this session (pushed through `ba4ce31`; the handoff commit follows):

- `be38662` **fix(ops)** — `qa/run-qa.sh` (the 2 AM smoke) minted its QA session by absolute script path from launchd's cwd, so tsx never resolved the `@/` alias inside `lib/mutations/sessions.ts`; every night from at least 08-31 the smoke ran zero authenticated checks. Both the mint and the revoke trap now run inside `(cd "$PROJECT_DIR" && …)`. `scripts/run-snapshot.sh` moved its isolated npm cache from `$TMPDIR` (macOS purges idle entries after three days — the 02:01 beta refresh died on an npm ENOENT) to `~/Library/Caches/vanguard-skin-npm-cache`.
- `2597b14` **merge PR #62** `qa-deep-fixes-2026-09-03` (10 sweep auto-fixes, 20 files) + `588e206` **fix(ui)** from the landing review: `displayCashEffect` extracted to `lib/format/cash-effect.ts`; `TransactionHistory.tsx` (Accounts tab) renders the Amount cell through it (the branch had left it on the raw sign, so one row showed opposite signs on two tabs); `TransactionsSection.tsx` sorts the Amount column on the displayed value via the new exported `sortSecurityTransactions` (the branch sorted on the raw amount while printing the normalized sign); all three `warnings.map` lists in `ImportFlow.tsx` render inside `<PrivateText>` (the new non-numeric warnings embed raw CSV figures); `getFilteredArticleCount` doc comment corrected. Four pinning tests under `tests/dashboard/`.
- `bf660d5` **merge PR #63** `qa-auto-fixes-2026-09-03` (the fixer's 4 HIGH fixes re-cut on the slice-A-merged base; byte-identical to the local `qa-fix-work-20260903`) + `a2e9dac` **fix(print-watch)** from the landing review: `divergentCandidates` (promote gate, `app/api/print-watch/accept/route.ts`) and `needsReverify` (`app/dashboard/today/PrintWatchPanel.tsx`) ignore candidates from the accepted document or earlier once `line.source_doc_id` is set — the same strictly-later rule `candidateSupersessionDetail` already used; `checkUserReleaseTimeAgainstUpcomingSlot` (`lib/earnings/wire-times.ts`) evaluates every row on the nearest `event_date` instead of an untied `LIMIT 1`; `clearLineAccepted` (`lib/print-watch/store.ts`) falls back to release-only when `contract_json` names a different metric or reconcile lands on an empty pool. Tests in `tests/api/print-watch-accept.test.ts`, `tests/dashboard/print-watch-panel.test.ts`, `tests/earnings/wire-times.test.ts`, `tests/print-watch/store.test.ts`.
- `ba4ce31` **chore** — `docs/plans/TODO.md` reconciled (closed block + five landing-review leftovers filed).

Live-data actions (no code): 14 `earnings_worksheet_flags` rows for 08-05/08-06 prints deleted by hand (out of the R23 horizon; the next sweep tick minted NO generation — the correct D10 no-op); DELL's stale Finnhub row moved to 2026-09-01 AMC through `POST /api/earnings/correct-date` after EDGAR (8-K Item 2.02 accepted 2026-09-01 16:10 ET) confirmed the date — new manual row, old row deleted, two bogeys migrated, no generation minted (unarmed).

## 2. Tests / E2E / deploy result

- Both branches reviewed READ-ONLY by two independent model reviewers before merge; every finding verified by me against the branch source before a fix was written. 4 confirmed defects in 14 fixer commits, 2 latent, 1 cosmetic (filed).
- Fixes written test-first by two coders on disjoint files in one checkout (pathspec commits); each reported the failing-then-passing run.
- `tsc --noEmit`: 20 errors, all in the four pre-existing baseline test files, none in touched code.
- Full suite at `a2e9dac`: 647 files / **7,644 passed** / 9 todo / 0 failed, 68.6 s — no `watcher.test.ts` flake this run.
- Smoke-mint fix: reproduced from `cd /` (`Cannot find module '@/lib/queries/sessions'`), then the new command shape minted `VGS_SESSION`/`VGS_CSRF` from the same cwd and `--revoke` cleaned up. Snapshot cache: `npx -y tsx --version` resolves through the new path (22 MB populated).
- Slice A post-deploy checks left open by the previous handoff: Worker `GET /internal/armed-events` returns generation 1 with 7 live entries, identical to the Mac's outbox payload (RBRK is absent on both sides — its flag points at SUPERSEDED row 1510, an orphan; filed). The plan's [C-18] supervised arm was effectively performed by the live ZS arm: `earnings_bogey_scans` fills 8 model calls per sweep tick (`pending — budget reached; resume next tick` between ticks is the R22 pacing, not a stall), `research_articles.bogeys_scanned_at` untouched, issue-dated newsletter labels present, 6 ZS bogeys by 09:25 ET.
- **Deploy:** `git push origin main` → `ba4ce31`; PRs #62 and #63 show MERGED. Electron chain (started ~10:33 ET): Next build compiled, Developer ID signing, **notarization successful**, DMG built, `verify-bundle: OK (no leaks, runtime pieces present)`, installed to `/Applications` at 10:41 ET and relaunched; `/login` → 200; the relaunched app ran its TWS auto-refresh at 10:42 ET (11 positions) and re-armed the ZS watcher (print 9588 `scheduled`, row touched 10:41:33 ET).

## 3. Open concerns / rejected approaches / decisions

- **The cash-effect sign fix is a display-layer normalization.** The stored inconsistency (pre-2026-04 canonical BUY rows positive, later rows signed) is the real defect, and the durable fix is the data-layer option in the pending QA decision `import-csv-guide--negative-buy-instruction-vs-legacy-positive-rows-sign-baked-into-source-key`. Landed the shim anyway because it is single-sourced, applied on both surfaces, and sort-consistent; rule on the data repair before adding more consumers.
- **Rejected:** dropping `8252f4d` (the sign commit) from the landing — the remaining nine commits were independent, but the user-visible inconsistency it fixes is real and the shim does not preclude the repair.
- **The TODO's "watch a sweep tick mint the reconciled generation" after the disarm was wrong** — R23 had already excluded those events, so the projection was unchanged and D10 correctly wrote nothing. Corrected in the TODO.
- **Human routes need `Origin` on unsafe methods:** a minted session + CSRF cookie/header still gets `401 unauthorized` from the proxy without `Origin: http://127.0.0.1:3099`. Recorded in memory; the QA sandbox scripts already send it.
- **Smoke log oddities not investigated:** `WARNING: claude CLI not found — auto-fix will be skipped`, and two `=== Nightly QA` headers per night since 09-01. Filed in the TODO leftovers.
- **Branch cleanup deferred to the user:** the fixer's local `qa-fix-work-20260903` (4 commits, content landed via PR #63's re-cut, so `git branch -d` refuses; needs `-D`) and the two merged remote branches `qa-deep-fixes-2026-09-03` / `qa-auto-fixes-2026-09-03` still exist. Branch deletes require explicit confirmation.
- **Tonight's live watch (first slice A print):** ZS armed, print 9588 `scheduled` for 16:05 ET, expected lines present. Things to watch: the acquire lane (DJ / EDGAR / RSS), dual-parse, the verify sheet, whether a conflict row exercises the new per-candidate accept path, and TODO 69 (an armed read-through name now takes the recap road).

## 4. Uncommitted changes / live-process state

- Main checkout: clean apart from this handoff at write time; `origin/main` at `ba4ce31`. No feature worktrees. The nightly fixer's `../vanguard-skin-qa-fix` worktree is back on `main` (the fixer returns it there); the nightly chain (`com.vanguard-skin.nightly-deep-qa`) exited by 09:13 ET — no sandbox servers, no stray Chrome/Playwright.
- Live: Cloudflare Worker version `4c6981a8` (unchanged — neither PR touched `workers/`); KV `armed-events` generation 1; nightly 02:00 snapshot uploaded as v10 (main was pre-merge at 02:00; tonight's is the first nightly v11). Electron app: see the deploy amendment below.
- Electron app `/Applications/Vanguard Dashboard.app` = this session's build (10:41 ET, `:3099`, `a2e9dac` + `ba4ce31` content); no migrations shipped this session. ZS print 9588 `scheduled` for 16:05 ET; outbox still at generation 1 (nothing this session changed the armed projection).

## 5. Claude session link

https://claude.ai/code/session_01EUZEo7j8kKbAFm3smUoVq3
