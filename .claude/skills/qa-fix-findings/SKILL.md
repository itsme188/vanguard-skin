---
name: qa-fix-findings
description: Turn open deep-QA ledger findings into shipped fixes — classify (auto / needs-decision / needs-repro), TDD-fix in a worktree under a per-night cap, auto-merge qualifying fixes to main, open a sanitized PR for the rest, then conditionally electron:deploy. Chained nightly after /qa-deep-sweep; also invocable interactively. QA_FIX_DRY_RUN=1 (or config fixer.dryRun) classifies and plans only, no code changes.
---

# QA Fix Findings

Spec: `docs/superpowers/specs/2026-07-26-qa-auto-fix-pipeline-design.md`. Ledger: `qa/findings/ledger.json`. Config: the `fixer` block of `qa/deep-qa-config.json`.

## Hard rules — read before anything else

1. **You may set `status: "fixed"` on a finding ONLY together with a `fix_commit` hash that exists on `main` or on tonight's `qa-auto-fixes-*` branch, and a `fixed_date` (YYYY-MM-DD, local date) — the existing ledger convention carries both together.** Never close a finding as non-reproducing — non-repro closure is exclusively the sweep's job. If you cannot reproduce, set `disposition: "needs-repro"` and move on.
2. **Never write code for a `needs-decision` finding.** Write 2–3 options + a recommendation into the ledger instead.
3. **Two fix attempts per finding, then stop** (global working rule). A resisting finding gets a ledger note describing both attempts and stays open.
4. **Public repo:** no dollar values, position sizes, screenshots, or ledger prose in commit messages, branch names, or PR bodies. Finding IDs + generic one-line descriptions only.
5. **Never touch the live `data/vanguard.db`.** Verification DBs come from `sqlite3 data/vanguard.db "VACUUM INTO '<worktree>/data/vanguard.db'"`.
6. **All code work happens in the worktree** (`../vanguard-skin-qa-fix`); the main checkout is used only for cherry-picks, merges, push, and deploy.
7. **Hard PR-only exclusions** regardless of severity: any fix touching `lib/db/migrations/`, any email send path (`lib/email.ts`, `lib/digest/`, `lib/calendar/briefing*`, `workers/cron/src/`), or any `lib/mutations/` data-write path goes to the PR, never auto-merge.
8. Every abort path must send a Pushover (`source qa/lib/pushover.sh; qa_pushover "QA fixer" "<what died>"`) — silence is the historically proven failure mode.
9. **Ledger-string hygiene:** never include the literal build keywords `electron:deploy` or `electron:pack` inside `fix_note` or any ledger/JSON string you write via a Bash heredoc. The TODO-reconciliation hook (see Step 5) substring-matches the raw Bash command text of every tool call — if a heredoc write happens to carry that literal string as *data*, the hook will false-positive and deny an unrelated file write. Write "Electron rebuild" instead whenever you need to refer to the deploy step in ledger prose.
10. **Hook compliance, not evasion:** if any PreToolUse hook denies a command (the TODO-reconciliation gate in Step 5 is the one you'll hit most), treat the denial as maintainer feedback, not an obstacle to route around. Either satisfy the hook's stated precondition (e.g. reconcile `docs/plans/TODO.md`) or record-and-skip that step with a Pushover explaining why. Never restructure, split, quote-obfuscate, or otherwise rewrite a command just to dodge a hook's detection — that defeats the point of having the hook and is treated as a policy violation, not a clever workaround.

## Step 0 — Preflight

1. Read the `fixer` config block. Dry-run mode = `QA_FIX_DRY_RUN=1` env OR `fixer.dryRun: true`.
2. **Anti-strand guard:** run `git branch --list 'qa-auto-fixes-*' --list 'qa-deep-fixes-*'` and both `gh pr list --state open --search "qa-auto-fixes"` and `gh pr list --state open --search "qa-deep-fixes"` from the main checkout. For every unmerged branch/PR: record it for the summary, and mark its findings SKIP for tonight (a fix already exists unmerged — re-fixing it forks the work). Identify covered findings by the `[qa:<finding-id>]` trailer in the branch's commit messages (`git log main..<branch> --format=%B`).
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
   VPORT=$(python3 -c "import json;print(json.load(open('qa/deep-qa-config.json')).get('fixer',{}).get('verifyPort',3096))")
   cd "$WT" && ANTHROPIC_API_KEY= RESEND_API_KEY= GMAIL_APP_PASSWORD= FINNHUB_API_KEY= \
     PUSHOVER_APP_TOKEN= PUSHOVER_USER_KEY= CRON_SHARED_SECRET= WORKER_MARKER_URL= \
     PORT=$VPORT npm run dev
   ```
   (Env keys pinned EMPTY the way `qa/sandbox.sh` pins its allowlist — verification must be unable to send real email/push or call paid APIs. The :3097 sandbox serves the *deployed* build and cannot verify new code.) The worktree has no `.env.local` (gitignored, never copied) — verification runs secret-less BY DESIGN; the empty-pinned keys above are defense-in-depth. **Never copy `.env.local` (or any secret file) into the worktree**, even if the dev server complains about missing keys — a feature that needs live keys to verify goes to the PR path with browser verification marked not-performed. Use agent-browser against `http://localhost:$VPORT` to confirm the specific ledger symptom is gone. Kill the dev server by PID afterwards.
3. **Suite gate per finding:** `npx vitest run` + `npx tsc --noEmit` in the worktree (plus `workers/cron` tests if `workers/` was touched). Red suite ⇒ revert the finding's changes (`git checkout -- .` of its files), record attempt, count it.
4. **Commit per finding** in the worktree (temp-file `-F` message):
   `fix(<area>): <generic one-line description> [qa:<finding-id>]` — the `[qa:...]` trailer is what the anti-strand guard greps for. No values from the ledger in the message.
5. **Checkpoint the ledger** after each finding (fix or failed attempt) before starting the next.

## Step 4 — Gate and deliver

Classify each successful fix commit:

**Auto-merge eligible** iff ALL of:
- `severity` ∈ config `autoMergeSeverities`, OR (the ledger note prescribed the exact fix you applied — named component + named change — AND the finding carries `auto_fixable: true` in the ledger);
- full suite green + tsc clean (already true from Step 3);
- browser verification (when applicable) confirmed the symptom gone;
- none of the Hard-rule-7 exclusion paths touched.

**Push policy — read before delivering:** auto-merged commits stay on LOCAL main. **The fixer NEVER runs `git push origin main`.** The user pushes at their next session (session-end convention already covers this repo). This is why the PR branch below cuts from `origin/main`, not local `main` — local `main` may already be carrying tonight's unpushed auto-merges, and a PR built off it would silently smuggle those commits into the PR diff.

Delivery from the MAIN checkout:
```bash
git fetch origin
# auto-merge set — lands on LOCAL main only; no push
git cherry-pick <hash>...            # each eligible commit, in order
# PR set (only if non-empty) — cut from origin/main, never local main
git checkout -b "qa-auto-fixes-$(date +%Y-%m-%d)" origin/main
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
**PR-bound cherry-pick conflicts because it depends on a tonight's-auto-merge commit that isn't on `origin/main` yet:** this is expected, not a bug — record-and-skip that finding. Leave its commit as-is on the worktree branch (untouched, still fixed there), do NOT set `status: "fixed"` on it tonight, add a ledger `note` explaining the dependency, and list it in the Step 6 fix-run log + Pushover as skipped-pending-push. The next interactive session — after the user has pushed local main — can cherry-pick it cleanly onto a fresh `origin/main`-based PR branch.

After delivery, update each finding: `status: "fixed"`, `fix_commit` = the MAIN-side cherry-picked hash (or branch hash for PR-bound), `fix_status` = `"merged"` or `"pr-open"`, `fix_note` = one line naming root cause + where the fix landed, `fixed_date` = today (YYYY-MM-DD).

Run `npx vitest run` once more on main after cherry-picks (cherry-pick contexts can differ). Red ⇒ revert the cherry-picks (`git revert`), flip those findings back to `fix_status` absent + note, Pushover the failure.

Before finishing this step, run `git log origin/main..main --oneline` — if non-empty, tonight leaves auto-merged commits on local main awaiting push. Carry that count into Step 6's fix-run log and Pushover summary.

## Step 5 — Deploy (skip in dry-run; only when ≥1 of tonight's cherry-picks still present on main after any reverts)

Count AFTER Step 4's post-cherry-pick revert handling, not before — a night that auto-merged 3 commits but reverted all 3 (Step 4's red-suite path) has zero surviving fixes and must skip deploy. Do not use `git log origin/main..main` for this count — that range also includes any *prior* night's still-unpushed commits, which are real but not tonight's work and don't gate tonight's deploy decision.

This repo has a PreToolUse hook (`.claude/hooks/check-todo-reconciled.sh`) that **denies** any Bash command whose text contains `electron:deploy` or `electron:pack` whenever commits exist after `docs/plans/TODO.md`'s last update — and tonight's auto-merge cherry-picks count as exactly that. Reconcile TODO.md BEFORE attempting to deploy, every time:

1. **Reconcile `docs/plans/TODO.md` first.** Append one dated line under the `## Bugs / Quality` section:
   ```
   - [x] **Nightly QA fixer YYYY-MM-DD** — auto-merged: <finding-id> @ <hash>, <finding-id> @ <hash> (generic descriptions only; TODO.md is public — no dollar values or positions)
   ```
   List every finding merged tonight (from Step 4), each with its short hash. Generic one-line descriptions only — same public-repo discipline as Hard rule 4.
2. **Commit that edit alone, as the LAST commit before deploy**, from the main checkout, temp-file `-F` message (e.g. `docs: reconcile TODO.md for nightly QA fixer merges`).
3. **Then** run:
   ```bash
   source ~/.zshrc && npm run electron:deploy
   ```
   (`APPLE_API_*` notarization vars live in `~/.zshrc`, not `.env.local`.)
4. **If the hook still denies the deploy command** (e.g. another commit landed after your TODO.md edit, or an edge case the hook's git-log check doesn't like): this is a real block, not a bug to route around — per Hard rule 10, do NOT restructure or re-word the deploy command to dodge the hook. Instead: set `fix_status: "merged-awaiting-deploy"` on tonight's merged findings, send a Pushover explaining the block, and skip deploy for tonight. A human can reconcile and deploy manually.
5. **On any OTHER deploy failure** (packaging/notarization, not the hook): set `fix_status: "merged-awaiting-deploy"` on tonight's merged findings, Pushover, do NOT revert main — a packaging failure never rolls back a correct merge.

## Step 6 — Finalize (ALWAYS runs, even after upstream failures)

1. Write `qa/findings/fix-runs/$(date +%Y-%m-%d).md`:
   ```
   # QA fix run YYYY-MM-DD  (mode: nightly|interactive|dry-run)
   - dispositions: N auto / N needs-decision / N needs-repro / N skipped-stranded
   - fixed+merged: <finding-id> @ <hash> ...
   - fixed+PR: <finding-id> @ <hash> (PR #N) ...
   - skipped-pending-push: <finding-id> (depends on unpushed auto-merge <hash>) ...
   - failed attempts: <finding-id> (2 attempts, <one-line why>) ...
   - deploy: ok | failed | skipped
   - push: N auto-merged commits on local main awaiting push
   ```
   This file is the chain's completeness signal — the wrapper alerts if the skill exits 0 without writing it. The `push:` line is REQUIRED whenever `git log origin/main..main --oneline` is non-empty (recall: auto-merged commits stay on LOCAL main — the fixer NEVER runs `git push origin main`; the user pushes at their next session, same as the session-end convention). Omit the line only when that range is empty.
2. Pushover summary: `source qa/lib/pushover.sh; qa_pushover "QA fixer YYYY-MM-DD" "<counts: merged+deployed / PR awaiting review / needs-your-call / stranded branches>"` — append `"N auto-merged commits on local main awaiting push"` to the message whenever step 1's `push:` line is non-zero, for the same reason.
3. Worktree: leave intact on any crash/failure (inspection); on a clean run leave it too (persistent by design) but `git -C "$WT" checkout main` so tomorrow's `checkout -B` is clean.
