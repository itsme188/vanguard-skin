**Waiting on:** USER: (1) on the next trading day (2026-11-27) check that the 07:30 Plaid line reads `OK`, `dating=2` and the expected session (`~/Library/Logs` Plaid sync log or the Accounts sync message); (2) sign in once and look at Today, Accounts and Analysis (after the live repair they were checked through their readers only). CLAUDE (next session): regenerate the stored Analysis narratives, which read as drifted after the repair (owner-approved in plan v4 section E, about 20 paid calls). Carried over: the open `decision` records in the register (`npm run inbox`).

# Session Handoff — for Codex review

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.

Session: 2026-11-26, Plaid session dating: plan v4, build, landing, deploy and the live history repair. Agents: Claude (Opus 5.5 as controller, planner and reviewer; Opus 5.5 subagents built the units with one owner per file). Codex reviewed plan v4 read-only (round 4, REVISE folded).

## 1. Goal and files changed

Goal: a Plaid read taken before the open describes the previous trading session, but every row it wrote was dated on the run day, so Vanguard history ran one session late (risk figures correlated with the prior day's market, trades appeared a day late). Fix the dating going forward and repair the stored history.

Landed on `main` as `0ddf0925` (fast-forward), deployed the same evening:

- Rule and settings: `lib/plaid/session-dating.ts` (new: store window 07:30 to 09:30 Eastern on trading days, `plaidSessionDate`, the dating boundary settings, fresh / legacy / mixed / repaired states, repeat-read check).
- Sync: `lib/plaid/refresh.ts`, `lib/plaid/map-holdings.ts`, `app/api/cron/plaid-sync/route.ts`, `app/api/plaid/sync/route.ts` (now `{success, data}`), `scripts/run-plaid-sync.sh`; sync words in `lib/ui/plaid-sync-message.ts` (new), `app/dashboard/components/PlaidSyncButton.tsx`, `PlaidSection.tsx`, `app/dashboard/plaid-link/page.tsx`.
- Readers: `lib/db/live-sources.ts` (`currentValueLiveSnapshotSql`, TWS only), `lib/queries/dashboard.ts`, `lib/queries/account-cash-line.ts`, `lib/queries/data-confidence.ts`, `app/dashboard/today/page.tsx` and `basis-labels.ts` (per-account caption), `lib/queries/positions-freshness.ts`, `lib/queries/analysis-trust-state.ts`, `lib/ui/positions-freshness-label.ts`, `TrustStrip.tsx`, `TrustStripDrawer.tsx`.
- Risk: `lib/compute/flow-adjusted.ts` (go-live dates), `lib/compute/risk.ts` (dated fold intervals), `lib/compute/factors.ts`, `lib/compute/period-attribution.ts` (beta regression only).
- Repair and audit: `lib/repair/plaid-session-dating-plan.ts`, `lib/repair/plaid-session-dating-audit.ts`, `scripts/repair-plaid-session-dating.ts`, `scripts/audit-plaid-session-dating.ts`; sandbox-only `scripts/sandbox-plaid-fake-sync.ts`.
- Tests: 19 new files, 21 existing files updated (synthetic fixtures only).
- Docs: `CLAUDE.md` (the Plaid rule), `docs/DECISIONS.md` (2026-11-26 entry), `docs/plans/TODO.md` (X3, A1 and follow-ups), this file.

No migration, no schema change, no new dependency, no Worker change.

## 2. Checks run and results

- `bash scripts/verify.sh full --base main`: passed on `0ddf0925` in the worktree (1,894 files, 23,455 tests, 0 failed), before and after `main` moved; type check and `next build` clean.
- Rehearsal on a backup copy: dry run with no blocking case, apply, all seven audit gates pass, every repaired zero row in place; sandbox browser pass on the repaired copy (Today, Accounts, Analysis); the fake-sync script's four outcomes plus the after-open and closed-day skips.
- Deploy: `npm run deploy` from `0ddf0925`, notarized, bundle gate ok, build id matches on both sides, codesign verified, fresh listener on :3099.
- Live window (owner go-ahead "get all the way to live"): app quit; the live dry run matched the rehearsal's plan exactly (no difference, no blocking case, no tax-input change); apply passed its own proof and `integrity_check`; audit gates G1 to G7 and the closure check all PASS against the pre-apply backup; the Today caption, freshness and trust-strip readers report the repaired state. Not done: a signed-in browser look (the app needs the owner's password).

## 3. Open concerns, rejected approaches, user decisions

- Owner rulings (2026-11-26): move the pre-open books and drop the four listed special cases; shift each fund price one session; defer U5 (statement-import zero rows). Planner decisions are listed in the `docs/DECISIONS.md` entry.
- Two idle SQLite helper processes from Claude sessions held the live database open; the apply refuses while anything does, so both were stopped by PID after checking no session was running a turn. Recorded in auto-memory.
- At the owner's request the three rehearsal databases were copied to the main checkout's gitignored `data/plaid-session-dating-rehearsal/` under distinct names (an exception to the rule against database copies under `data/`; the live `data/vanguard.db` was not touched).
- Period attribution's alpha carries the go-live step for any period containing it (by design: only the beta regression drops that session).
- Follow-ups in TODO (A1): the benchmark comparison card is not flow-adjusted; Plaid's quantity on two taxable funds differs from the statement at every month-end (OPEN-4 evidence); the Accounts cash note still says "live-snapshot" for a Vanguard account.
- OPEN-7: after an undo or restore of a Plaid-era Vanguard statement batch, run the audit's `--check-repair-closures` (and the repair's `--remint-closures` if a zero is missing).

## 4. Uncommitted changes and live-process state

- `main` == `origin/main` after this handoff commit; no uncommitted changes in either checkout.
- Installed app: build of `0ddf0925`, running on :3099 against the repaired live database (dating version 2).
- Worktrees: `.claude/worktrees/session-start-8163ca` (branch `plaid-session-dating`, fully merged; its gitignored private files were copied to the main checkout, so it can be removed) and `../vanguard-skin-qa-fix` (detached, the nightly fixer's).
- No dev server or sandbox running; no locks held. Open PRs are the nightly QA ones (none from this session).

## 5. Agent identity and session link

Claude (Opus 5.5) in the Claude desktop app, Code tab, local session in worktree `session-start-8163ca`; no claude.ai session link for this session.
