# Session Handoff — for Codex review

**Waiting on:** USER (each is a `decision` record in the coordination register; `npm run inbox` lists them): `confirm-sprint-decisions-2026-10-08-night` (confirm or reverse what the second overnight sprint decided, and approve or decline the three migrations it held); `confirm-phone-chat-layout` (look at the chat panel on the phone); and, carried from before, `giving-mark-lots-verified`, `broker-realized-gain-reports`, `tax-preparer-short-term-gift`, `confirm-gift-month-convention`, `confirm-builder-rulings-2026-10-07`, `github-support-history-purge`. CODEX: nothing assigned; a review of the merged sprint is welcome, especially section 3. CLAUDE: nothing.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.
> **Commit ids:** history was rewritten on 2026-10-06, so every commit id written in docs before that date is an old id. A private old-to-new map is in gitignored `docs/private/`.

**Session date:** 2026-10-08, morning to about 22:00 Eastern time. One long session in three parts: a ruling session with the owner; a first wave of eight small builds (PR #106); then an unattended sprint the owner started at about 19:40 ("same thing as last night, but try to go further and make more decisions").

## 0. State at the end

- `main` holds everything. The sprint merged as `f4feed84` (49 commits). Wave 1 merged earlier as `4f6aa65a` (PR #106).
- **Deployed:** the Cloudflare Worker (first), then the Mac app. See section 2 for the commit each ran from.
- **The nightly fixer is back on** (`qa/deep-qa-config.json`).
- **Live database:** one repair was applied, with a backup, during the ruling session: the old hand-entered and feed earnings pair for one past print (`scripts/repair-manual-feed-earnings-pairs.ts`; backup `data/vanguard-pre-ter-pair-repair-2026-10-08.db`). Nothing else was written to live data. Three new repair scripts exist and were NOT run.
- **No migration was added.** Three were held for the owner (section 3).

## 1. Goal + what changed

**Goal (the owner's words, shortened):** rule on the questions the 2026-10-07 sprint queued, then run a fully autonomous sprint with Codex: build everything planned and more, decide open questions on the recommendation, get a Codex second opinion when unsure.

**Where to read the detail.** Decisions and reasons are in `docs/DECISIONS.md`, six entries dated 2026-10-08:
1. Owner rulings on the sprint's queued questions.
2. Owner rulings on the findings Codex called a direction change.
3. Design choices found while mapping the ruled builds to code.
4. Wave 1 merged; two rulings from its review.
5. Second overnight sprint: the authority.
6. Second overnight sprint: what was built and decided (the list to confirm or reverse, what is held, the lessons).

File lists: `git log --stat 845b756b..f4feed84` for the sprint, `git log --stat d24c62b5..4f6aa65a` for wave 1.

**What was built, by area** (owner rulings unless marked "decided"):
- **Earnings calendar:** a real slot beats a default time in the duplicate check, before and after the print (`lib/calendar/reconcile-earnings-dates.ts`); a hand-entered row wins a same-date tie; a feed row written behind a hand-entered row is stored hidden and comes back when that row is deleted or moved (`lib/mutations/calendar.ts`, `lib/calendar/sync.ts`); confirming a different date leaves one hand-entered row (`lib/mutations/confirm-earnings-date.ts`); the display-only time estimate reads report history and a same-day twin.
- **Follow-on from the slot rule (decided, after a Codex second opinion):** the weekly briefing lists the canonical earnings row whatever its source (`lib/calendar/briefing-partition.ts`, mirrored block in `workers/cron/src/fallback-briefing.ts`); the kept row takes the vendor data its hidden twin carries (`createFinnhubDataCarrier`); the consensus step reads the hidden vendor twin directly (`lib/earnings/prepare-steps/consensus-row.ts`); the email finder drops a candidate when a same-company row on that date already has that email (`findEmailCandidates`).
- **Today:** the IBKR line measures quantity opened or added today from its cost (`lib/compute/day-move.ts`, `lib/queries/today-holdings.ts`); the Portfolio strip names its baseline statement; an armed Hub row after its print shows a read-only record (new `GET /api/print-watch/record`, `lib/earnings/print-record.ts`); small Hub and add-form fixes.
- **Analysis:** macro themes rank inputs and are checked against their cited article (`lib/compute/macro-themes.ts`); deep in-the-money calls count as stock (`lib/compute/hedging.ts`); Significant Moves follows scope and waits for a completed session (`lib/digest/anomalies.ts`); fixed performance periods end at the last statement (`lib/compute/performance-window.ts`); Diagnostics captions; scope memory; the bond-fund default guard (`lib/compute/bond-duration.ts`); the "live now" badge; scenario input bounds.
- **Accounts and data health:** the equity curve check is flow-aware; a checkpoint falls back to the nearest prior valuation; the Holdings confidence score is weighted by value; one price-freshness window; the Data Health page shows the score at the top.
- **Chat (tool and query code only):** movers one row per side with an account filter and a day effect; the total comes from the strip's selection; the return tool uses the statement window. One two-line change in the protected chat route (the title function).
- **Mac and Worker together (snapshot version 12):** level prices carry their currency in emails and pushes (`lib/alerts/outbound-level-price.ts`, `workers/cron/src/level-price.ts`); the Worker's once-a-day guard uses the Eastern day; the fired marker is kept seven days; a failed push leaves no marker (`workers/cron/src/level-scan.ts`, `lib/alerts/reconcile-cloud-fired.ts`).
- **Reactions:** none is captured before release plus two hours on either side; each snapshot records its capture time; one validity rule (`lib/calendar/reaction-validity.ts`).
- **Research and digest:** the Preview runs its AI synthesis only on a click; the evening sender reads the shared window rule; empty-enrichment articles are queued and show no chip; a two-tier notes picker.
- **Plaid:** the daily sync purges expired options and matured bonds, for its account and live rows only.
- **New scripts, all dry-run by default, none run:** `scripts/repair-alert-suggestions.ts`, `scripts/repair-premature-reaction-snapshots.ts`; `scripts/repair-empty-enrichments.ts` got a wider selector. `scripts/finish-donations.ts` was deleted with the owner's approval.

## 2. Tests / E2E / deploy

| Check | Result |
|---|---|
| Type-check, Mac and Worker, at the merge | clean |
| Full suite on `main` after the merge | 15,366 passed, 0 failed (14,512 at the start of the day) |
| Worker suite | 719 passed |
| Codex | one plan review (wave 1), two code reviews (sprint), one second opinion (the slot rule); every finding fixed except one Claude disagreed with (recorded in DECISIONS) |
| Reviews that ran the code | three: wave 1; sprint earnings, calendar and alerts; sprint money and analysis. All returned ready; their should-fix items were fixed before the merge |
| Browser, sandbox copy | wave 1: smoke 4 of 4 plus three screens. Sprint: smoke 4 of 4 plus thirteen areas at desktop and phone width |
| Worker deploy | done, before the Mac |
| Mac deploy | see the last lines of this section |

Notes on the evidence:
- **The browser pass found a crash that every test passed:** the Data Health page called a function exported from a client file. Fixed, with a test pinning the import boundary, and the page was reloaded on the sandbox.
- **The full suite found three sets of failures the per-unit runs missed:** a source pin left behind by a moved query; two hand-built test schemas missing real columns; two Mac-side tests of the Worker enrich path. All were tests, not product bugs.
- **Not seen in a browser:** the armed row's read-only record (the sandbox had no earnings rows that week); the digest caps caption (empty window); a "pending" reaction label; the chat tools in a live chat; the review fixes made after the browser pass (email finder, Worker gate, caption wording, the four money fixes).
- **Not verified against live data:** the cause of the "0.00% reaction" finding; the basis units of bond and option holdings; how often a print has one vendor with a slot and the other without.

**Deploy record:** the Worker was deployed from `main` at `53111e4c` (the sprint merge plus the closeout docs). The Mac app was deployed from the commit that carries this file; its first attempt did not start because the integration lock from the merge was still held, and nothing was built or quit by that attempt. The deploy log is under the coordination folder's `logs/`.

## 3. Open concerns, rejected approaches, user decisions

**What Codex should scrutinize first:**
- **The slot rule and everything hung on it** (`pickSameDateWinner`, `createFinnhubDataCarrier`, `findHiddenFinnhubDonor`, `resolveVendorConsensus`, `phaseHandledOnSibling`). It is the widest change of the night and it sits on the earnings email path. Known residue: the carried vendor data is wiped by a vendor sync until the reconcile pass at the end of the same sync restores it; the whole-text consensus fill done by the older fold is never refreshed; the Worker's own email finder has no same-company sibling check.
- **`confirmEarningsDate` now deletes a row.** It deletes only after counting every table that references the event and finding none; otherwise it keeps the row hidden and returns a notice.
- **The Worker marker.** Seven-day lifetime, earlier fires carried in the marker, rollback on a failed push, an unreadable marker costs one extra alert. The Mac files one inbox row per Eastern day from `firedAt`.
- **The reaction gate's new follow-up pass** in `lib/calendar/enrichment-runner.ts`: reaction only, bounded to a 30-minute window, inside the pass limit.
- **`computePositionDayMove`** and the two "left out" branches in `today-holdings.ts` (book not seen at the prior close; row dated after the session).
- **The chat route's two-line change** and the new account filter on the market snapshot tool.

**Rejected or not adopted:**
- Codex's suggestion to compare a macro theme's risk-on or risk-off call with its cited article. That call is about the market; the check compares the model's read of the article with the article's stored sentiment.
- Expiring the Worker marker at Eastern midnight (the original ruling's wording). It would have lost cloud alerts from the Mac's inbox overnight.
- Keeping the old vendor as the canonical row and giving it the twin's slot. Codex judged it riskier: every slot reader would have to consult the hidden twin.
- Changing the email finder's pre-reconcile ranking to prefer the slotted row. Replaced by the protective sibling check.

**Held for the owner** (the full list is in the to-do entry "Second overnight sprint"):
1. Three migrations: the vendor actual column for the recap scoreboard; a reason and a reference month for macro actuals; the detection price for a suggested level.
2. The written design for a live-closed option or short as pending.
3. Masking figures in chat titles (needs an edit inside the protected chat component).
4. Ledger and data: retyping option trades; re-classifying one mislabelled fund; the cause of the basis differences.
5. Running the three repair scripts.
6. Questions: a preview already sent stays on a moved row; should scoped Significant Moves evaluate shorts.

**Lessons recorded in `docs/DECISIONS.md`:** a page every test passes can still crash, so a new import from a component file into a server page needs a browser look; hand-built test schemas go stale silently; map who assumes the old winner before changing a winner; builders must not each run the type-checker; check the clock, do not estimate it.

## 4. Uncommitted changes and live-process state

- **Main checkout:** clean after the closeout commit.
- **Worktrees:** the sprint worktree `/Users/Yitzi/code/vanguard-skin-sprint2` and its branch are removed after the deploy; `/Users/Yitzi/code/vanguard-skin-qa-fix` is the nightly fixer's and stays.
- **Processes:** no sandbox or dev server is running. The installed app runs the new build.
- **Coordination register:** the sprint task is released; one new decision record for the owner.
- **Session-local files:** builder briefs, review outputs and Codex transcripts are in the session's scratch folder outside the repo and do not survive the session. The sprint's progress log is in gitignored `docs/private/sprint-2026-10-08/`; note that the times written in it before 21:15 are estimates and are wrong by several hours.

## 5. Agent

Claude Code (Claude Opus 5.5, 1M context) — https://claude.ai/code/session_01ABdui9AGJG1AGrYs8XKHnr
