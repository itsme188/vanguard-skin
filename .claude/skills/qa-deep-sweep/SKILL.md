---
name: qa-deep-sweep
description: Exploratory "synthetic owner" QA sweep of Portfolio Desk on the :3097 sandbox — parallel zone agents click everything, findings go to a deduped persistent ledger, Pushover on new findings, auto-fix branch for objective breakage. Args: optional `zones=zone1,zone2` to override the config.
---

# Deep QA Sweep — orchestrator

You are orchestrating an exploratory QA sweep. The sandbox server MUST already be running on http://localhost:3097 (started by `qa/sandbox.sh up`). It serves the DEPLOYED Electron build against a throwaway DB copy with no outbound keys — agents may click, submit, and delete anything.

## Step 0 — Preflight

1. The sandbox is behind the #35 auth boundary; `qa/sandbox/session.env` (written by `qa/sandbox.sh up`) carries the QA session cookie values. `source qa/sandbox/session.env` then `curl -sf -H "Cookie: vgs_session=$VGS_SESSION" http://localhost:3097/api/summary` — if this fails, STOP and report "sandbox not running" (do not start it yourself; the cron wrapper owns the lifecycle).
2. Read `qa/deep-qa-config.json`. Zone list: if the invocation passed `zones=…`, use those; else `mode:"all"` → all 7 zones; `mode:"rotate"` → the zone for today's weekday from `rotation`.
3. Read `qa/findings/ledger.json` (create `{ "findings": [] }` if missing).
4. **Resume check**: read `qa/findings/.sweep-progress.json` (`{ "date": "YYYY-MM-DD", "completedZones": [...] }`). If its `date` is today, drop the listed zones from this run's zone list and note "resuming — skipping N already-completed zones" in the run summary. If the date is older or the file is missing, ignore it (it gets overwritten at the first checkpoint).

## Zones

| key | scope |
|---|---|
| `today` | `/dashboard/today`: alerts triage (respond/dismiss/note), TodayReleases, EarningsHub (add-ticker form, pre/rec/gen chips, bogeys modal, skip toggles), Significant Moves, NearbyLevels, Momentum Pulse, week-ahead calendar block |
| `analysis` | `/dashboard/analysis`: all 4 sub-views (Performance incl. period selector + scope selector, Classification, Factor Exposure incl. benchmark picker, Trade Reviews), Trust Strip + drawer buttons, scenario modeling incl. custom what-if, narrative + macro-theme cards |
| `research` | `/dashboard/research`: Feeds (search, filters, source chips, article expand, Filtered audit list + unfilter), Notes (create/edit/delete), Documents (upload zone behavior, tags), ManageSourcesModal (all per-source controls), digest Preview modal both layouts |
| `security-detail` | Cmd+K jump to 2-3 held symbols + 1 watchlist symbol: chart interactions, LevelsPanel full CRUD (add/edit/pause/reactivate/delete), watchlist star toggle, notes, tax lots expanders, transcripts, QuoteStats; plus `/dashboard/alerts` inbox actions and `/dashboard/levels/performance` |
| `import-settings` | `/dashboard/import`: drop a small CSV (create a 3-row canonical CSV in /tmp first), preview WITHOUT committing, CanonicalCsvGuide; `/dashboard/data-health`; email viewer modals from EarningsHub/Calendar; header controls (theme toggle, privacy toggle, NotificationBell, Cmd+; NotesAmbient) |
| `accounts-charts-calendar` | `/dashboard/accounts` (scope selector, holdings section, reconciliation expander), `/dashboard/charts` (symbol picker, range buttons, indicators), calendar surfaces incl. EnrichmentChips |
| `mobile` | 390×844 viewport: Today, Research, Chat overlay, Notes, Analysis via MobileBottomNav; check overflow, tap targets, safe-area, FAB collisions |

## Step 1 — Dispatch zone agents

Dispatch one `agent-browser` subagent per zone, max `maxConcurrentAgents` concurrently per `qa/deep-qa-config.json` (currently 1 = SEQUENTIAL — all zone agents share one Playwright MCP browser, and concurrent agents steal each other's active page; the 2026-06-10 first full sweep saw agents bound to phantom pages, unable to click, falling back to API probes. **Do not raise above 1 — researched 2026-07-17 and confirmed structural**: subagents share the parent session's MCP server processes, so per-subagent browser isolation within one session is IMPOSSIBLE. True parallelism requires per-zone `claude -p` child processes, each with `--strict-mcp-config --mcp-config` spawning its own `@playwright/mcp --isolated` server — and would also need data-disjoint zone lanes, since zones mutate overlapping surfaces (today + security-detail both triage alerts; mobile revisits everything) and concurrent mutations read as false findings. Deliberately deferred; the nightly window makes sequential fine). Each agent gets this charter with its zone scope substituted:

