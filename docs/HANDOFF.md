# Session Handoff — for Codex review

**Waiting on:** USER (each is also a `decision` record in the coordination register): `merge-pr-101-and-deploy` (merge the three stacked pull requests in order, then deploy; steps in section 0); `small-repairs-after-sprint-merge` (run three rehearsed repairs after the merge, with a backup first; commands in section 0); the numbered owner questions in section 3. Carried from before the sprint and still open: `giving-mark-lots-verified`, `broker-realized-gain-reports`, `tax-preparer-short-term-gift`, `confirm-gift-month-convention`, `confirm-builder-rulings-2026-10-07`, `github-support-history-purge`. CODEX: nothing assigned; a review of the three pull requests is welcome, especially the items in section 3. CLAUDE: nothing until the owner merges.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.
> **Commit ids:** history was rewritten on 2026-10-06, so every commit id written in docs before that date is an old id. A private old-to-new map is in gitignored `docs/private/`.

**Session dates:** 2026-10-07 evening into the night (about 19:00 to 23:30 Eastern time). An unattended sprint: Claude orchestrated, Claude sub-agents and Codex built, each side reviewed the other. The owner gave standing authority at the start (quoted in `docs/DECISIONS.md`, 2026-10-07 evening) and was not present after that.

## 0. State right now, and the owner's steps in order

**Three stacked pull requests (PRs) are open. None is merged. Nothing is deployed, neither the Cloudflare Worker nor the Mac app. `main` is untouched at `2daccfef`.**

| PR | Branch | Base | Commits | QA findings |
|---|---|---|---|---|
| #101 | `claude/land1-2026-10-07` | `main` | 76 | about 300 |
| #102 | `claude/land2-2026-10-07` | the #101 branch | 26 | 53 |
| #103 | `claude/land3-2026-10-07` | the #102 branch | 10 | 11 |

**Why they are not merged:** the permission system blocked Claude from merging to `main` and from writing to the live database. Both are owner actions. Do not route around the block (no piecemeal merge, no merge through another tool).

**Owner steps, in this order:**

1. **Merge #101, then #102, then #103.** They are stacked; this order keeps each diff clean.
2. **Deploy the Worker FIRST:** `cd workers/cron && npx wrangler deploy`. The Worker must be able to read the two new payload lists before the Mac sends them.
3. **Deploy the Mac app:** `npm run deploy` from the main checkout. No deploy between 01:30 and 04:30 Eastern time; the nightly QA chain runs then.
4. **Turn the nightly fixer back on:** in `qa/deep-qa-config.json` set `fixer.enabled` back to `true`, and commit it. The pause was committed on the sprint branches only (`49af56e1`), so the merge brings the pause to `main`. It was never on `main` during the night, so the fixer may have run on the night of the sprint.
5. **Run the three rehearsed repairs,** from the repo root of the main checkout, backup first:

   ```
   sqlite3 data/vanguard.db "VACUUM INTO 'data/vanguard-pre-small-repairs.db'"
   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-empty-bogeys.ts --apply
   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-zero-ohlcv-bars.ts --apply --acknowledge-repair
   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/repair-duplicate-research-documents.ts --apply
   ```

   What each does: removes stored bogey rows whose every field is empty; removes stored daily bars the write guard would reject today; removes one duplicate research document and keeps the copy other records point at. Each was rehearsed on a copy of the live database: apply, then an identical second run changed nothing, and the integrity check passed. Run each without `--apply` first to read its dry-run report.
6. **Clean up worktrees and branches,** only after the merge and the deploy have finished:
   - `git worktree remove /Users/Yitzi/code/vanguard-skin-sprint` (branch `claude/sprint-2026-10-07`)
   - `git worktree remove /Users/Yitzi/code/vanguard-skin-sprint-verify` (detached)
   - `git worktree remove /Users/Yitzi/code/vanguard-skin-land1` (branch `claude/land1-2026-10-07`)
   - `git branch -d` for `claude/sprint-2026-10-07`, `claude/land1-2026-10-07`, `claude/land2-2026-10-07`, `claude/land3-2026-10-07`
   - **Leave `/Users/Yitzi/code/vanguard-skin-qa-fix` alone.** It is the nightly fixer's worktree.
   - Archive anything wanted from a worktree before removing it. Do not run this cleanup while a deploy is building.

**Three more new scripts are report-only for now.** Do not apply them without a decision:

