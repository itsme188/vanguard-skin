# Nightly Deep QA — "synthetic owner" exploratory sweep

**Date:** 2026-06-10
**Status:** Approved (design), pending implementation plan
**Owner pain:** "Again and again I am trying to use the Portfolio Desk app and finding problems with it." The existing nightly QA (`qa/run-qa.sh`) answers "did something break overnight?" — deterministic navigation + value extraction vs baselines. It cannot answer "what is wired in but not fully functional?" because it only tests what was scripted. This system adds an exploratory agent that uses the app the way the owner does and reports what doesn't actually work.

## Decisions locked during brainstorm

| Question | Decision |
|---|---|
| Finding disposition | **Report + auto-fix the unambiguous breaks only.** Subjective UX findings are report-only. |
| Interaction scope | **Sandboxed full interaction.** Throwaway DB copy + second server; agent may click/submit/delete anything. Live app and live data never touched. |
| Cadence (week 1) | **Full deep sweep nightly** (all zones). Week 2+: flip config to rotating one-zone-per-night to cut cost. |
| Morning surfacing | **Pushover only**, and only when NEW findings exist (quiet night = no push). No digest-email changes. |
| Architecture | **Claude-orchestrated sweep with parallel zone agents** (Approach 1). Existing 2 AM smoke sweep stays untouched. |

## Components

### 1. Sandbox — `qa/sandbox.sh up|down`