**Dispatch each zone agent as a BLOCKING call and wait for its result before dispatching the next — never as a background task.** Under the nightly cron (`claude -p`, headless) a backgrounded zone agent is killed at the 600s `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` ceiling and the sweep exits 0 mid-zone with no findings (silent truncation 6/29–7/1). The cron wrapper now lifts that ceiling to 6h as a hard backstop, but blocking dispatch is the intended shape regardless.

**Build each zone's RE-VERIFY LIST before dispatching it (2026-09-02):** from the ledger, collect (a) every `new`/`known` entry on that zone's surfaces, (b) every match-and-hold entry (`fixed` with `fix_status` `pr-open`/`merged-awaiting-deploy`), and (c) every "suspect flip" — an entry with `status: "fixed"` and NO `fix_commit`. Substitute the ids into the charter's `[RE-VERIFY IDS]` slot (id + one-line title + repro steps each). The agent must return an explicit verdict per id; Step 2 flips nothing without one.

**Checkpoint after EVERY zone agent returns — do not batch the merge to the end.** As soon as a zone's agent returns its findings JSON: (a) run the Step 2 merge for that zone's findings, (b) write `qa/findings/ledger.json` + regenerate `FINDINGS.md`, (c) update `qa/findings/.sweep-progress.json` with today's date and the zone appended to `completedZones`. An interrupted sweep then loses at most the in-flight zone, and a same-day re-invocation resumes from the next zone (preflight step 4). Historical motivation: ~a quarter of sweeps died mid-dispatch (interrupts, browser locks) and lost ALL completed zones' work because the merge only happened after every agent returned.

> Before browsing: read `qa/sandbox/session.env` from the repo, open http://localhost:3097/login, and set both cookies via browser eval (`document.cookie="vgs_session=<value>; path=/; SameSite=Lax"` and the same for `vgs_csrf`), then navigate to your zone — the sandbox sits behind the #35 auth boundary and every route 401s without them.
>
> You are the owner of Portfolio Desk using the app for real at http://localhost:3097. This is a disposable sandbox: clicking, submitting, and deleting are safe and ENCOURAGED. Your zone: [ZONE SCOPE]. Click every control, open every modal/dropdown/expander, submit every form with plausible values, follow every flow to its end state, and watch the browser console throughout. After every mutation, verify the effect actually landed (re-read the UI or re-navigate) — a success toast with no effect is a finding.
>
> A FINDING is anything a daily user would experience as broken or untrustworthy: a click that visibly does nothing; an error or failed network request (4xx/5xx) on a user action; a dead-end (404, blank panel, empty state with no explanation); rendered `NaN` / `undefined` / `Invalid Date` / `$NaN`; a spinner that never resolves (>15s); a control whose feedback claims success but whose effect didn't happen; a broken layout (overlap, clipped text, unreachable button).
>
> NOT a finding: TWS-connection-dependent gaps (sync buttons, live quotes — TWS is intentionally absent here); data staleness inherent to the sandbox snapshot; Electron-only surfaces correctly explaining themselves (SettingsModal is invisible in browser by design); pure matters of taste with no functional impact. Do NOT click TWS connect/sync controls — that's infrastructure, not UX under test.
>
> RE-VERIFY LIST — [RE-VERIFY IDS]. For EACH id above, re-run its repro steps and return an explicit verdict: `still_broken` (re-report it as a finding as well), `gone` (you exercised the exact steps and the symptom is absent), or `could_not_check` (say why in `note` — e.g. needs a weekend, needs a forced AI failure). Never guess: an id you did not actually exercise is `could_not_check`, not `gone`.
>
> For each finding take a screenshot (save to qa/findings/screenshots/, filename = a short slug of the finding). Working/exploratory screenshots (the ones you take just to see a page) go to qa/screenshots/ — NEVER a bare filename, which lands in the repo root (370 strays accumulated there by 2026-07-07). Return ONLY a JSON object: `{"findings": [{"surface": "...", "title": "...", "severity": "high|medium|low", "repro": ["..."], "expected": "...", "actual": "...", "console_errors": ["..."], "screenshot": "qa/findings/screenshots/<slug>.png", "auto_fixable": true|false}], "verdicts": [{"id": "<ledger id>", "verdict": "still_broken|gone|could_not_check", "note": "..."}]}`.
>
> Severity: high = flow-blocking, error-producing, or shows wrong/misleading data; medium = a feature is unusable or no-ops; low = polish/confusing-but-workable. `auto_fixable` = true ONLY for objective breakage: console error with stack, 4xx/5xx on user action, dead route, NaN/undefined/Invalid Date render. Judgment calls are auto_fixable: false.