- `scripts/repair-manual-feed-earnings-pairs.ts`: its dry run found one old pair. Applying it changes which of two rows is canonical for that print.
- `scripts/repair-stranded-earnings-suppressions.ts`: found nothing stranded.
- `scripts/retire-expired-option-holdings.ts`: found nothing to retire. It needs two flags to write.

## 1. Goal + exact files changed

**Goal (the owner's words, shortened):** get the app back to par. Fix and close as many backlog findings as possible; start with what needs no decision, then take the recommended option on what does; get a second opinion from Codex when unsure; skip anything that changes the app's direction and queue it for the morning.

**Result on the QA (quality assurance) ledger:** 457 findings open at the start of the session, 95 open now. Rows fixed tonight are stamped `pr-open` against the three pull requests. The 95 are held classes; Codex judged 14 of them already fixed by code and waiting for the nightly sweep.

**What was built, by pull request.** Decisions and reasons are in `docs/DECISIONS.md` (2026-10-07 evening for the first 47 commits of #101, 2026-10-07 night for the rest). File lists: `git log --stat main..claude/land3-2026-10-07`.

- **#101, first landing.** The ruled findings waiting for a build, the findings that needed no decision, the Worker's replaced-entry fix (Mac payload, Worker reader, parity tests), and a first batch of decisions on the recommended option. Touches most dashboard components, `lib/queries/`, `lib/compute/`, `lib/earnings/`, `lib/calendar/`, `workers/cron/`.
- **#102, second landing.** Level edit (`lib/levels/edit-level.ts`, `app/api/levels/route.ts`); security page disclosures (`lib/queries/security-detail.ts`, `lib/compute/lot-coverage.ts`); Earnings Hub chips and editor copy; phone chat layout (layout only); equity curve time axis (`lib/chart/equity-curve-anchor.ts`); protective puts (`lib/compute/options-strategy.ts`); gross-basis gain percent (`lib/compute/gain-ratio.ts`); the data-quality label basis (`lib/compute/daily-valuation.ts`); cash-deploy and what-if (`lib/compute/cash-deploy.ts`); the Recompute preview (`lib/compute/tax-lot-recompute-summary.ts`, `app/api/compute/tax-lots/route.ts`); the Tax Lots page disclosures; the digest preview (`app/api/digest/preview/route.ts`, preview only); Plaid sync messages (`lib/plaid/refresh.ts`); notes draft recovery; trade-review price window (`lib/trade-review/generate.ts`); the transcript vendor's daily limit (`lib/transcripts/fetch.ts`).
- **#103, third landing.** Level currency (`lib/queries/briefing-levels.ts`, `lib/alerts/generate-suggestion.ts`); hand-entered earnings rows and the "Entered by you" chip (`lib/calendar/reconcile-earnings-dates.ts`, `app/dashboard/today/EarningsDateChip.tsx`); cash-equivalent lists (`lib/compute/cash-equivalents.ts` and five readers); the Giving link stamp (`lib/mutations/donation-links.ts`); bars (`lib/tws/benchmark.ts`, `lib/queries/ohlcv.ts`); Today, analysis and accounts label fixes.
- **New scripts, all dry-run by default:** `scripts/repair-empty-bogeys.ts`, `scripts/repair-duplicate-research-documents.ts`, `scripts/repair-stranded-earnings-suppressions.ts`, `scripts/repair-zero-ohlcv-bars.ts`, `scripts/repair-manual-feed-earnings-pairs.ts`, `scripts/retire-expired-option-holdings.ts`.
- **Docs (this commit):** `docs/DECISIONS.md` (night entry), `docs/plans/TODO.md` (reconciled, one new entry), `docs/reference/conventions-detail.md`, `docs/reference/earnings-pipeline.md`, `CLAUDE.md` (five invariants), this file.

**Method.** Builders worked on disjoint files in one shared worktree and never wrote git. The orchestrator read each diff, re-ran its tests and committed by pathspec. Codex reviewed Claude's committed work, read-only. A Claude agent that ran the code reviewed each unit Codex built. Every blocking review finding was fixed before a branch was pushed.

## 2. Tests / E2E / deploy

| Check | Result |
|---|---|
| Type-check at the last tip (`d01046c5`) | clean |
| Full suite at the last tip | 14,351 passed, 0 failed (12,106 at the previous handoff) |
| Worker suite | 647 passed; Worker type-check clean |
| Browser checks | each landing checked on a sandbox copy of the database, at desktop and phone width; passed, no console errors |
| Not seen in a browser | the "Entered by you" chip: the copy had no hand-entered row in the current week |
| Repair scripts | three rehearsed on a copy (section 0); the other three dry-run only; none run on live data |
| Mac deploy | NOT done |
| Worker deploy | NOT done |
| Live database | no repair applied during the sprint (blocked by the permission system). Just before it began, at about 19:00, the three repair scripts owed from the previous handoff were applied live with a backup, and their decision record was closed |

Notes on the evidence:

- The first landing's automated smoke, run from a side worktree, captured a blank page once. It did not reproduce: a browser agent then loaded every main page at both widths, light and dark, with no console errors.
- Many units in #101 were not browser-checked by their own builders. The per-landing browser pass covered the main pages, not every changed control.
- The full suite was run in a clean verify worktree at each landing tip, not in the shared build worktree.

## 3. Open concerns, rejected approaches, user decisions

**What Codex should scrutinize:**

- **The Worker's replaced-entry and removed-entry lists** (`workers/cron/`, `lib/earnings/cloud-outbox.ts`, `lib/earnings/armed-events-projection.ts`). The outbox was found able to jam on an old failed row and was fixed; a same-version post can now only complete a stored record, never replace it.
- **Hand-entered earnings rows** (`lib/calendar/reconcile-earnings-dates.ts`, `lockedStatusFor`). The sync no longer writes a confirmation. Anything that read `user_confirmed` as "this is a manual row" is now wrong; the Hub chip was the one known reader and was fixed in the same commit.
- **The Giving link stamp** (`linkDonationLegs`). It writes a transaction amount on an acknowledged click.
- **The cash-equivalent SQL twin** and the two live-sync sites that use the type-only signal.
- **The Recompute rehearsal** (`rehearseTaxLotRecompute`): the engine runs inside a transaction that always rolls back. It is safe only while the engine is synchronous.
- **Level edit** (`lib/levels/edit-level.ts`): an edit must never approve or re-arm; a price change on an armed level goes through the arm guard.
- **The phone chat layout.** Chat is a protected area. The wiring is byte-identical and pinned by a hash test; a presentational controls component and focus handling were added.
- **AI cards generate only on a click.** Scenario "live now" badges and cash-deploy read the themes cache, so they show less until themes exist for the week.

**Held, not in any pull request:**

- **Giving: split-adjusted display.** Goal: on the Giving page, show a donated lot's basis and remaining quantity in the units of the donation date, so a split dated after a gift does not distort the row. Two attempts were wrong when a reviewer ran the real engine, though the builder's hand-seeded test passed. Failing case one: a manual-mode split dated before the gift (manual-mode splits rewrite history and are excluded from the replay, so the read layer must not adjust for them again). Failing case two: a lot opened by one trade that both closes a position and opens the opposite one. The same patch also changes "suggest highest-gain" to skip lots with an implausible basis. The file is `lib/queries/giving-view.ts`. **Held patch saved outside the repo; ask the owner's Claude session.** Any rebuild must be tested against lots produced by `computeTaxLots`, not hand-seeded lot rows.
- **"One weight per security across Diagnostics".** Built (`40205f9f`) and reverted (`7b9b2238`). Breakdown, heatmap, concentration and position risk each use a different denominator. A shared gross denominator fixed the display but, with a short in the book, also moved factor tilts, each position's share of volatility and the Defense share of book. The revert commit message has the reviewer's findings.
- **International-exposure scale.** The change would store a different label for new classifications, and `lib/compute/scenario-recipes.ts` scores the old and new labels differently, so scenario figures would move silently. **Held patch saved outside the repo; ask the owner's Claude session.**
- **Held classes among the 95 open findings:** the import pipeline and the chat route (protected areas), automatic-email composers and send paths, the tax-lot engine, stored-data repairs.

**Queued owner decisions** (the same questions, with ids, are in `docs/plans/TODO.md`):

1. May the digest preview's window rule be extracted from the send module, with no behaviour change, so the preview mirrors the sender?
2. Opening the digest Preview fires an AI call with no warning. Gate it behind a click, or relabel the button?
3. Confirming a zero-amount gift pair now writes the leg's amount from the gift's recorded fair value. Keep it?
4. The Plaid daily sync runs no expired-option purge, no matured-bond purge and no classification. Should the purges be scoped per account and wired in? Should classification run there, at the cost of an AI call each morning?
5. A lot closed in a live feed stays open with a market value until a statement arrives. Extend the statement-only design to live-flat options and shorts?
6. Level prices in the weekly briefing and daily digest emails still print a dollar sign on a non-USD security. May the composers change, Worker mirror included?
7. Calendar doubles outside the reconciler window: how should a re-minted feed twin on an old week, or a feed row far ahead, be handled, given that hiding one could hide a row an email finder would pick up?
8. A confirmed vendor row and a hand-entered row on the same date: which should win? Today it depends on row order.
9. Which denominator should each Diagnostics card use when the book holds a short?
10. International-exposure labels: rule on the scenario score before the stored label changes.
11. `scripts/finish-donations.ts` bypasses the acknowledgement the assignment script now needs. Close that path?
12. A hand-entered earnings row reads "Entered by you" on the Hub and "added by hand" on the week view. Which wording?
13. Confirming a date from a conflict popover overwrites a typed clock time with the default. Keep the typed time?
14. The macro themes prompt is cut well short of a full week's input. Raise the cut, rank the inputs, or leave it?
15. The 28 findings Codex called a direction change each need a ruling (grouped in the TODO entry).
16. Confirm or reverse every decision listed in the two DECISIONS entries for the sprint.
17. Apply `repair-manual-feed-earnings-pairs` to the one old pair it found, or leave it?

**Unreconciled between the two Codex passes:** the levels finding about rejected rows under "show inactive" was called a direction change in the second-opinion round and "already fixed by code" in the later triage. Check it on screen before ruling.

**Lessons recorded in `docs/DECISIONS.md`:** a reviewer that runs the real engine catches what a hand-seeded test passes; write the "what must not change" test before wiring a delete into a schedule; a ruled fix can remove the only entry point to a screen, so check what a status was being used for before clearing it; run git commands one at a time in a shared worktree.

**Next recommended work, after the merge and deploy:**

1. Rule on the queued questions; most are one line each.
2. Sweep the QA ledger so the 14 "already fixed by code" rows close, and flip the `pr-open` rows to merged with their commits.
3. Reword the two stale lines in `CLAUDE.md` (the benchmark bar filter and the count of legacy cash-equivalent lists); see the TODO entry.
4. Build the small items triaged as buildable and not built (TODO entry, item n1).
5. Still open from before the sprint: the broker realized-gain reports, the live tax-lot recompute run, the June return restatement, the IBKR monthly-return scale.

## 4. Uncommitted changes and live-process state

- **Sprint worktree** `/Users/Yitzi/code/vanguard-skin-sprint` (branch `claude/sprint-2026-10-07`, tip `d01046c5`, the same commit as the #103 branch): the six doc files of this handoff are edited and uncommitted until the orchestrator commits them. They will need to reach a pull request branch. When this was written the worktree also held one uncommitted unit that is not in any pull request: the bogey upload route and its button (`app/api/earnings/bogeys/upload/route.ts`, `app/dashboard/today/BogeysUploadButton.tsx`) with two new test files. It was not reviewed or verified as part of this handoff; check `git status` there before removing the worktree.
- **Other worktrees:** `/Users/Yitzi/code/vanguard-skin-sprint-verify` (detached at `d01046c5`, has its own `node_modules` clone and a copy of `.env.local`); `/Users/Yitzi/code/vanguard-skin-land1` (branch `claude/land1-2026-10-07`); `/Users/Yitzi/code/vanguard-skin-qa-fix` (the nightly fixer's; leave alone).
- **Main checkout:** `main` at `2daccfef`, equal to `origin/main`. The QA ledger there (gitignored) is stamped `pr-open`; backups of the ledger from before each stamp sit beside it.
- **Processes:** no sandbox or dev server running. A builder may still be working on the bogey upload unit named above. The live app still runs the build from before the sprint.
- **Coordination register:** task `sprint-2026-10-07` is active with a `USER:` next action. No lock is held.
- **Session-local files:** prompts, Codex outputs, review reports and the held patches are in the session's scratch folder outside the repo. It does not survive the session. A running progress log is in gitignored `docs/private/`.

## 5. Agent

Claude Code (Claude Opus 5.5, 1M context) — https://claude.ai/code/session_01ABdui9AGJG1AGrYs8XKHnr
