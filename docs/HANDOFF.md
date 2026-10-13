# Session Handoff — for Codex review

**Waiting on:** USER (each is a `decision` record in the coordination register; `npm run inbox` lists them): `broker-realized-gain-reports`, `tax-preparer-short-term-gift`. (The GitHub Support request was sent by the owner late on 2026-10-12 through GitHub's support assistant; its record is closed. The ticket is open: once GitHub confirms, check that an old commit link answers 404.) CODEX: nothing assigned; a review of section 3 is welcome. CLAUDE: nothing.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.
> **Commit ids:** history was rewritten on 2026-10-06, so every commit id written in docs before that date is an old id. A private old-to-new map is in gitignored `docs/private/`.

**Session date:** 2026-10-12, evening, Eastern time. Interactive, with the owner present throughout.

## 0. State at the end

- `main` holds everything from this session and is pushed.
- **Deployed:** nothing new. This session changed docs, project instructions and two tests, so the installed app (built from `094e3e37`) is current.
- **Open pull requests:** none.
- **Live database:** two owner-approved writes, each behind its own backup in `data/backups/` (section 3).
- **Coordination register:** two `decision` records remain, all waiting on the owner outside the app. No locks held.

## 1. Goal + what changed

**Goal:** clear the decision queue. Every open `decision` record and the four QA questions left unruled that afternoon were put to the owner one at a time; each ruling was recorded, and the actions the owner approved were done.

Files changed (commits `432a7883`, `78d94daa`, `2ee64f61`, `2e35c77b`, then the closeout commits):
- `docs/DECISIONS.md`: one entry, 2026-10-12 (evening), items 1 to 14.
- `docs/plans/TODO.md`: rulings marked, builds owed listed, one new follow-up (h).
- `CLAUDE.md`: the bar-volume rule replaces the "no established unit" note; one testing rule added.
- `docs/reference/conventions-detail.md`: the gift-month paragraph (June restated; a gift the fund sends back is not a gift).
- `tests/chart/narrate-levels.test.ts`, `tests/digest/daily-digest.test.ts`: "today" now comes from `todayET()`.

No file under `app/`, `lib/`, `workers/`, `electron/` or `scripts/` changed.

## 2. Tests / E2E / deploy

| Check | Result |
|---|---|
| Full suite at the final commit, `bash scripts/verify.sh full --base main` | 17,251 passed, 0 failed |
| First run that evening | 2 failed; both were tests that stamped the UTC day while the code uses the Eastern day, run after 20:00 Eastern. One fix attempt, passed. |
| Browser pass | not run: no user-facing code changed |
| Deploy | skipped: docs and tests only |

## 3. Open concerns, rejected approaches, user decisions

**What Codex should scrutinize first:**
- **Bar-volume unit (settled by measurement, design still owed).** A read-only daily-bar request to TWS on a spare client id showed stored volume is in round lots, and the lot size differs by security: the broker's share figure was exactly one multiple for some names and exactly another for others, and TWS applies today's lot size to the whole history. The price-tier explanation is an inference, not documented. Not checked: which broker field carries the lot size; options and non-US names. The rule in `CLAUDE.md` forbids a fixed multiplier and forbids guessing from price. One side finding: a stored daily bar captured before the close stays short of the final figure.
- **June 2026 restatement (live write).** One `monthly_snapshots` row: its stored return and investment gain were rewritten under the gift-month convention the owner confirmed (deposits stay cash-only; gifts are dated outflows in a Modified Dietz return). Rehearsed on a copy first; the ledger-based cross-check for that month moved from "investigate" to inside the consistent band, and no other month's pair changed. Evidence is in gitignored `docs/private/june-2026-restate/`.
- **A gift the fund refused.** The owner corrected an assumption mid-session: one option position was sent to the donor fund and sent back weeks later, so it is not a gift. It has no donation record, and its out and in legs stay in the months they happened. The restatement excludes it.
- **Two donated lots marked basis-verified (live write)** through the app's own route with a minted session, revoked after. The marker changes no tax input.
- **Closed-day rows, traced read-only.** `lib/tws/positions.ts` and `lib/tws/streaming.ts` stamp the Eastern day with no market-calendar check; the Plaid and Web API writers do check. What the TWS sync should stamp on a closed day is NOT ruled. Two loose ends are untraced (a weekend price row from another source for one security; one weekday with no fallback rows).

**Rulings recorded, build owed (none built this session):** the import error names the files already written; the level-create question focuses Cancel first; the sector donut uses the gross long book with a caption for the short book; the sector-weights fetch stays manual; the "Moderate" crypto tag keeps half the shock. The gift-month convention, the builder's earlier calls and the phone chat layout were confirmed as built.

**Rejected or not done, with the reason:**
- Any fixed volume multiplier: the measurement rules it out.
- Sending the GitHub Support request myself: outward-facing, so it was drafted, and the owner sent it after the session close. The request removes the old commit references and leaves the pull requests in place.
- The crypto-fund lot backfill: it belongs to another session; the owner said to leave it there.
- Deleting stale `qa-*` branches: all are landed by patch, but deletion was not asked for.
- The third same-shape UTC cut in `tests/digest/daily-digest.test.ts` (a "yesterday" helper): left untouched, listed as TODO (h).

## 4. Uncommitted changes and live-process state

- **Main checkout:** clean after this commit; `main` equals `origin/main`.
- **Worktrees:** `/Users/Yitzi/code/vanguard-skin-qa-fix` is the nightly fixer's and stays. `.claude/worktrees/coin-transaction-details-5329fd` belongs to another session and was left alone.
- **Processes:** no sandbox or dev server from this session. The installed app runs the build from `094e3e37`.
- **Backups:** two new files from this evening in gitignored `data/backups/`.
- **Session-local files:** the TWS request scripts are in the session scratch folder outside the repo; evidence with real figures is in gitignored `docs/private/`.
- **To check tomorrow:** whether `qa/findings/fix-runs/2026-10-13.md` exists (first proof the nightly fixer survives its suite run).

## 5. Agent

Claude Code (Claude Opus 5.5, 1M context) — https://claude.ai/code/session_01ABdui9AGJG1AGrYs8XKHnr
