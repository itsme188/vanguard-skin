# QA Auto-Fix Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nightly fixer chained after the deep-QA sweep that turns open ledger findings into shipped fixes — auto-merging qualifying ones, PR-ing the rest, and tagging product decisions for the user — plus landing the currently stranded fixes and the drawer z-index bug as pre-steps.

**Architecture:** A new `/qa-fix-findings` project skill (headless-invocable, dry-run capable) reads `qa/findings/ledger.json`, classifies findings (`auto` / `needs-decision` / `needs-repro`), fixes capped-per-night in a persistent sibling worktree, cherry-picks auto-merge-eligible commits to main and the rest onto a sanitized PR branch, then conditionally runs `electron:deploy`. `qa/nightly-deep-qa.sh` gains a chain block (gated by a `fixer.enabled` config flag, shipped **disarmed**) that invokes the skill after the sweep's completeness guard passes.

**Tech Stack:** Bash (macOS 3.2!), project skill markdown, python3 for ledger JSON edits, existing `pick_model` / `notify_failure` idioms, git worktree, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-07-26-qa-auto-fix-pipeline-design.md`

## Global Constraints

- macOS `/bin/bash` is 3.2 — no `${var,,}`, no associative arrays, no heredoc apostrophes; run `bash -n` after every shell edit.
- Commit messages via temp file + `git commit -F` — never inline `-m`. End with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Public repo: no dollar values, position sizes, or screenshots in anything committed or pushed (commit messages, PR bodies, branch names). `qa/findings/**` is gitignored — keep it that way; `DECISIONS-PENDING.md` and `fix-runs/` live inside it.
- Never touch the live `data/vanguard.db` from QA tooling — DB copies via `sqlite3 ... "VACUUM INTO ..."` only.
- Ports: fixer verification dev server = **:3096** (sandbox holds :3097, Electron :3099, dev :3000).
- `gh pr create` bodies via `--body-file` (backtick shell-error rule).
- Full test suite = `npx vitest run` (~3800 tests) + `npx tsc --noEmit`; Worker changes additionally need `cd workers/cron && npx vitest run`.
- The fixer may only mark a finding `fixed` together with a real `fix_commit` hash; non-repro closures are exclusively the sweep's job.

---

### Task 1: Land the two stranded `qa-deep-fixes-*` branches

**Files:**
- Modify: none directly (merges of existing branches `qa-deep-fixes-2026-07-23`, `qa-deep-fixes-2026-07-26`)

**Interfaces:**
- Consumes: branches already on the local repo (verify with `git branch`).
- Produces: both branches merged to `main` and deleted — precondition for Task 5's anti-strand guard reporting a clean slate.

- [ ] **Step 1: Review both branch diffs**

Run:
```bash
git log --oneline main..qa-deep-fixes-2026-07-23   # expect 1 commit: 77b2118 import NaN message fix
git log --oneline main..qa-deep-fixes-2026-07-26   # expect 4 commits: SecurityChart markers-plugin, MacroOverlayCard dead-click, TrustStrip dates, NotesAmbient rail offset
git diff main...qa-deep-fixes-2026-07-23
git diff main...qa-deep-fixes-2026-07-26
```
Read each diff fully. These were written by the nightly sweep agent against the *deployed* build's repo state — check each hunk still applies sensibly to current `main` (no logic superseded by later main commits). If a hunk is superseded, drop that commit from the merge (cherry-pick the others instead of merging) and note it in the Task commit message.

- [ ] **Step 2: Merge the 07-23 branch and run the suite**

```bash
git merge --no-ff qa-deep-fixes-2026-07-23 -m "merge: land stranded qa-deep-fixes-2026-07-23 (import NaN validation message)"
npx vitest run tests/import/validate.test.ts
```
Expected: merge clean (touches only `lib/import/validate.ts` + its test), validate tests PASS.

- [ ] **Step 3: Merge the 07-26 branch**

```bash
git merge --no-ff qa-deep-fixes-2026-07-26 -m "merge: land stranded qa-deep-fixes-2026-07-26 (chart markers plugin, macro-theme dead click, trust-strip dates, ambient FAB rail offset)"
```
If conflicts arise (SecurityChart and MacroOverlayCard are actively developed), resolve preferring the branch's *intent* re-applied onto main's current code, not a blind take-theirs.

- [ ] **Step 4: Full suite + typecheck**

```bash
npx vitest run
npx tsc --noEmit
```
Expected: all tests pass (baseline ~3803+), tsc clean. If red: fix forward if trivial, otherwise revert the offending merge and record why in the plan notes — do NOT leave main red.

- [ ] **Step 5: Delete the branches**

```bash
git branch -d qa-deep-fixes-2026-07-23 qa-deep-fixes-2026-07-26
```

---

### Task 2: Drawer z-index fix (HIGH ledger finding, 4th sighting)

**Files:**
- Modify: `app/dashboard/components/analysis/MacroThemeReceiptDrawer.tsx:49`
- Modify: `app/dashboard/components/analysis/DrillDownPanel.tsx:127,133`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: fix commit hash — Task 6's dry-run should classify finding `analysis-drawers--view-sources-drawer-renders-behind-chat-rail-regression-2` as already-fixed-awaiting-deploy rather than attempting it.

Context: the chat rail (`ChatDrawer`) renders at `z-50`; both analysis drawers also use `z-50`, so DOM order decides stacking and they lose. `TrustStripDrawer.tsx:341` already uses `fixed inset-0 z-[55]` and is unaffected — that is the precedent. The DrillDownPanel splits backdrop (`z-40`) and panel (`z-50`) into siblings, so both must rise (backdrop above rail too, else backdrop-click hits the rail — the "un-dismissable" symptom).

- [ ] **Step 1: Apply the two edits**

`MacroThemeReceiptDrawer.tsx` line 49: `className="fixed inset-0 z-50 flex"` → `className="fixed inset-0 z-[55] flex"`

`DrillDownPanel.tsx` line 127: `className="fixed inset-0 bg-black/40 z-40"` → `className="fixed inset-0 bg-black/40 z-[54]"`
`DrillDownPanel.tsx` line 133: `... bottom-0 z-50 w-full ...` → `... bottom-0 z-[55] w-full ...`

- [ ] **Step 2: Browser-verify with the chat rail open**

Start dev server if not running (`npm run dev`, :3000). Dispatch an agent-browser subagent: desktop 1440×900, open `/dashboard/analysis` with chat rail expanded (default), click "View sources →" on a macro theme → assert the drawer aside is visible and its Close button clickable (`document.elementFromPoint` over the drawer center returns a drawer descendant, not the chat rail); repeat for Diagnostics → "View top 10 by risk →"; verify Escape closes the drill-down.
Expected: both drawers render above the rail, dismissable.

- [ ] **Step 3: Run suite (fast sanity — CSS-only change)**

```bash
npx tsc --noEmit && npx vitest run tests/contracts
```
Expected: clean.

- [ ] **Step 4: Commit and record the fix in the ledger (anti-bounce discipline)**

Commit (via `-F` temp file):
```
fix(analysis): lift receipt + drill-down drawers above the chat rail (z-[55], trust-strip precedent)

4th-sighting QA finding: both drawers rendered at z-50, tied with the chat
rail, so stacking order hid them and backdrop/Escape appeared inert.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```
Then update the (gitignored) ledger entry with the real commit hash:
```bash
python3 - "$(git rev-parse --short HEAD)" <<'EOF'
import json, sys
p = "qa/findings/ledger.json"
d = json.load(open(p))
for f in d["findings"]:
    if f["id"] == "analysis-drawers--view-sources-drawer-renders-behind-chat-rail-regression-2":
        f["status"] = "fixed"; f["fix_commit"] = sys.argv[1]
        f["fix_note"] = "z-[55] on MacroThemeReceiptDrawer + DrillDownPanel (backdrop z-[54]); trust-strip precedent. Fixed on main; clears in deployed build after next electron:deploy."
json.dump(d, open(p, "w"), indent=1)
EOF
```

---

### Task 3: Shared Pushover helper + fixer config block

**Files:**
- Create: `qa/lib/pushover.sh`
- Modify: `qa/deep-qa-config.json`

**Interfaces:**
- Consumes: Pushover tokens from `~/Library/Application Support/Vanguard Dashboard/settings.json` (launchd does not load `.env.local` — same source `notify_failure` uses).
- Produces: `qa_pushover "<title>" "<message>"` bash function (sourced), and config keys `fixer.enabled` (bool), `fixer.dryRun` (bool), `fixer.maxFixesPerNight` (int), `fixer.autoMergeSeverities` (string[]), `fixer.verifyPort` (int) — read by Task 4's SKILL.md and Task 5's chain block.

- [ ] **Step 1: Write `qa/lib/pushover.sh`**

```bash
#!/usr/bin/env bash
# Shared Pushover sender for QA tooling. Tokens come from the Electron
# settings.json because launchd jobs do NOT load .env.local (same sourcing
# as nightly-deep-qa.sh::notify_failure). Silent no-op when unconfigured.
# Usage: source qa/lib/pushover.sh; qa_pushover "Title" "message body"
qa_pushover() {
  local title="$1" msg="$2"
  local cfg="$HOME/Library/Application Support/Vanguard Dashboard/settings.json"
  [ -f "$cfg" ] || return 0
  local tok usr
  tok=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('pushoverAppToken','') or '')" "$cfg" 2>/dev/null) || return 0
  usr=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('pushoverUserKey','') or '')" "$cfg" 2>/dev/null) || return 0
  [ -n "$tok" ] && [ -n "$usr" ] || return 0
  curl -s --max-time 10 \
    --form-string "token=$tok" --form-string "user=$usr" \
    --form-string "title=$title" \
    --form-string "message=$msg" \
    https://api.pushover.net/1/messages.json >/dev/null 2>&1 || true
}
```

- [ ] **Step 2: Validate the shell**

```bash
bash -n qa/lib/pushover.sh
```
Expected: no output (clean parse).

- [ ] **Step 3: Add the `fixer` block to `qa/deep-qa-config.json`**

New full file content:
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
  "maxConcurrentAgents": 1,
  "fixer": {
    "enabled": false,
    "dryRun": false,
    "maxFixesPerNight": 4,
    "autoMergeSeverities": ["low"],
    "verifyPort": 3096
  }
}
```
`enabled: false` is the arming gate — flipped only after the supervised-runs milestone (Task 6 + a later session).

- [ ] **Step 4: Validate JSON + commit both files**

```bash
python3 -m json.tool qa/deep-qa-config.json >/dev/null && echo OK
```
Commit: `feat(qa): shared Pushover helper + fixer config block (disarmed)`

---

### Task 4: The `/qa-fix-findings` skill

**Files:**
- Create: `.claude/skills/qa-fix-findings/SKILL.md`

**Interfaces:**
- Consumes: `qa/findings/ledger.json` (fields: `id`, `severity`, `status`, `repro`, `expected`, `actual`, `note`/`fix_note`, `auto_fixable`, `fix_commit`), `qa/deep-qa-config.json` `fixer` block (Task 3), `qa/lib/pushover.sh::qa_pushover` (Task 3).
- Produces: ledger fields written per finding — `disposition` (`"auto" | "needs-decision" | "needs-repro"`), `decision_options` (array of `{option, tradeoff}` + `recommendation` string), `fix_commit`, `fix_status` (`"merged" | "pr-open" | "merged-awaiting-deploy"`); `qa/findings/DECISIONS-PENDING.md`; `qa/findings/fix-runs/YYYY-MM-DD.md` (the run log Task 5's completeness guard checks); Pushover summary; branch `qa-auto-fixes-YYYY-MM-DD` + PR when applicable.

- [ ] **Step 1: Write the skill file with exactly this content**

````markdown
---
name: qa-fix-findings
description: Turn open deep-QA ledger findings into shipped fixes — classify (auto / needs-decision / needs-repro), TDD-fix in a worktree under a per-night cap, auto-merge qualifying fixes to main, open a sanitized PR for the rest, then conditionally electron:deploy. Chained nightly after /qa-deep-sweep; also invocable interactively. QA_FIX_DRY_RUN=1 (or config fixer.dryRun) classifies and plans only, no code changes.
---

# QA Fix Findings

Spec: `docs/superpowers/specs/2026-07-26-qa-auto-fix-pipeline-design.md`. Ledger: `qa/findings/ledger.json`. Config: the `fixer` block of `qa/deep-qa-config.json`.

## Hard rules — read before anything else

1. **You may set `status: "fixed"` on a finding ONLY together with a `fix_commit` hash that exists on `main` or on tonight's `qa-auto-fixes-*` branch.** Never close a finding as non-reproducing — non-repro closure is exclusively the sweep's job. If you cannot reproduce, set `disposition: "needs-repro"` and move on.
2. **Never write code for a `needs-decision` finding.** Write 2–3 options + a recommendation into the ledger instead.
3. **Two fix attempts per finding, then stop** (global working rule). A resisting finding gets a ledger note describing both attempts and stays open.
4. **Public repo:** no dollar values, position sizes, screenshots, or ledger prose in commit messages, branch names, or PR bodies. Finding IDs + generic one-line descriptions only.
5. **Never touch the live `data/vanguard.db`.** Verification DBs come from `sqlite3 data/vanguard.db "VACUUM INTO '<worktree>/data/vanguard.db'"`.
6. **All code work happens in the worktree** (`../vanguard-skin-qa-fix`); the main checkout is used only for cherry-picks, merges, push, and deploy.
7. **Hard PR-only exclusions** regardless of severity: any fix touching `lib/db/migrations/`, any email send path (`lib/email.ts`, `lib/digest/`, `lib/calendar/briefing*`, `workers/cron/src/`), or any `lib/mutations/` data-write path goes to the PR, never auto-merge.
8. Every abort path must send a Pushover (`source qa/lib/pushover.sh; qa_pushover "QA fixer" "<what died>"`) — silence is the historically proven failure mode.

## Step 0 — Preflight

1. Read the `fixer` config block. Dry-run mode = `QA_FIX_DRY_RUN=1` env OR `fixer.dryRun: true`.
2. **Anti-strand guard:** run `git branch --list 'qa-auto-fixes-*' --list 'qa-deep-fixes-*'` and `gh pr list --state open --search "qa-auto-fixes"` from the main checkout. For every unmerged branch/PR: record it for the summary, and mark its findings SKIP for tonight (a fix already exists unmerged — re-fixing it forks the work). Identify covered findings by the `[qa:<finding-id>]` trailer in the branch's commit messages (`git log main..<branch> --format=%B`).
3. Load `qa/findings/ledger.json`. Working set = findings with `status` in (`new`, `known`) that are not covered by an unmerged branch. Ignore `wontfix` and `fixed`.

## Step 1 — Classify every finding in the working set

For each finding, read the referenced code (the ledger notes usually name components/queries; use them) and assign exactly one `disposition`:

- **`auto`** — the root cause is knowable from code + ledger notes, and the fix does not change product behavior beyond what the finding describes. Ledger notes that already prescribe the exact fix (a named component + named change) are the strongest signal.
- **`needs-decision`** — fixing requires choosing between product alternatives (data-source choices, column additions vs relabels, UX redesigns). Write `decision_options`: 2–3 entries of `{option, tradeoff}` plus a `recommendation` string. NO code.
- **`needs-repro`** — the ledger describes a symptom you cannot confirm against current code/data. Leave everything else untouched.

Write dispositions to the ledger immediately (checkpoint pattern — one python3 edit per finding, not one batch at the end). Then regenerate `qa/findings/DECISIONS-PENDING.md`: one section per `needs-decision` finding — title, one-paragraph problem statement, the options with trade-offs, your recommendation. Overwrite the whole file each run (it is derived state).

**Dry-run stops after this step:** write the fix-run log (see Step 6, with `mode: dry-run`), print a disposition table to stdout, send the Pushover summary, and finish. No worktree, no code.

## Step 2 — Worktree setup

Persistent sibling worktree (survives across nights so `node_modules` persists):

```bash
WT="$(git rev-parse --show-toplevel)/../vanguard-skin-qa-fix"
if [ -d "$WT" ]; then
  git -C "$WT" fetch --no-tags origin
  git -C "$WT" checkout -B "qa-fix-work-$(date +%Y%m%d)" main
  git -C "$WT" clean -fd
else
  git worktree add "$WT" -b "qa-fix-work-$(date +%Y%m%d)" main
fi
[ -d "$WT/node_modules" ] || (cd "$WT" && npm install)
mkdir -p "$WT/data" && rm -f "$WT/data/vanguard.db" && sqlite3 data/vanguard.db "VACUUM INTO '$WT/data/vanguard.db'"
```

Never nest the worktree inside the repo; never run two dev servers against the same directory.

## Step 3 — Fix loop

Order: severity HIGH → MEDIUM → LOW within `disposition: auto`. Stop after `maxFixesPerNight` attempts (an attempt = a finding you started, whether it succeeded or not).

Per finding:
1. **TDD when the behavior is testable** (queries, computes, API routes, formatting): write the failing test in the worktree first, watch it fail, implement, watch it pass. Follow project conventions (in-memory SQLite DI, `tests/` layout).
2. **Browser-symptom findings** (layout, z-index, overlays): implement, then verify by booting a dev server FROM THE WORKTREE on the config `verifyPort`:
   ```bash
   cd "$WT" && ANTHROPIC_API_KEY= RESEND_API_KEY= GMAIL_APP_PASSWORD= FINNHUB_API_KEY= \
     PUSHOVER_APP_TOKEN= PUSHOVER_USER_KEY= CRON_SHARED_SECRET= WORKER_MARKER_URL= \
     PORT=3096 npm run dev
   ```
   (Env keys pinned EMPTY the way `qa/sandbox.sh` pins its allowlist — verification must be unable to send real email/push or call paid APIs. The :3097 sandbox serves the *deployed* build and cannot verify new code.) Use agent-browser against `http://localhost:3096` to confirm the specific ledger symptom is gone. Kill the dev server by PID afterwards.
3. **Suite gate per finding:** `npx vitest run` + `npx tsc --noEmit` in the worktree (plus `workers/cron` tests if `workers/` was touched). Red suite ⇒ revert the finding's changes (`git checkout -- .` of its files), record attempt, count it.
4. **Commit per finding** in the worktree (temp-file `-F` message):
   `fix(<area>): <generic one-line description> [qa:<finding-id>]` — the `[qa:...]` trailer is what the anti-strand guard greps for. No values from the ledger in the message.
5. **Checkpoint the ledger** after each finding (fix or failed attempt) before starting the next.

## Step 4 — Gate and deliver

Classify each successful fix commit:

**Auto-merge eligible** iff ALL of:
- `severity` ∈ config `autoMergeSeverities`, OR the ledger note prescribed the exact fix you applied (named component + named change);
- full suite green + tsc clean (already true from Step 3);
- browser verification (when applicable) confirmed the symptom gone;
- none of the Hard-rule-7 exclusion paths touched.

Delivery from the MAIN checkout:
```bash
# auto-merge set
git cherry-pick <hash>...            # each eligible commit, in order
# PR set (only if non-empty)
git checkout -b "qa-auto-fixes-$(date +%Y-%m-%d)" main
git cherry-pick <hash>...            # each PR-bound commit
git push -u origin "qa-auto-fixes-$(date +%Y-%m-%d)"
gh pr create --title "QA auto-fixes $(date +%Y-%m-%d)" --body-file /tmp/qa-pr-body.md
git checkout main
```
PR body template (`/tmp/qa-pr-body.md`) — IDs and generic descriptions only:
```
## Nightly QA auto-fixes YYYY-MM-DD

Automated fixes for deep-QA ledger findings (details live in the local,
gitignored qa/findings/ledger.json).

- `<finding-id>` — <generic one-line description, no values>

Tests: <N> passing; tsc clean. Auto-merge was withheld per policy
(severity / touched-path exclusions) — review and merge manually.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
After delivery, update each finding: `status: "fixed"`, `fix_commit` = the MAIN-side cherry-picked hash (or branch hash for PR-bound), `fix_status` = `"merged"` or `"pr-open"`, `fix_note` = one line naming root cause + where the fix landed.

Run `npx vitest run` once more on main after cherry-picks (cherry-pick contexts can differ). Red ⇒ revert the cherry-picks (`git revert`), flip those findings back to `fix_status` absent + note, Pushover the failure.

## Step 5 — Deploy (skip in dry-run; only when ≥1 commit auto-merged)

```bash
source ~/.zshrc && npm run electron:deploy
```
(`APPLE_API_*` notarization vars live in `~/.zshrc`, not `.env.local`.) On failure: set `fix_status: "merged-awaiting-deploy"` on tonight's merged findings, Pushover, do NOT revert main — a packaging failure never rolls back a correct merge.

## Step 6 — Finalize (ALWAYS runs, even after upstream failures)

1. Write `qa/findings/fix-runs/$(date +%Y-%m-%d).md`:
   ```
   # QA fix run YYYY-MM-DD  (mode: nightly|interactive|dry-run)
   - dispositions: N auto / N needs-decision / N needs-repro / N skipped-stranded
   - fixed+merged: <finding-id> @ <hash> ...
   - fixed+PR: <finding-id> @ <hash> (PR #N) ...
   - failed attempts: <finding-id> (2 attempts, <one-line why>) ...
   - deploy: ok | failed | skipped
   ```
   This file is the chain's completeness signal — the wrapper alerts if the skill exits 0 without writing it.
2. Pushover summary: `source qa/lib/pushover.sh; qa_pushover "QA fixer YYYY-MM-DD" "<counts: merged+deployed / PR awaiting review / needs-your-call / stranded branches>"`.
3. Worktree: leave intact on any crash/failure (inspection); on a clean run leave it too (persistent by design) but `git -C "$WT" checkout main` so tomorrow's `checkout -B` is clean.
````

- [ ] **Step 2: Sanity-check the skill loads**

Run `bash -n` is N/A (markdown); instead verify frontmatter parses by listing skills or reading the file back for YAML validity (name matches directory, description single-line).

- [ ] **Step 3: Commit**

`feat(qa): /qa-fix-findings skill — classify, fix, gate, deliver (spec 2026-07-26)`

---

### Task 5: Chain block in `qa/nightly-deep-qa.sh`

**Files:**
- Modify: `qa/nightly-deep-qa.sh` (insert between the completeness guard at line ~148 and the final `echo`/`exit` at lines 150-151)

**Interfaces:**
- Consumes: `$STATUS`, `$RUN_LOG`, `pick_model()`, `notify_failure()` — all already defined above the insertion point; `fixer.enabled` from Task 3's config; the skill from Task 4.
- Produces: nightly invocation of `/qa-fix-findings` with its own completeness guard on `qa/findings/fix-runs/<date>.md`.

- [ ] **Step 1: Insert the chain block**

After the existing completeness-guard `fi` (line ~148), before `echo "=== Deep QA finished ..."`:

```bash
# --- Auto-fix chain (spec 2026-07-26) ------------------------------------------
# Runs ONLY after a verified-complete sweep (exit 0 AND run log present) and only
# when armed via deep-qa-config.json fixer.enabled. Own model probe + own
# completeness guard on the fix-run log (same exit-0-is-not-proof lesson as the
# sweep). Fixer failure never changes the sweep's exit status.
FIXER_ENABLED=$(python3 -c "import json;print(json.load(open('qa/deep-qa-config.json')).get('fixer',{}).get('enabled',False))" 2>/dev/null)
if [ "$STATUS" -eq 0 ] && [ -f "$RUN_LOG" ] && [ "$FIXER_ENABLED" = "True" ]; then
  echo "=== QA auto-fix chain starting $(date '+%H:%M:%S') ==="
  FIX_MODEL="$(pick_model)"
  if [ -z "$FIX_MODEL" ]; then
    notify_failure "fixer: no callable model — auto-fix chain skipped"
  else
    claude -p "/qa-fix-findings" --model "$FIX_MODEL"
    FIX_STATUS=$?
    [ "$FIX_STATUS" -ne 0 ] && notify_failure "/qa-fix-findings exited $FIX_STATUS (model $FIX_MODEL)"
    FIX_LOG="$SCRIPT_DIR/findings/fix-runs/$(date +%Y-%m-%d).md"
    if [ "$FIX_STATUS" -eq 0 ] && [ ! -f "$FIX_LOG" ]; then
      notify_failure "/qa-fix-findings exited 0 but wrote no fix-run log — fixer died before finalizing"
    fi
    echo "=== QA auto-fix chain finished (exit $FIX_STATUS) $(date '+%H:%M:%S') ==="
  fi
fi
```

Also create the log directory once: `mkdir -p qa/findings/fix-runs` (gitignored parent — nothing to commit there).

- [ ] **Step 2: Shell-parse gate**

```bash
bash -n qa/nightly-deep-qa.sh
```
Expected: clean. (bash-3.2 heredoc/apostrophe rule — the block above contains no heredocs and no apostrophes in single-quoted strings.)

- [ ] **Step 3: Disarmed smoke test**

```bash
python3 -c "import json;print(json.load(open('qa/deep-qa-config.json')).get('fixer',{}).get('enabled',False))"
```
Expected output: `False` — confirms the chain's gate reads the config and holds while disarmed.

- [ ] **Step 4: Commit**

`feat(qa): chain /qa-fix-findings after the deep sweep (disarmed via fixer.enabled)`

---

### Task 6: Dry-run audit against the live ledger

**Files:**
- Create (generated, gitignored): `qa/findings/DECISIONS-PENDING.md`, `qa/findings/fix-runs/<today>.md`
- Modify (generated, gitignored): `qa/findings/ledger.json` (dispositions only)

**Interfaces:**
- Consumes: Tasks 3-5 complete; the live ledger (~11 open findings after Tasks 1-2 land their fixes).
- Produces: a disposition table for user review — the judgment audit the spec requires before any supervised live run.

- [ ] **Step 1: Run the skill in dry-run, interactively**

In this session (not headless): `QA_FIX_DRY_RUN=1` context, invoke the `/qa-fix-findings` skill and execute Steps 0-1 + 6 only, against the real ledger.
Expected outputs: every open finding gets a `disposition`; `DECISIONS-PENDING.md` written with at least the 52wk-range and income-total findings (both flagged needs-decision in the spec); fix-run log written with `mode: dry-run`.

- [ ] **Step 2: Present the disposition table to the user**

Show: finding id → disposition → (for auto) the planned fix in one line → (for needs-decision) the options. The user corrects any misjudgment; corrections are applied to the ledger AND, if they reveal a classification-rule gap, folded back into SKILL.md Step 1 wording (commit the SKILL.md amendment).

- [ ] **Step 3: Record the milestone**

Do NOT arm `fixer.enabled` in this session. The arming criteria (spec): ≥2 supervised interactive runs. Add a line to `docs/plans/TODO.md` under Live watches: supervised `/qa-fix-findings` run #1 done (dry-run audit), run #2 = first live interactive fix run next session, then arm.

- [ ] **Step 4: Commit any SKILL.md amendments + TODO line**

`docs(qa): fixer dry-run audit follow-ups`

---

## Self-review notes

- Spec coverage: classification ✔ (T4 Step 1), anti-strand ✔ (T4 Step 0), merge gate + exclusions ✔ (T4 Step 4 + Hard rule 7), deploy ✔ (T4 Step 5), ledger contract ✔ (Hard rule 1, Step 4 writes), Pushover-everywhere ✔ (Hard rule 8, chain block), dry-run ✔ (T6), supervised-runs-before-arming ✔ (T6 Step 3, `enabled: false` default), pre-steps ✔ (T1, T2).
- The `fix-failures.sh` script already in `qa/` is unrelated legacy — not touched.
- Ports, bash-3.2, public-repo sanitization, temp-file commits: in Global Constraints.
