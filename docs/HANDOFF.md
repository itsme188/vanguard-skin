# Session Handoff — for Codex review

**Waiting on:** USER (each is a `decision` record in the coordination register; `npm run inbox` lists them): `rule-landing-followups-2026-10-12` (two small rulings from this landing), `bar-volume-unit-open` (allow a live TWS request to settle the bar-volume unit), and, carried from before, `broker-realized-gain-reports`, `confirm-builder-rulings-2026-10-07`, `confirm-gift-month-convention`, `confirm-phone-chat-layout`, `github-support-history-purge`, `giving-mark-lots-verified`, `tax-preparer-short-term-gift`. CODEX: nothing assigned; a review of section 3 is welcome. CLAUDE: nothing.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.
> **Commit ids:** history was rewritten on 2026-10-06, so every commit id written in docs before that date is an old id. A private old-to-new map is in gitignored `docs/private/`.

**Session date:** 2026-10-12, afternoon, Eastern time. Interactive, with the owner present throughout.

## 0. State at the end

- `main` holds everything from this session and is pushed.
- **Deployed:** Worker and Mac app from `094e3e37` (Worker first). The commits after it change a script, tests, docs and agent instructions only, so the installed build is current for everything the app runs.
- **Open pull requests:** none. PR #110 merged; PR #111 closed unmerged (its commits landed as cherry-picks).
- **Live database:** four repairs were applied, each rehearsed on a copy and each behind its own backup in `data/backups/` (section 3 has the detail and one unapproved write).
- **QA ledger (gitignored, local):** nine rows stamped merged; 33 rows stamped with the owner's rulings; one closed. Five findings still need a decision.

## 1. Goal + what changed

**Goal:** land the nightly fixer's waiting work, then rule on the pending QA decisions.

**Landed (11 nightly fixes, then 6 review fixes).** PR #110 by merge; the nine commits of PR #111 and one fixer commit that never got a PR by cherry-pick, because one commit subject carried a live figure in its finding tag (reworded; code unchanged).

Files changed by the landing:
- Levels: `app/api/levels/route.ts`, `lib/levels/create-level.ts`, `lib/levels/create-level-prompt.ts`, `app/dashboard/components/LevelsPanel.tsx`, `app/dashboard/components/AddLevelPopover.tsx`
- Security page: `lib/queries/security-detail.ts`, `app/dashboard/components/TransactionsSection.tsx`, `app/dashboard/components/MarketDataPanel.tsx`, `app/dashboard/security/[id]/page.tsx`
- Import: `app/api/import/route.ts`, `lib/import/parsers/canonical-csv.ts`
- Calendar: `lib/calendar/sync.ts`
- Today: `lib/queries/today-holdings.ts`
- Analysis: `app/dashboard/components/analysis/DrillDownPanel.tsx`
- Digest, both sides: `lib/digest/overnight.ts`, `workers/cron/src/overnight.ts`
- Tests: eleven new or changed files under `tests/api`, `tests/calendar`, `tests/dashboard`, `tests/import`, `tests/queries`, and `workers/cron/test/overnight.test.ts`

After the landing:
- `scripts/repair-etf-types.ts` reads `REPAIR_DB_PATH` and prints its database path; `tests/repo/repair-scripts-rehearsable.test.ts` is new.
- `.claude/skills/qa-fix-findings/SKILL.md`: the suite gate runs in the foreground.
- `CLAUDE.md`, `docs/DECISIONS.md` (three entries dated 2026-10-12), `docs/plans/TODO.md`.

**Rulings.** The owner ruled on 35 of the 37 findings in `qa/findings/DECISIONS-PENDING.md`; the list is in `docs/DECISIONS.md`, 2026-10-12 (afternoon). Twenty are code or wording only; thirteen have a code half for the fixer and a repair half the owner runs.

## 2. Tests / E2E / deploy

