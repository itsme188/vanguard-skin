---
name: qa-deep-sweep
description: Exploratory "synthetic owner" QA sweep of Portfolio Desk on the :3097 sandbox — parallel zone agents click everything, findings go to a deduped persistent ledger, Pushover on new findings, auto-fix branch for objective breakage. Args: optional `zones=zone1,zone2` to override the config.
---

# Deep QA Sweep — orchestrator

You are orchestrating an exploratory QA sweep. The sandbox server MUST already be running on http://localhost:3097 (started by `qa/sandbox.sh up`). It serves the DEPLOYED Electron build against a throwaway DB copy with no outbound keys — agents may click, submit, and delete anything.

## Step 0 — Preflight

1. `curl -sf http://localhost:3097/api/summary` — if this fails, STOP and report "sandbox not running" (do not start it yourself; the cron wrapper owns the lifecycle).
2. Read `qa/deep-qa-config.json`. Zone list: if the invocation passed `zones=…`, use those; else `mode:"all"` → all 7 zones; `mode:"rotate"` → the zone for today's weekday from `rotation`.
3. Read `qa/findings/ledger.json` (create `{ "findings": [] }` if missing).

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

Dispatch one `agent-browser` subagent per zone, max `maxConcurrentAgents` concurrently per `qa/deep-qa-config.json` (currently 1 = SEQUENTIAL — all zone agents share one Playwright MCP browser, and concurrent agents steal each other's active page; the 2026-06-10 first full sweep saw agents bound to phantom pages, unable to click, falling back to API probes. Do not raise above 1 unless per-agent browser isolation is verified). Each agent gets this charter with its zone scope substituted:

**Dispatch each zone agent as a BLOCKING call and wait for its result before dispatching the next — never as a background task.** Under the nightly cron (`claude -p`, headless) a backgrounded zone agent is killed at the 600s `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` ceiling and the sweep exits 0 mid-zone with no findings (silent truncation 6/29–7/1). The cron wrapper now lifts that ceiling to 6h as a hard backstop, but blocking dispatch is the intended shape regardless.

> You are the owner of Portfolio Desk using the app for real at http://localhost:3097. This is a disposable sandbox: clicking, submitting, and deleting are safe and ENCOURAGED. Your zone: [ZONE SCOPE]. Click every control, open every modal/dropdown/expander, submit every form with plausible values, follow every flow to its end state, and watch the browser console throughout. After every mutation, verify the effect actually landed (re-read the UI or re-navigate) — a success toast with no effect is a finding.
>
> A FINDING is anything a daily user would experience as broken or untrustworthy: a click that visibly does nothing; an error or failed network request (4xx/5xx) on a user action; a dead-end (404, blank panel, empty state with no explanation); rendered `NaN` / `undefined` / `Invalid Date` / `$NaN`; a spinner that never resolves (>15s); a control whose feedback claims success but whose effect didn't happen; a broken layout (overlap, clipped text, unreachable button).
>
> NOT a finding: TWS-connection-dependent gaps (sync buttons, live quotes — TWS is intentionally absent here); data staleness inherent to the sandbox snapshot; Electron-only surfaces correctly explaining themselves (SettingsModal is invisible in browser by design); pure matters of taste with no functional impact. Do NOT click TWS connect/sync controls — that's infrastructure, not UX under test.
>
> For each finding take a screenshot (save to qa/findings/screenshots/, filename = a short slug of the finding). Working/exploratory screenshots (the ones you take just to see a page) go to qa/screenshots/ — NEVER a bare filename, which lands in the repo root (370 strays accumulated there by 2026-07-07). Return ONLY a JSON object: `{"findings": [{"surface": "...", "title": "...", "severity": "high|medium|low", "repro": ["..."], "expected": "...", "actual": "...", "console_errors": ["..."], "screenshot": "qa/findings/screenshots/<slug>.png", "auto_fixable": true|false}]}`.
>
> Severity: high = flow-blocking, error-producing, or shows wrong/misleading data; medium = a feature is unusable or no-ops; low = polish/confusing-but-workable. `auto_fixable` = true ONLY for objective breakage: console error with stack, 4xx/5xx on user action, dead route, NaN/undefined/Invalid Date render. Judgment calls are auto_fixable: false.

## Step 2 — Merge into the ledger

For each returned finding, compute `id` = kebab-case of `surface--title` (strip punctuation). Compare against ledger entries on the same surface — if an existing entry describes the SAME symptom (judge semantically, not string-equal), it is the same finding:

- Existing entry (any status except `fixed`): bump `last_seen` to today. `wontfix` stays `wontfix`. Otherwise status stays/becomes `known`.
- No match: append with `status: "new"`, `first_seen`/`last_seen` = today, plus all schema fields.
- For every ledger entry with status `new`/`known` whose surface belongs to a zone swept THIS run and which was NOT re-reported: set `status: "fixed"`, add `fixed_date`.

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

Append `qa/findings/runs/YYYY-MM-DD.md`: zones swept, agents dispatched, new/known/fixed counts, fix-branch name + outcomes, start/end time. Final reply: one-paragraph summary with the same numbers.
