# Nightly Deep QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A nightly exploratory QA sweep where parallel browser agents use a sandboxed copy of Portfolio Desk like the owner would, file deduped findings into a persistent ledger, Pushover on new findings, and auto-fix only objective breakage on a review branch.

**Architecture:** `qa/nightly-deep-qa.sh` (launchd, 2:45 AM local) boots a sandbox — `VACUUM INTO` DB copy + the *deployed* Electron standalone server on :3097 with an explicit env allowlist (no outbound keys) — then invokes headless Claude (`claude -p "/qa-deep-sweep"`). The skill dispatches parallel agent-browser zone agents with a "synthetic owner" charter, merges findings into `qa/findings/ledger.json` (deduped, status-tracked), regenerates `FINDINGS.md`, fires Pushover for new findings, and runs a fix pass for `auto_fixable` ones on branch `qa-deep-fixes-YYYY-MM-DD`.

**Tech Stack:** bash, sqlite3 CLI, Next.js standalone server, Claude Code CLI (`claude -p`), agent-browser subagents, launchd, Pushover REST.

**Spec:** `docs/superpowers/specs/2026-06-10-nightly-deep-qa-design.md`

---

### Task 1: Public-repo leak remediation + gitignore groundwork

`qa/expected-values.json` is tracked in the **public** repo with the real portfolio total. Untrack it (file stays on disk — `run-qa.sh` keeps working) and ignore all deep-QA data dirs.

**Files:**
- Modify: `qa/.gitignore`
- Untrack: `qa/expected-values.json`

- [ ] **Step 1: Untrack the baseline file**

```bash
cd /Users/Yitzi/code/vanguard-skin
git rm --cached qa/expected-values.json
```

- [ ] **Step 2: Extend qa/.gitignore**

Replace the contents of `qa/.gitignore` (currently `screenshots/`, `reports/`, `logs/`) with:

```gitignore
screenshots/
reports/
logs/
expected-values.json
findings/
sandbox/
```

- [ ] **Step 3: Verify ignore status**

Run: `git check-ignore qa/expected-values.json qa/findings/x qa/sandbox/x && git status --short qa/`
Expected: all three paths print (ignored); status shows only the deletion of the tracked copy + modified `.gitignore`.

- [ ] **Step 4: Commit**

```bash
git add qa/.gitignore
git commit -m "fix(qa): untrack expected-values.json — real portfolio values were in the public repo

File stays on disk for run-qa.sh; findings/ and sandbox/ pre-ignored for
the deep-QA system (public repo — findings text and screenshots will
contain tickers and dollar values)."
```

Note for the owner (do not act without instruction): git history still contains past versions of `expected-values.json`. A history scrub (git-filter-repo, precedent 2026-04-07) is the owner's call.

---

### Task 2: Config + findings bootstrap

**Files:**
- Create: `qa/deep-qa-config.json` (tracked)
- Create: `qa/findings/ledger.json` (gitignored, local bootstrap)

- [ ] **Step 1: Write qa/deep-qa-config.json**

```json
{
  "mode": "all",
  "rotation": {
    "Mon": "today",
    "Tue": "analysis",
    "Wed": "research",
    "Thu": "security-detail",
    "Fri": "import-settings",
    "Sat": "mobile",
    "Sun": "accounts-charts-calendar"
  },
  "maxConcurrentAgents": 4
}
```

- [ ] **Step 2: Bootstrap the ledger**

```bash
mkdir -p qa/findings/screenshots qa/findings/runs
echo '{ "findings": [] }' > qa/findings/ledger.json
```

- [ ] **Step 3: Commit**

```bash
git add qa/deep-qa-config.json
git commit -m "feat(qa): deep-QA config — mode all/rotate, zone rotation map, concurrency"
```

---

### Task 3: Sandbox lifecycle script

**Files:**
- Create: `qa/sandbox.sh` (tracked, executable)

- [ ] **Step 1: Write qa/sandbox.sh**

