# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.

**Session date:** 2026-09-02 — three threads picked at session start: (A) land the stranded nightly-QA output, (B) clear the pending QA decisions, (C) harden the nightly chain after its 6.5-hour probe hang.

## 1. Goal + exact files changed

Branch `land-2026-09-02` (sibling worktree; the fixer was mid-run in its own worktree and its delivery preflight requires a clean main checkout, so nothing touched main until both nightly processes exited).

**Landed (10 fixer/sweep commits + 4 from PR #61):** PR #60 `qa-auto-fixes-2026-09-01` (equity curve on the flow-adjusted seam-bridged index; week-ahead actual chip width; notes search matches tags; transcripts refresh explains a cache-hit no-op), `qa-deep-fixes-2026-09-01` (transcript modal above the chat rail; SQL LIKE-wildcard escaping in notes/research/transcripts search; print-watch panels refresh after promote), `qa-deep-fixes-2026-09-02` (print-watch verify table in ScrollFade; chart header strip shrink + ellipsize; canonical-CSV blank-symbol/blank-date drop warnings — protected import area, kept by user ruling, drop behaviour unchanged), PR #61 `qa-auto-fixes-2026-09-02` (suggested levels analyse the newest 500 bars; transcript list one best-source row per quarter; risk-drawer top-10 aggregated per security; drill-down keeps unpriced/short legs).

**Review + E2E fixes (mine):**
- `app/dashboard/components/MarketDataPanel.tsx` — the truncate refactor turned the three header pieces into inline text, losing the flex gap (rendered "NET· Cloudflare Inc· Stock"); `ml-3` per piece. Browser E2E then showed the phone strip still collapsed the name to zero width because the right group ("● live · as of …") is `shrink-0` and ~330px in a 350px strip: container is now `flex-wrap md:flex-nowrap gap-y-1`, so the stamp drops to a second line below `md` only.
- `app/dashboard/components/PerformanceView.tsx` — the curve fetched flows/seams for the whole scope id list while its valuation series is the single-account series when `accountId` is set; paired the flow scope to the series (equivalent today, drift-proof for a 2+-account scope).
- `lib/queries/transcripts.ts` — browser E2E after PR #61 showed the security-detail EARNINGS TRANSCRIPTS section still listing the 8-K cover page above the real call: `getTranscriptsForSecurity` is a third call site. Same `SOURCE_RANK_SQL` row-number dedupe, selecting by id so the row shape stays a plain `EarningsTranscript`. Test-first in `tests/queries/transcripts.test.ts`.
- Three hand-merged conflicts: tag search × LIKE-escape (`notes.ts`), LIKE-escape × best-source CTE (`transcripts.ts`, columns un-prefixed inside the CTE + `ESCAPE`).

**Chain hardening:** `qa/nightly-deep-qa.sh` (`probe_model`: 180s perl `alarm`+`exec` cap, `--tools ""`, PONG prompt; `bash -n` clean), `.claude/skills/qa-deep-sweep/SKILL.md` (re-verify list in the charter, `verdicts` in the agent JSON, Step 2 flips only on `gone`, suspect-flip rule), `.claude/skills/qa-fix-findings/SKILL.md` (anti-strand guard pushes + opens a sanitized PR for un-PR'd `qa-deep-fixes-*` branches).

**Docs:** `docs/plans/TODO.md` (landing entry, engine cash back-step item, chain hardening, decisions), `docs/DECISIONS.md` (two entries), this file.

## 2. Tests / E2E / deploy result

- Worktree full suite: green on every run — after the three merges (7,263), after PR #61 (7,273), and after the two E2E fixes (7,276). Three `tests/ai/generate.test.ts` failures on the very first run were the worktree's missing `.env.local`, not code; a dummy `ANTHROPIC_API_KEY` reproduces main's environment.
- Browser E2E on a secretless `:3095` dev server from the worktree (DB copy, minted session, `DATABASE_PATH` + `APP_EXTRA_HOSTS`): 10 checks, 8 passed first time, the 2 failures above were fixed and re-verified. Notable pass evidence: the equity curve endpoint sits within two index points of 100 + YTD TWR (was ~35 points high); suggested levels report `barsAnalyzed: 500` with a resistance above spot; `20%` search returns 4 literal matches, not every note; six actual chips all 33px inside their day column; risk drawer 10 distinct symbols.
- E2E also surfaced two things now in the ledger: a sibling overflow (the week-ahead reaction line spills past its card, low, auto-fixable) and a dollar gap on the drill-down (panel rows sum below the breakdown row — look-through ETF slices absent), attached to the decided drill-down item as a test requirement.
- Deploy: user-approved after E2E (gated per DECISIONS 2026-08-28). `npm run electron:deploy` at 14:45 ET — Next build ~9 min, signing + notarization successful, `verify-bundle: OK (no leaks, runtime pieces present)`, installed to /Applications and relaunched 14:57 ET; `/login` 200 on :3099 and the first TWS auto-refresh synced positions on relaunch. Three `Failed to copy traced files … .git/refs/heads/<branch> ENOENT` warnings were self-inflicted (branch/worktree cleanup ran concurrently with the build; the routes are present in the bundle) — filed in TODO, rule added to CLAUDE.md.

## 3. Open concerns / rejected approaches / decisions

- **14 QA decisions recorded** (`decision_resolved: 2026-09-02`; DECISIONS-PENDING cleared). User rulings: scenario-engine subject-exposure redesign goes to the fixer as PR-only (Option 2 + floor semantics); equity-curve base day = display floor now + engine back-step item (root-caused: `daily-valuation.ts` Phase 2 skips anchors without a priced daily row in tolerance, so the first two taxable-account days before the first resolvable anchor keep `cash_balance 0`); print-watch un-accept re-derives via the reconciler + per-candidate accept, PR-only; IBKR corrupt monthly TWR = derivation bug + writer guard + USER-RUN repair; fix-date delete offers "remove and restore vendor date" + USER-RUN suppression lift. The drill-down units item (fixer-filed mid-session) was accepted on the fixer's recommendation with a user-veto flag in the session summary.
- **Rejected:** `--bare` for the probe (drops OAuth → "Not logged in"); `flex-wrap` unconditionally on the header strip (would wrap the desktop strip at 1280 with the rail open); a `getTranscriptsForSecurity` partition by `security_id` only (kept parity with the list's `(ticker, year, quarter)` rule).
- **Process finding (Codex may want to weigh in):** the 08-31 sweep flipped 14 ledger entries to `fixed` on absence; 10 were still broken. The skill now requires explicit verdicts. Also: the fixer's own browser verification is thin — the header-strip fix was "verified by CSS semantics + source tests" and never rendered; the E2E pass here caught it. Worth making a rendered check mandatory for any `auto_fixable` layout fix.

## 4. Uncommitted changes / live-process state (post-deploy)

- Main pushed through this handoff commit (`ac66c99..` this session, 25+ commits); PRs #60 and #61 read MERGED on GitHub. Landing worktree removed and the five merged local branches deleted; `qa-fix-work-20260901` (content-duplicate of PR #60, needs -D) and the two remote PR branches left by user choice; the fixer's `../vanguard-skin-qa-fix` worktree remains (detached HEAD, its own). The `:3095` E2E server is killed and the DB copy deleted. Live app = the 14:57 ET build.
- Two `@playwright/mcp --isolated` processes from a still-running interactive Claude session dated 2026-09-01 15:14 were left alone (their parent is alive).
- No August statements have arrived yet; the reconciler live-watch (TODO) and the first statement-over-tombstone exercise wait for them.

## 5. Claude session link

https://claude.ai/code/session_01NAVMJQNmm4GzTCf2z5Q2fH