| Check | Result |
|---|---|
| Full suite, final commit, `bash scripts/verify.sh full --base main` | 17,251 passed, 0 failed (16,762 at the last handoff) |
| Worker suite | 1,022 passed |
| Type-check, Mac and Worker; production build | clean |
| Reviews that ran the code | three, read-only, before any merge; no critical finding; every "fix before landing" item fixed |
| Browser, sandbox copy | smoke 4 of 4; a pass at desktop and phone width: transaction counts matched SQL per account, the phone hero, the level questions on the form and the chart click, the drill-down sort, the Today page, an import preview warning |
| Deploy | Worker deployed, then the Mac app through the wrapper: build id matches, signature verified, login page answers |

**Not seen in a browser:** the suggested-level Accept question (no on-screen suggestion was already crossed) and the digest Overnight scoreboard (it is behind a paid AI call). Both are covered by tests only.

## 3. Open concerns, rejected approaches, user decisions

**What Codex should scrutinize first:**
- **The create arm guard** (`lib/levels/create-level.ts`): a trial write inside a transaction, then the shared `evaluateArmGuard`. The owner ruled that an out-of-range create now asks first, which reverses an older note in the route. The plain PATCH fallback in the levels route still writes unguarded, and POST accepts any `review_status` from the body (to-do list).
- **The import route** (protected area): the per-file catch added by the fixer is limited to previews by one rethrow line. Commit behaves as it did before. Whitespace-ignored diff against the prior version: 35 lines added, 0 removed.
- **Transaction totals** (`lib/queries/security-detail.ts`): the list readers and every count now share two SQL fragments; the stock-or-option split exists once in SQL and once in the client component, held together by a parity test.
- **The day-move fix** (`lib/queries/today-holdings.ts`): the cost of a name opened in the measured session comes from that session's book. A missing session cost is left out and counted, never borrowed from a later row (owner confirmed).
- **Live repairs.** The lot repair added one import-mode corporate action for a statement split that had arrived as a plain transaction row, then recomputed. Per-lot and per-sale digests show a no-change recompute is identical to the live book, and that the repair moved only the affected lots, with cost basis conserved.

**One unapproved live write, reported to the owner at once.** During a rehearsal, `scripts/repair-etf-types.ts --apply` wrote one field of one row to the live database: the script hardcoded the live path and never read the override that was set. The value was correct and the script had taken a backup. The owner chose to keep it. The guard is described in section 1.

**Rejected or not built, with the reason:**
- Scaling stored bar volume by 100: the evidence does not support any fixed multiplier (IBKR's own connector and a public source disagree with each other and with that reading). Held for a live TWS check.
- Keeping per-file isolation at import commit with a new done-screen: the owner chose the smaller change.
- The fixer's first phone-hero layout (price stacked under the symbol for every security): the owner chose the narrow fix.
- Giving every older repair script the database override now: twenty one-off scripts, not asked for; listed in the new test.

**Held for the owner:** the pending-lots design (its own session); nine repairs that wait for their code half; the questions in the two new decision records.

**The nightly fixer** died three nights running because it started the suite in the background and ended its turn. The skill now forbids that. First proof is whether `qa/findings/fix-runs/2026-10-13.md` exists after tonight's run.

## 4. Uncommitted changes and live-process state

- **Main checkout:** clean after this commit; `main` equals `origin/main`.
- **Worktrees:** `/Users/Yitzi/code/vanguard-skin-qa-fix` is the nightly fixer's and stays, with its scratch branches. A second worktree appeared late in the session, `.claude/worktrees/coin-transaction-details-5329fd` (clean, at this session's tip, created by another session, not registered in the coordination register). It was left alone.
- **Processes:** no sandbox or dev server is running. The installed app runs the build from `094e3e37`.
- **Coordination register:** `qa-landing-2026-10-12` is landed; no locks are held.
- **Backups:** five files from today in gitignored `data/backups/`. The rehearsal copies in the session's scratch folder are deleted.
- **Session-local files:** review reports and browser screenshots (which show real figures) are in scratch folders outside the repo, or in gitignored `.playwright-mcp/`.

## 5. Agent

Claude Code (Claude Opus 5.5, 1M context) — https://claude.ai/code/session_01ABdui9AGJG1AGrYs8XKHnr