```bash
#!/usr/bin/env bash
# Sandbox lifecycle for the nightly deep QA sweep.
#   up   — snapshot the live DB (VACUUM INTO) and boot the DEPLOYED Electron
#          standalone server on :3097 with an explicit env allowlist.
#          No outbound keys (Resend/Pushover/Gmail/Worker) are passed, so the
#          sandbox cannot send anything real. DATABASE_PATH (lib/db.ts:11)
#          points every DB read/write at the throwaway copy.
#   down — kill the sandbox server by PID file and delete qa/sandbox/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SANDBOX_DIR="$SCRIPT_DIR/sandbox"
DB_COPY="$SANDBOX_DIR/vanguard-qa.db"
PID_FILE="$SANDBOX_DIR/server.pid"
LOG_FILE="$SANDBOX_DIR/server.log"
PORT=3097
STANDALONE="/Applications/Vanguard Dashboard.app/Contents/Resources/standalone"

up() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Sandbox already running (PID $(cat "$PID_FILE"))"; return 0
  fi
  if [ ! -f "$STANDALONE/server.js" ]; then
    echo "ERROR: deployed standalone server not found at $STANDALONE" >&2; exit 1
  fi

  mkdir -p "$SANDBOX_DIR"
  rm -f "$DB_COPY"
  # Clean point-in-time copy; safe while Electron holds the WAL.
  sqlite3 "$PROJECT_DIR/data/vanguard.db" "VACUUM INTO '$DB_COPY'"
  echo "DB snapshot: $DB_COPY ($(du -h "$DB_COPY" | cut -f1))"

  # Pull ONLY the keys the sandbox is allowed to have from .env.local.
  # Outbound (RESEND/PUSHOVER/GMAIL/WORKER_MARKER_URL/CRON secret) is
  # deliberately absent — all those surfaces no-op gracefully when unset.
  local anthropic finnhub fred
  anthropic="$(grep -m1 '^ANTHROPIC_API_KEY=' "$PROJECT_DIR/.env.local" 2>/dev/null | cut -d= -f2- || true)"
  finnhub="$(grep -m1 '^FINNHUB_API_KEY=' "$PROJECT_DIR/.env.local" 2>/dev/null | cut -d= -f2- || true)"
  fred="$(grep -m1 '^FRED_API_KEY=' "$PROJECT_DIR/.env.local" 2>/dev/null | cut -d= -f2- || true)"

  (
    cd "$STANDALONE"
    env -i HOME="$HOME" PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
      NODE_ENV=production PORT="$PORT" HOSTNAME=127.0.0.1 \
      DATABASE_PATH="$DB_COPY" \
      ${anthropic:+ANTHROPIC_API_KEY="$anthropic"} \
      ${finnhub:+FINNHUB_API_KEY="$finnhub"} \
      ${fred:+FRED_API_KEY="$fred"} \
      node server.js > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
  )

  for i in $(seq 1 30); do
    if curl -sf "http://localhost:$PORT/api/summary" > /dev/null 2>&1; then
      echo "Sandbox up on :$PORT (PID $(cat "$PID_FILE"))"; return 0
    fi
    sleep 1
  done
  echo "ERROR: sandbox server did not become healthy in 30s — see $LOG_FILE" >&2
  down; exit 1
}

down() {
  if [ -f "$PID_FILE" ]; then
    local pid; pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then kill "$pid"; sleep 1; fi
  fi
  rm -rf "$SCRIPT_DIR/sandbox"
  echo "Sandbox down"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "Usage: qa/sandbox.sh up|down" >&2; exit 1 ;;
esac
```

- [ ] **Step 2: Make executable and boot it**

Run: `chmod +x qa/sandbox.sh && bash qa/sandbox.sh up`
Expected: `DB snapshot: …` then `Sandbox up on :3097 (PID …)`.

- [ ] **Step 3: Verify mutation isolation (the critical safety check)**

```bash
curl -s -X POST http://localhost:3097/api/watchlist -H 'Content-Type: application/json' -d '{"symbol":"QASANDBOX"}' | head -c 200; echo
sqlite3 qa/sandbox/vanguard-qa.db "SELECT COUNT(*) FROM securities WHERE symbol='QASANDBOX';"
sqlite3 data/vanguard.db "SELECT COUNT(*) FROM securities WHERE symbol='QASANDBOX';"
```