- **Snapshot:** `sqlite3 data/vanguard.db "VACUUM INTO 'qa/sandbox/vanguard-qa.db'"` — clean point-in-time copy, safe while the Electron app holds the WAL (VACUUM INTO reads through the live connection's view; no lock contention, no -wal/-shm juggling).
- **Boot:** `DATABASE_PATH=<abs path to copy> RESEND_API_KEY= PUSHOVER_APP_TOKEN= PUSHOVER_USER_KEY= GMAIL_APP_PASSWORD= WORKER_MARKER_URL= CRON_SHARED_SECRET=qa-sandbox npx next dev -p 3097`. `lib/db.ts` already honors `DATABASE_PATH` (db.ts:11). Real (even empty) process env vars take precedence over `.env.local` in Next.js, and every outbound surface (`lib/email.ts`, `lib/alerts/notify-pushover.ts`, marker posts) already no-ops gracefully on falsy keys — the sandbox cannot send real mail, push, or Worker traffic.
- **Lifecycle:** health-check loop on `GET :3097/api/summary`; PID file at `qa/sandbox/server.pid`; `down` kills that PID only (never broad process kills, per safety rules) and `rm -rf` the sandbox dir by absolute path.
- **TWS:** agents are instructed to skip TWS connect/sync controls (infrastructure, not UX under test). If one clicks anyway: duplicate clientId 1 is rejected by TWS within seconds, and any sync writes land in the throwaway DB. Harmless.
- **Port:** 3097 (3099 = Electron live, 3000 = dev, 3098 = historical worktree convention).

### 2. Zone map + agent charter

Seven zones, dispatched as parallel agent-browser subagents (4 concurrent, matching the established parallel-browser-agents pattern):

1. **today** — Today view: alerts triage, TodayReleases, EarningsHub (+add-ticker form, chips, modals), Significant Moves, NearbyLevels, Momentum Pulse
2. **analysis** — all 4 sub-views (Performance, Classification, Factor Exposure, Trade Reviews), Trust Strip + drawer, scenario modeling, benchmark picker, narrative/macro-theme cards
3. **research** — Feeds (filters, source chips, Filtered audit list, unfilter), Notes, Documents, ManageSourcesModal, digest preview modal
4. **security-detail** — via Cmd+K jump: chart, levels panel CRUD, watchlist toggle, notes, lots, transcripts, QuoteStats; plus `/dashboard/levels/performance` and the alerts inbox
5. **import-settings** — Import tab (preview flow with a fixture file, canonical guide), SettingsModal sections (browser-mode behavior: documented as Electron-only — verify it explains itself rather than rendering nothing), email viewers, Data Health page
6. **accounts-charts-calendar** — Accounts (+reconciliation section, scope selector), Charts, Today's week-ahead calendar block + enrichment chips
7. **mobile** — 390px viewport pass across Today, Research, Chat, Notes, Analysis via MobileBottomNav; safe-area, overflow, tap targets

**Charter (identical per zone, parameterized by zone scope):** "You are the owner using Portfolio Desk for real at `http://localhost:3097`. This is a sandbox — clicking, submitting, and deleting are all safe and encouraged. Click every control in your zone, open every modal/dropdown/expander, submit every form (use plausible values), follow every flow to its end state, and watch the console. A finding is anything a daily user would experience as broken or untrustworthy: a click that visibly does nothing, an error or 4xx/5xx on a user action, a dead-end (404, blank panel, unexplained empty state), `NaN`/`undefined`/`Invalid Date`/`•••`-where-data-belongs, a spinner that never resolves, a control whose feedback claims success but whose effect didn't happen, a layout break. Do NOT report: TWS-connection-dependent gaps, data staleness inherent to the sandbox snapshot, or matters of taste with no functional impact. Verify effects: after a mutation, re-read the UI (or re-navigate) to confirm the change actually landed."

### 3. Finding schema + persistent ledger

Each zone agent returns JSON:

```json
{
  "findings": [{
    "surface": "alerts-inbox",
    "title": "Dismiss button no-ops on MA-based level alerts",
    "severity": "high | medium | low",
    "repro": ["step 1", "step 2"],
    "expected": "...",
    "actual": "...",
    "console_errors": ["..."],
    "screenshot": "qa/findings/screenshots/<id>.png",
    "auto_fixable": true
  }]
}
```

- **Severity rubric:** high = flow-blocking, error-producing, or data-integrity-misleading; medium = feature unusable or no-ops; low = polish/confusing-but-workable.
- **`auto_fixable` gate (objective breakage only):** console error with stack, HTTP 4xx/5xx on a user action, dead route/404, render of `NaN`/`undefined`/`Invalid Date`. Everything else is report-only regardless of severity.
- **Ledger:** `qa/findings/ledger.json` — one entry per finding with stable `id` (slug of surface + normalized title), `first_seen`, `last_seen`, `status: new | known | fixed | wontfix`. Orchestrator dedupes (same surface + same symptom → `known`, bump `last_seen`), auto-flips `fixed` when a known finding's surface was covered this run and the finding didn't reproduce, and never resurrects `wontfix` (re-observation just bumps `last_seen`). The owner edits status to `wontfix` to silence judgment calls.
- **Human view:** `qa/findings/FINDINGS.md` regenerated each run — open findings sorted by severity with repro + screenshot links, then a short fixed/wontfix archive. Screenshots in `qa/findings/screenshots/` keyed by finding id (stable across runs).
- **All deep-QA artifacts are local-only** (`qa/findings/` and `qa/sandbox/` added to `qa/.gitignore`, joining the existing `screenshots/ reports/ logs/` entries). The repo is public and findings text/screenshots will contain tickers, position counts, and dollar values — the no-sensitive-data-public rule applies. The skill and scripts (charter, zone map, config) are tracked; the data they produce is not.
- **Pre-existing leak found during this design (remediate in the implementation plan):** `qa/expected-values.json` is git-tracked in the public repo and contains the real portfolio total and position counts. Minimum fix: `git rm --cached` + gitignore + commit. Whether to also scrub history (precedent: 2026-04-07 git-filter-repo screenshot scrub) is the owner's call.

### 4. Orchestrator — project skill `.claude/skills/qa-deep-sweep/SKILL.md`

Holds the zone map, charter, schema, ledger procedure, and disposition rules. Invocable two ways: nightly via `claude -p "/qa-deep-sweep"` from the cron wrapper, or manually (`/qa-deep-sweep` or `/qa-deep-sweep zones=analysis`) after a big change. Steps:

1. Read `qa/deep-qa-config.json` → zone list (`mode: "all"` week 1; `mode: "rotate"` uses day-of-week map).
2. Verify sandbox health (`:3097/api/summary` 200) — abort loudly if down.
3. Dispatch zone agents (parallel, ≤4 concurrent), collect schema JSON.
4. Dedupe vs ledger; write ledger + FINDINGS.md + screenshots.
5. Pushover via `scripts/qa-pushover.sh` (reads real keys from `.env.local`; orchestrator runs outside the sandbox) — only if ≥1 NEW finding: "Deep QA: N new (M high): <top title>; …".
6. Auto-fix pass: for NEW `auto_fixable` findings, branch `qa-deep-fixes-YYYY-MM-DD`, max 2 attempts per finding, `npx vitest run` must pass, never pushed, branch left for review. Return to main afterward regardless.
7. Append run summary to `qa/findings/runs/YYYY-MM-DD.md` (zones covered, counts, cost-relevant stats: agents spawned, duration).

### 5. Cron wrapper + schedule

- `qa/nightly-deep-qa.sh`: sandbox up → skill invocation → sandbox down (in `trap`, so the :3097 server never leaks) → exit code reflects orchestrator success.
- New plist `com.vanguard-skin.nightly-deep-qa.plist`, `StartCalendarInterval` **2:45 AM local** — after the 2:00 smoke sweep + state snapshot. Local time is deliberate (gates on Mac-idle, not market hours; the ET-gate convention is for outbound emails). Logs to `~/Library/Logs/vanguard-nightly-deep-qa.log`. Mirror plist copy in `docs/launchd/`.
- Existing `com.vanguard-skin.nightly-qa.plist` (2:00 smoke sweep) unchanged.

### 6. Config — `qa/deep-qa-config.json`

```json
{ "mode": "all",
  "rotation": { "Mon": "today", "Tue": "analysis", "Wed": "research", "Thu": "security-detail", "Fri": "import-settings", "Sat": "mobile", "Sun": "accounts-charts-calendar" },
  "maxConcurrentAgents": 4 }
```

Week-2 cost switch = `"mode": "rotate"`. Estimated cost: ~$5-15/night at `all`, ~$1-3 at `rotate`.

## Rollout & verification

1. Implement sandbox + run `qa/sandbox.sh up` manually; verify :3097 serves the copied book and that a test mutation (add watchlist item) does NOT appear in the live app.
2. Supervised first sweep: run `/qa-deep-sweep zones=today` interactively, inspect findings quality, tune the charter wording before unleashing all 7 zones.
3. First full nightly run reviewed the next morning; tune severity rubric / NOT-a-finding list from false positives.
4. Week 2: flip `mode: rotate` and compare signal.

## Risks / accepted trade-offs

- **Finding quality depends on charter wording** — expected to need 1-2 tuning passes from real false positives. The NOT-a-finding list is the main lever.
- **Sandbox ≠ Electron** — `SettingsModal` is Electron-only and TWS paths are dead in the sandbox; zone charters know this, so Electron-specific UX is out of scope for the nightly sweep.
- **Cost variance** — exploratory agents don't have fixed budgets; the run summary logs agent counts/durations so week-1 actuals inform the week-2 decision.
- **2:45 AM requires the Mac awake** — same constraint as every existing launchd job; no new exposure.
