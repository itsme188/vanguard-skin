# Session Handoff — for Codex review

**Waiting on:** USER (each is a `decision` record in the coordination register; `npm run inbox` lists them): `confirm-sprint-decisions-2026-10-08-night` (confirm or reverse what the overnight sprint decided, all nine waves; approve or decline PR #107); `confirm-phone-chat-layout`; and, carried from before, `giving-mark-lots-verified`, `broker-realized-gain-reports`, `tax-preparer-short-term-gift`, `confirm-gift-month-convention`, `confirm-builder-rulings-2026-10-07`, `github-support-history-purge`. CODEX: nothing assigned; a review of the merged sprint is welcome, especially section 3. CLAUDE: nothing.

> Rolling file, overwritten at each session close. Past handoffs: `git log -p docs/HANDOFF.md`.
> Written by Claude Code so Codex can review changes and reasoning at full project context.
> **Commit ids:** history was rewritten on 2026-10-06, so every commit id written in docs before that date is an old id. A private old-to-new map is in gitignored `docs/private/`.

**Session date:** 2026-10-08 morning to 2026-10-09 early morning, Eastern time. One long session: a ruling session with the owner; a first wave of eight small builds (PR #106); then an unattended sprint the owner started at about 19:40 and, after an early closeout at about 22:00 that the owner called too little, told to run through the night.

## 0. State at the end

- `main` holds everything except the held migrations. The overnight sprint merged in eight steps: `f4feed84` (first half, 49 commits), then `04d5d787`, `1d92150a`, `30288312`, `7796af1d`, `605de55a`, `d9c77919` `b093ea5b` (eighth wave) and one small ninth-wave merge (waves two to nine, about 100 more commits).
- **Deployed:** see section 2 for the commit each side runs.
- **The nightly fixer is back on** (`qa/deep-qa-config.json`). It was paused for the whole sprint.
- **PR #107 is open and NOT merged:** three additive migrations (096, 097, 098) and the code that uses them. It is up to date with `main` and was rehearsed on a copy of the live database. It waits for the owner.
- **Live database:** one repair was applied, with a backup, during the ruling session (an old hand-entered and feed earnings pair). Nothing else was written to live data by this session. Several read-only counts were taken before landing changes that could touch live rows; each is named in the decisions log. Three repair scripts exist and were NOT run.
- **QA ledger (gitignored, local):** stamped. Open rows went from 102 to 40.

## 1. Goal + what changed

**Goal (the owner's words, shortened):** rule on the questions the 2026-10-07 sprint queued, then run a fully autonomous sprint with Codex: build everything planned and more, decide open questions on the recommendation, get a Codex second opinion when unsure, and get the app clear.

**Where to read the detail.** `docs/DECISIONS.md` has one entry per step, each with the decisions to confirm or reverse, what was deliberately limited, what is held, and the lessons:
1. 2026-10-08: owner rulings on the queued questions; on the direction findings; design choices from mapping.
2. 2026-10-08 (evening): wave 1 merged.
3. 2026-10-08 (night): the sprint's authority; what the first half built.
4. 2026-10-08 (late night): second half (twenty decisions).
5. 2026-10-08 (toward midnight): third wave.
6. 2026-10-09 (after midnight): fourth wave, real-looking figures out of committed docs and tests.
7. 2026-10-09 (about 01:00): fifth wave, with the one-time deploy rule for the broker-sync date change.
8. 2026-10-09 (about 02:15): sixth wave.
9. 2026-10-09 (about 02:40): seventh wave, with the list of guards added.
10. 2026-10-09 (about 03:20): eighth wave and closeout, with the Worker audit's open items.
11. 2026-10-09 (about 03:45): a small ninth wave found by the final browser check (the trust strip and the Fixed Income card now use one bond-duration estimator).

File lists: `git log --stat 6b06dbb0..HEAD` for waves two to eight; `git log --stat 845b756b..f4feed84` for the first half.

**What waves two to eight built, by theme:**
- **Honest figures and wording:** a pending reaction never prints as a percent (Mac and Worker); short lots are signed by side and share one basis with the Tax Lots page in every chat reader; "beat N of 8" and the average use one sample; a recap scoreboard prints dashes and a preview keeps its boxes; the Fixed Income card uses the scenario estimator's durations and never gives a floating or index-linked note a duration; a bogey row counts only when a composer prints something from it, and a vendor-only entry is not called curated.
- **Email selection:** evening movers and the digest held list read the current book; a claim for a missing calendar row is a plain refusal; a manual or nudge send on the later of two hand-entered entries is refused; an expired option in the old compact date format no longer counts as held.
- **Calendar:** a feed row on a removed date never wins the duplicate check; a hand-entered add hides a showing feed row at once and names a hidden twin; an edit runs the slot guard; saving over a web-verified release time asks first.
- **Scope:** the money-weighted return, risk tiles, curve, factors and option strategies read the whole named scope; a defined empty account list means no accounts in every reader and in the one cleanup that deletes; in chat, "vanguard" no longer answers with the Roth account.
- **Dates:** every user-facing "today" in JavaScript and every calendar-day comparison in SQL uses the Eastern day; time windows compare timestamps in one form.
- **Integrity:** the lot scan compares lots with statement holdings, rolls lots back when the ledger is newer, and lists possible duplicate imports as a question.
- **Honest failures:** twenty-six client requests read their reply through the shared reader, and a failed load no longer renders as an empty list; a repo scan lists every handler still on a hand-written check.
- **Cloud fallback:** the Worker reads every live hand-entered earnings row for the two-entries rule (snapshot version 13) and checks bar dates for evening movers.
- **Interface:** every question goes through the app dialog; small coloured text reaches the 4.5 to 1 floor in both themes from one checked table (visible: darker badge text and near-black text on solid gold buttons in the light theme); wording beside a masked count no longer gives the count away; Giving ids are unique and deterministic.
- **Public repo hygiene:** committed documents and tests no longer carry real-looking portfolio figures (16 documents, 64 test files, 3 fixtures). Real-looking data that is still in committed SOURCE files is listed for the owner in the 2026-10-09 (after midnight) entry; the most serious is an account number used as a lookup key in two import parsers.

## 2. Tests / E2E / deploy

| Check | Result |
|---|---|
| Type-check, Mac and Worker, at every merge | clean (it caught four slips that tests did not: a missing import, two duplicate imports, three test typings) |
| Full suite on `main` at the last merge | 16,762 passed, 0 failed (14,512 at the start of the day) |
| Worker suite | 841 passed |
| Codex | nine code reviews, one design review, one plan review, two second opinions; every finding fixed or recorded as held with the reason |
| Reviews that ran the code | seven, one per wave from the second on, each with probes against `main`'s own code; all returned ready, their should-fix items fixed before the merge |
| Browser, sandbox copy | smoke 4 of 4 at every wave; a final look-only pass of the finished build with every data load healthy; six measured passes across desktop and phone width and both themes, with contrast measured by script |
| PR #107 | type-check clean; Mac suite 16,935 and Worker suite 936 on the branch; migrations rehearsed on a copy of the live database |

Notes on the evidence:
- **The browser found what tests could not**, three times: a status strip made unreadable inside the always-dark chart panel by a colour change, a phone dialog pushed off screen by a long file name, and twelve older contrast misses.
- **The type-check found what tests could not**: a component that used a name it never imported would have crashed on first render.
- **Not seen in a browser** (the sandbox had no earnings rows this week): every Earnings Hub dialog and popover, the bogeys modal, reconciliation chips, the armed row's read-only record, a "not modelled" duration, the digest catch-up banner, the corporate-action undo dialog, the rotate-credential dialog (packaged app only).
- **Not verified against live behaviour:** any email actually sent; a broker sync in the evening after the date change; a Plaid reconnect after the per-tab change.

**Deploy record:** the Worker and the Mac app were each deployed for the last time after 04:30 Eastern on 2026-10-09 from the commit that carries this file, Worker first (the eighth wave changes the Worker and adds snapshot version 13). Before that the Mac app was deployed five times overnight, the last at 01:13 Eastern. No deploy ran between 01:30 and 04:30 Eastern. The deploy log is under the coordination folder's `logs/`.

## 3. Open concerns, rejected approaches, user decisions

**What Codex should scrutinize first:**
- **The broker-sync date change** (`lib/tws/positions.ts`, `lib/tws/streaming.ts`): live holdings, prices and the live snapshot row are stamped with the Eastern day. It first went live at 01:13 Eastern, inside the hours two reviews named as safe. A live sync still replaces a statement holdings row dated the same day (older behaviour, now also true on the evening of a statement date).
- **The SQL date sweep** (`lib/db/eastern-day-sql.ts` and twenty callers): the purges that delete holdings rows, and earnings coverage. A reviewer rebuilt `main`'s queries with a controllable clock and found daytime identical and nothing deleted earlier; a second pair of eyes is welcome.
- **The integrity scan's roll-back** (`lib/queries/integrity-checks.ts`): it undoes ledger rows and import-sourced splits newer than the statement before comparing.
- **The reconciler and removed dates** (`lib/calendar/reconcile-earnings-dates.ts`, `lib/calendar/event-suppressions.ts`), on top of the first half's slot rule.
- **The recap renderer keying on the scoreboard heading** (`lib/calendar/briefing-html.ts`, `workers/cron/src/html.ts`).
- **The colour changes** across about 100 component files: one commit per sweep, each easy to revert.
- **The honest-handler conversion** (`58e31244`): a route that answers without the success flag must never be put on the shared reader. The list of handlers deliberately left alone is in `tests/repo/honest-mutating-handlers.test.ts`.
- **The Worker's twin-rule input** (`manualTwinRuleRows`, snapshot version 13).

**Rejected or not built, with the reason:**
- Aligning the read-through builder's consensus order: a test shows it would let a revenue figure into a prompt unchecked.
- Retiring the "duplicate" of a monthly release shown on two dates: the stored data shows most are real separate releases.
- Changing the scope resolver so a named scope that matches no account is empty, not "every account": about twenty callers; it cannot occur on the current book; held for the owner.
- The Electron cookie change and the 8-K exhibit-link fix: each needs a check this session could not make.
- A cleanup that would make the broker-sync date change safe at any hour: it is a delete on live data.
- Four cloud-side gaps found by a Worker audit (option-only coverage, the morning digest window, the evening re-cover, no snapshot age check): each would add sends or change email content.
- Eighteen undecided items: Codex's second opinion was to hold all but one; its list is in gitignored `docs/private/sprint-2026-10-08/`.

**Held for the owner** (full lists in the to-do entry "Second overnight sprint"):
1. PR #107.
2. The written design for a live-closed option or short as pending (`docs/superpowers/specs/2026-10-08-live-closed-options-shorts-pending-design.md`, twelve questions).
3. Real-looking data in committed source files, and the git history purge.
4. Three one-line changes inside the protected chat component (Send button colour, scope pill colour, the scroll-on-mount that makes the first Tab skip the skip link).
5. Ledger and data: retyping option trades; the mislabelled fund; the basis differences; one short option lot opened by a sell-to-close row; the three unrun repair scripts.
6. Ledger hygiene: 491 older rows marked fixed with no fix commit; two pairs of duplicate ids.

**Lessons recorded in `docs/DECISIONS.md`:** a base-class change needs a search for callers that override it; "claims X" and "prints X" must come from one list; colour inside an always-dark panel is checked separately from the page theme; two builders in one file means one unit's commit can carry the other's unfinished lines; a brief that wants a stop-and-report must say so in its first line; a dev server can serve a stale stylesheet after a restart; check the clock, do not estimate it.

## 4. Uncommitted changes and live-process state

- **Main checkout:** clean after the closeout commit.
- **Worktrees:** `/Users/Yitzi/code/vanguard-skin-migrations` (branch `claude/held-migrations-2026-10-08`, PR #107) stays until the owner decides; `/Users/Yitzi/code/vanguard-skin-qa-fix` is the nightly fixer's and stays. All sprint worktrees and branches are removed.
- **Processes:** no sandbox or dev server is running. The installed app runs the last build.
- **Coordination register:** the sprint tasks are released; `held-migrations-2026-10-08` stays open for PR #107.
- **Session-local files:** builder briefs, review outputs, Codex transcripts and browser screenshots (which show real figures) are in the session's scratch folder outside the repo and do not survive the session. The progress log, the triage report and Codex's second opinion are in gitignored `docs/private/sprint-2026-10-08/`.

## 5. Agent

Claude Code (Claude Opus 5.5, 1M context) — https://claude.ai/code/session_01ABdui9AGJG1AGrYs8XKHnr