## Step 2 — Merge into the ledger (runs per zone, at each checkpoint)

This merge runs once per zone, immediately after that zone's agent returns (see the checkpoint rule in Step 1) — not as one batch at the end.

For each returned finding, compute `id` = kebab-case of `surface--title` (strip punctuation). Compare against ledger entries on the same surface — if an existing entry describes the SAME symptom (judge semantically, not string-equal), it is the same finding:

- Existing entry (any status except `fixed`): bump `last_seen` to today. `wontfix` stays `wontfix`. Otherwise status stays/becomes `known`.
- Existing entry with `status: "fixed"` whose `fix_status` is `"pr-open"` or `"merged-awaiting-deploy"`: **match-and-hold** (ARM precondition 3, 2026-07-26). The fix exists but has not reached the deployed build the sandbox serves, so the symptom re-appearing is EXPECTED — bump `last_seen` only; never append a duplicate finding and never flip the status. (Re-appending mints a fresh id the fixer's anti-strand `[qa:<id>]` trailer grep can't match, so the same bug gets a second fix on a second branch — the stranding disease.) The entry resolves for real when a sweep AFTER the fix deploys stops seeing the symptom.
- Existing entry with `status: "fixed"` that should already be in the deployed build (`fix_status` `"merged"` or absent): a re-reported symptom is a true regression — append as a new finding with the `-regression-N` suffixed id (existing convention).
- No match: append with `status: "new"`, `first_seen`/`last_seen` = today, plus all schema fields.
- **Flip to `fixed` ONLY on an explicit `gone` verdict** in the zone agent's `verdicts` list (2026-09-02 rule — absence is not evidence: on 2026-08-31 fourteen entries were flipped on absence with no `fix_commit`, and ten of them were still broken the next day). A verdict flip records `fixed_date` + `verification_note: "gone per zone agent verdict YYYY-MM-DD"` — never a `fix_commit` it does not have. `still_broken` → bump `last_seen` (the re-report merges per the rules above). `could_not_check` or no verdict at all → leave the entry untouched and append a dated `note` saying why. Zone-scoped by construction — never flip entries for zones not yet swept this run.
- **Suspect flips:** an existing `status: "fixed"` entry with no `fix_commit` is unverified. It rides in the zone's re-verify list; a `still_broken` verdict re-files it as `-regression-N` with a note that no fix ever existed, and a `gone` verdict adds the `verification_note` above.

Write `qa/findings/ledger.json`, then regenerate `qa/findings/FINDINGS.md`: open findings (new + known) sorted high→low severity, each with repro steps, expected/actual, screenshot link, first_seen/last_seen; then a compact "Recently fixed" and "Wontfix" archive. Header note: "Findings are against the DEPLOYED Electron build (repo main may already be ahead)."

## Step 3 — Notify

If ≥1 finding has `status: "new"` after the merge:
`bash scripts/qa-pushover.sh "Deep QA: <N> new (<M> high): <top 2 titles separated by '; '>"`
If zero new findings: do NOT send anything (quiet night).

## Step 4 — Auto-fix pass (objective breakage only)

For NEW findings with `auto_fixable: true`:
1. `git checkout -b qa-deep-fixes-$(date +%Y-%m-%d)` (if it exists, add `-2` suffix).
2. Per finding, max 2 fix attempts: root-cause in the repo source, fix, `npx vitest run` must fully pass. Commit per fix referencing the finding id. If 2 attempts fail, revert the attempt and note it in the run summary.
3. NEVER push. `git checkout main` when done. Record the branch name in the run summary and at the top of FINDINGS.md.

If there are no new auto_fixable findings, skip entirely (stay on main).

## Step 5 — Run summary

Append `qa/findings/runs/YYYY-MM-DD.md`: zones swept (note any skipped via resume), agents dispatched, new/known/fixed counts, fix-branch name + outcomes, start/end time. Final reply: one-paragraph summary with the same numbers. Leave `.sweep-progress.json` in place — it's date-keyed, so tomorrow's run ignores it automatically; a same-day manual re-run correctly skips completed zones.