Expected: sandbox DB count `1` (or the API's validation error — either proves the request hit the sandbox), **live DB count `0` always**. If live count is ever 1, STOP — the env override failed.

- [ ] **Step 4: Verify outbound is stripped**

Run: `curl -s -X POST http://localhost:3097/api/digest/email -H 'Content-Type: application/json' -d '{}' | head -c 300; echo`
Expected: a graceful error/no-op response about missing email config — NOT a sent email. (Outbound keys were never passed to the process; `env -i` guarantees nothing leaked from the parent shell.)

- [ ] **Step 5: Tear down and verify cleanup**

Run: `bash qa/sandbox.sh down && ls qa/sandbox 2>&1; lsof -nP -iTCP:3097 -sTCP:LISTEN | wc -l`
Expected: `No such file or directory` and `0` listeners.

- [ ] **Step 6: Commit**

```bash
git add qa/sandbox.sh
git commit -m "feat(qa): sandbox lifecycle — VACUUM INTO DB copy + deployed standalone on :3097 with env allowlist"
```

---

### Task 4: Pushover notifier script

**Files:**
- Create: `scripts/qa-pushover.sh` (tracked, executable)

- [ ] **Step 1: Write scripts/qa-pushover.sh**

```bash
#!/usr/bin/env bash
# Send a Pushover notification for deep-QA findings.
# Usage: scripts/qa-pushover.sh "message text"
# Reads PUSHOVER_APP_TOKEN + PUSHOVER_USER_KEY from .env.local.
# No-ops (exit 0) when keys are missing — never blocks the QA run.
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MSG="${1:?usage: qa-pushover.sh \"message\"}"

TOKEN="$(grep -m1 '^PUSHOVER_APP_TOKEN=' "$PROJECT_DIR/.env.local" 2>/dev/null | cut -d= -f2- || true)"
USERKEY="$(grep -m1 '^PUSHOVER_USER_KEY=' "$PROJECT_DIR/.env.local" 2>/dev/null | cut -d= -f2- || true)"

if [ -z "$TOKEN" ] || [ -z "$USERKEY" ]; then
  echo "qa-pushover: keys missing — skipping notification"; exit 0
fi

curl -s --max-time 15 \
  --form-string "token=$TOKEN" \
  --form-string "user=$USERKEY" \
  --form-string "title=Portfolio Desk Deep QA" \
  --form-string "message=$MSG" \
  https://api.pushover.net/1/messages.json > /dev/null \
  && echo "qa-pushover: sent" || echo "qa-pushover: send failed (non-fatal)"
```

- [ ] **Step 2: Test it live**

Run: `chmod +x scripts/qa-pushover.sh && bash scripts/qa-pushover.sh "Deep QA test — ignore"`
Expected: `qa-pushover: sent` and a push arrives on the phone.

- [ ] **Step 3: Commit**

```bash
git add scripts/qa-pushover.sh
git commit -m "feat(qa): Pushover notifier for deep-QA findings (no-op without keys)"
```

---

### Task 5: The orchestrator skill

**Files:**
- Create: `.claude/skills/qa-deep-sweep/SKILL.md` (tracked)

- [ ] **Step 1: Write .claude/skills/qa-deep-sweep/SKILL.md**

````markdown
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

Dispatch one `agent-browser` subagent per zone, max `maxConcurrentAgents` (4) concurrently. Each gets this charter with its zone scope substituted:

> You are the owner of Portfolio Desk using the app for real at http://localhost:3097. This is a disposable sandbox: clicking, submitting, and deleting are safe and ENCOURAGED. Your zone: [ZONE SCOPE]. Click every control, open every modal/dropdown/expander, submit every form with plausible values, follow every flow to its end state, and watch the browser console throughout. After every mutation, verify the effect actually landed (re-read the UI or re-navigate) — a success toast with no effect is a finding.
>
> A FINDING is anything a daily user would experience as broken or untrustworthy: a click that visibly does nothing; an error or failed network request (4xx/5xx) on a user action; a dead-end (404, blank panel, empty state with no explanation); rendered `NaN` / `undefined` / `Invalid Date` / `$NaN`; a spinner that never resolves (>15s); a control whose feedback claims success but whose effect didn't happen; a broken layout (overlap, clipped text, unreachable button).
>
> NOT a finding: TWS-connection-dependent gaps (sync buttons, live quotes — TWS is intentionally absent here); data staleness inherent to the sandbox snapshot; Electron-only surfaces correctly explaining themselves (SettingsModal is invisible in browser by design); pure matters of taste with no functional impact. Do NOT click TWS connect/sync controls — that's infrastructure, not UX under test.
>
> For each finding take a screenshot (save to qa/findings/screenshots/, filename = a short slug of the finding). Return ONLY a JSON object: `{"findings": [{"surface": "...", "title": "...", "severity": "high|medium|low", "repro": ["..."], "expected": "...", "actual": "...", "console_errors": ["..."], "screenshot": "qa/findings/screenshots/<slug>.png", "auto_fixable": true|false}]}`.
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
````

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/qa-deep-sweep/SKILL.md
git commit -m "feat(qa): /qa-deep-sweep orchestrator skill — zone charters, ledger dedup, pushover, fix-pass rules"
```

---

### Task 6: Supervised single-zone shakedown (checkpoint — do this before wiring cron)

**Files:** none (verification only)

- [ ] **Step 1: Boot sandbox**

Run: `bash qa/sandbox.sh up`
Expected: `Sandbox up on :3097`.

- [ ] **Step 2: Run one zone interactively**

In a Claude Code session (not headless): invoke `/qa-deep-sweep` with args `zones=today`. Watch: agent dispatch works, findings JSON parses, ledger + FINDINGS.md are written, screenshots land in `qa/findings/screenshots/`.

- [ ] **Step 3: Quality review with the owner**

Read `qa/findings/FINDINGS.md` together. For each finding ask: would the owner consider this real? Tune the charter's NOT-a-finding list in SKILL.md based on false positives. Commit any charter edits:

```bash
git add .claude/skills/qa-deep-sweep/SKILL.md
git commit -m "chore(qa): tune deep-sweep charter from first supervised run"
```

- [ ] **Step 4: Tear down**

Run: `bash qa/sandbox.sh down`

---

### Task 7: Cron wrapper + launchd plist

**Files:**
- Create: `qa/nightly-deep-qa.sh` (tracked, executable)
- Create: `~/Library/LaunchAgents/com.vanguard-skin.nightly-deep-qa.plist`
- Create: `docs/launchd/com.vanguard-skin.nightly-deep-qa.plist` (tracked mirror)

- [ ] **Step 1: Write qa/nightly-deep-qa.sh**

```bash
#!/usr/bin/env bash
# Nightly deep QA — sandbox up, headless /qa-deep-sweep, sandbox down.
# Scheduled by com.vanguard-skin.nightly-deep-qa.plist at 2:45 AM local.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$PROJECT_DIR"

echo "=== Deep QA run $(date '+%Y-%m-%d %H:%M:%S') ==="

if ! command -v claude &>/dev/null; then
  echo "ERROR: claude CLI not on PATH — aborting"; exit 1
fi

bash "$SCRIPT_DIR/sandbox.sh" up || { echo "ERROR: sandbox boot failed"; exit 1; }
trap 'bash "$SCRIPT_DIR/sandbox.sh" down' EXIT

claude -p "/qa-deep-sweep"
STATUS=$?

echo "=== Deep QA finished (claude exit $STATUS) $(date '+%Y-%m-%d %H:%M:%S') ==="
exit $STATUS
```

- [ ] **Step 2: Write the plist (both copies — identical content)**

`docs/launchd/com.vanguard-skin.nightly-deep-qa.plist` AND `~/Library/LaunchAgents/com.vanguard-skin.nightly-deep-qa.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.vanguard-skin.nightly-deep-qa</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>/Users/Yitzi/code/vanguard-skin/qa/nightly-deep-qa.sh</string>
	</array>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>2</integer>
		<key>Minute</key>
		<integer>45</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>/Users/Yitzi/Library/Logs/vanguard-nightly-deep-qa.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/Yitzi/Library/Logs/vanguard-nightly-deep-qa.log</string>
</dict>
</plist>
```

Note: `StartCalendarInterval` at local time is deliberate here (Mac-idle gating, not market hours) — documented exception to the et-gate rule, same as the existing 2:00 smoke job.

- [ ] **Step 3: Lint + load**

```bash
chmod +x qa/nightly-deep-qa.sh
plutil -lint ~/Library/LaunchAgents/com.vanguard-skin.nightly-deep-qa.plist
launchctl load ~/Library/LaunchAgents/com.vanguard-skin.nightly-deep-qa.plist
launchctl list | grep nightly-deep-qa
```

Expected: `OK`, then the label listed.

- [ ] **Step 4: Commit**

```bash
git add qa/nightly-deep-qa.sh docs/launchd/com.vanguard-skin.nightly-deep-qa.plist
git commit -m "feat(qa): nightly deep-QA cron wrapper + 2:45 AM launchd plist (local-time by design)"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md` (launchd jobs list — add one bullet after `com.vanguard-skin.nightly-qa.plist`)
- Modify: `/Users/Yitzi/.claude/projects/-Users-Yitzi-code-vanguard-skin/memory/project_nightly_qa.md` (add deep-sweep section)

- [ ] **Step 1: CLAUDE.md bullet**

After the `com.vanguard-skin.nightly-qa.plist` line in the launchd list, add:

```markdown
  - `com.vanguard-skin.nightly-deep-qa.plist` — Daily 2:45 AM local, exploratory "synthetic owner" QA sweep: sandboxed DB copy + deployed standalone on :3097 (`qa/sandbox.sh`), headless `/qa-deep-sweep` skill dispatches parallel zone agents, findings dedupe into `qa/findings/ledger.json` (+`FINDINGS.md`), Pushover only on NEW findings, auto-fix branch `qa-deep-fixes-*` for objective breakage only (never pushed). Config: `qa/deep-qa-config.json` (`mode: all|rotate`). All findings artifacts are gitignored (public repo). See `memory/project_nightly_qa.md`.
```

- [ ] **Step 2: Update the memory topic file**

Append to `project_nightly_qa.md`: a "Deep sweep (2026-06-10)" section mirroring the CLAUDE.md bullet plus: ledger statuses (`new|known|fixed|wontfix` — owner sets `wontfix` to silence), the week-2 cost switch (`mode: rotate`), and the leak remediation note (expected-values.json untracked; history scrub pending owner decision).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: register nightly deep-QA job in CLAUDE.md launchd list"
```

---

### Task 9: Full-sweep dress rehearsal

**Files:** none (verification only)

- [ ] **Step 1: Trigger the real job end-to-end**

Run: `launchctl start com.vanguard-skin.nightly-deep-qa && tail -f ~/Library/Logs/vanguard-nightly-deep-qa.log`
Expected: sandbox boots, claude runs all 7 zones, ledger/FINDINGS.md/run-summary written, sandbox torn down, exit 0. (This is the expensive run — ~$5-15. Acceptable: it's the week-1 mode anyway.)

- [ ] **Step 2: Post-run checks**

```bash
ls qa/sandbox 2>&1                      # gone
lsof -nP -iTCP:3097 -sTCP:LISTEN | wc -l  # 0
git branch --list 'qa-deep-fixes-*'     # exists only if auto-fixables were found
git status --short                       # clean main (fix work only on branch)
cat qa/findings/runs/$(date +%Y-%m-%d).md
```

- [ ] **Step 3: Owner review**

Walk `qa/findings/FINDINGS.md` with the owner; mark any judgment-call entries `wontfix` in the ledger; note charter tunings for tomorrow.
